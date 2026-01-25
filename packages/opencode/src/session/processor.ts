import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3

  // Energy estimation constants
  // Energy coefficients (kWh per 1M tokens) - based on model size estimates
  const MODEL_ENERGY_COEFFICIENTS: Record<string, { input: number; output: number }> = {
    // Anthropic
    "claude-3-opus": { input: 0.0004, output: 0.0008 },
    "claude-3-5-sonnet": { input: 0.0002, output: 0.0004 },
    "claude-3-sonnet": { input: 0.0002, output: 0.0004 },
    "claude-3-haiku": { input: 0.00005, output: 0.0001 },
    "claude-3-5-haiku": { input: 0.00005, output: 0.0001 },
    // OpenAI
    "gpt-4o": { input: 0.0003, output: 0.0006 },
    "gpt-4o-mini": { input: 0.0001, output: 0.0002 },
    "gpt-4-turbo": { input: 0.00025, output: 0.0005 },
    "o1": { input: 0.0004, output: 0.0008 },
    // Google
    "gemini-1.5-pro": { input: 0.00025, output: 0.0005 },
    "gemini-1.5-flash": { input: 0.0001, output: 0.0002 },
    // Default
    default: { input: 0.0002, output: 0.0004 },
  }

  const DEFAULT_GRID_INTENSITY = 436 // gCO2e/kWh global average
  const DEFAULT_PUE = 1.1 // Power Usage Effectiveness

  function getModelCoefficients(modelID: string): { input: number; output: number } {
    const lower = modelID.toLowerCase()
    for (const [key, value] of Object.entries(MODEL_ENERGY_COEFFICIENTS)) {
      if (key !== "default" && lower.includes(key)) {
        return value
      }
    }
    return MODEL_ENERGY_COEFFICIENTS.default
  }

  function estimateEnergy(
    tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } },
    modelID: string,
  ): MessageV2.Energy {
    const coefficients = getModelCoefficients(modelID)

    // Input tokens + cache writes cost similar energy
    const inputTokens = tokens.input + tokens.cache.write
    // Output tokens + reasoning tokens
    const outputTokens = tokens.output + tokens.reasoning
    // Cache reads are much cheaper (~10% of normal)
    const cacheReadTokens = tokens.cache.read

    const inputKwh = (inputTokens / 1_000_000) * coefficients.input
    const outputKwh = (outputTokens / 1_000_000) * coefficients.output
    const cacheReadKwh = (cacheReadTokens / 1_000_000) * coefficients.input * 0.1

    const totalKwh = (inputKwh + outputKwh + cacheReadKwh) * DEFAULT_PUE
    const gCO2e = totalKwh * DEFAULT_GRID_INTENSITY

    return {
      wh: totalKwh * 1000,
      kwh: totalKwh,
      joules: totalKwh * 3_600_000,
      gCO2e,
      source: "estimated",
      provider: "opencode",
      method: `model_coefficients_pue_${DEFAULT_PUE}`,
      gridIntensity: {
        value: DEFAULT_GRID_INTENSITY,
        region: "global",
        source: "static",
      },
    }
  }

  function normalizeProviderEnergy(providerEnergy: Record<string, unknown> | undefined): MessageV2.Energy | undefined {
    if (!providerEnergy) return undefined

    return {
      wh: typeof providerEnergy.wh === "number" ? providerEnergy.wh : undefined,
      kwh: typeof providerEnergy.kwh === "number" ? providerEnergy.kwh : undefined,
      joules: typeof providerEnergy.joules === "number" ? providerEnergy.joules : undefined,
      gCO2e: typeof providerEnergy.gCO2e === "number" ? providerEnergy.gCO2e : undefined,
      source: "measured",
      provider: typeof providerEnergy.provider === "string" ? providerEnergy.provider : undefined,
      raw: providerEnergy,
    }
  }
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            const stream = await LLM.stream(streamInput)

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens

                  // Energy tracking: capture measured or estimate
                  let stepEnergy: MessageV2.Energy | undefined

                  // Check if provider sent measured energy data
                  const providerEnergy = value.providerMetadata?.energy as Record<string, unknown> | undefined
                  if (providerEnergy) {
                    stepEnergy = normalizeProviderEnergy(providerEnergy)
                  }

                  // If no measured energy, let plugins provide custom estimates
                  if (!stepEnergy) {
                    const estimateResult = await Plugin.trigger(
                      "message.energy.estimate",
                      {
                        sessionID: input.assistantMessage.sessionID,
                        messageID: input.assistantMessage.id,
                        modelID: input.model.id,
                        providerID: input.model.providerID,
                        tokens: usage.tokens,
                      },
                      { energy: undefined },
                    )
                    if (estimateResult.energy) {
                      stepEnergy = estimateResult.energy as MessageV2.Energy
                    }
                  }

                  // Fall back to built-in estimation
                  if (!stepEnergy) {
                    stepEnergy = estimateEnergy(usage.tokens, input.model.id)
                  }

                  // Let plugins enhance the energy data (e.g., add real-time grid intensity)
                  if (stepEnergy) {
                    const energyResult = await Plugin.trigger(
                      "message.energy",
                      {
                        sessionID: input.assistantMessage.sessionID,
                        messageID: input.assistantMessage.id,
                        modelID: input.model.id,
                        providerID: input.model.providerID,
                        tokens: usage.tokens,
                      },
                      { energy: stepEnergy },
                    )
                    stepEnergy = energyResult.energy as MessageV2.Energy
                  }

                  // Aggregate energy to message level
                  if (stepEnergy) {
                    if (!input.assistantMessage.energy) {
                      input.assistantMessage.energy = {
                        wh: 0,
                        kwh: 0,
                        joules: 0,
                        gCO2e: 0,
                        source: stepEnergy.source,
                        provider: stepEnergy.provider,
                      }
                    }
                    input.assistantMessage.energy.wh = (input.assistantMessage.energy.wh || 0) + (stepEnergy.wh || 0)
                    input.assistantMessage.energy.kwh = (input.assistantMessage.energy.kwh || 0) + (stepEnergy.kwh || 0)
                    input.assistantMessage.energy.joules =
                      (input.assistantMessage.energy.joules || 0) + (stepEnergy.joules || 0)
                    input.assistantMessage.energy.gCO2e =
                      (input.assistantMessage.energy.gCO2e || 0) + (stepEnergy.gCO2e || 0)
                    // If any step was estimated, mark the whole message as estimated
                    if (stepEnergy.source === "estimated") {
                      input.assistantMessage.energy.source = "estimated"
                    }
                  }

                  const stepFinishPartId = Identifier.ascending("part")
                  await Session.updatePart({
                    id: stepFinishPartId,
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                    energy: stepEnergy,
                  })
                  await Session.updateMessage(input.assistantMessage)

                  // Publish energy event for plugins
                  if (stepEnergy) {
                    Bus.publish(MessageV2.Event.EnergyUpdated, {
                      sessionID: input.assistantMessage.sessionID,
                      messageID: input.assistantMessage.id,
                      partID: stepFinishPartId,
                      energy: stepEnergy,
                      context: {
                        modelID: input.model.id,
                        providerID: input.model.providerID,
                        tokens: {
                          input: usage.tokens.input,
                          output: usage.tokens.output,
                          reasoning: usage.tokens.reasoning,
                        },
                      },
                    })
                  }
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (blocked) return "stop"
          if (input.assistantMessage.error) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
