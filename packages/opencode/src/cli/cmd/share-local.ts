import { cmd } from "./cmd"
import { Session } from "@/session"
import { ShareLocal } from "@/share/share-local"
import { UI } from "@/cli/ui"
import { Instance } from "@/project/instance"
import path from "path"
import * as prompts from "@clack/prompts"
import { EOL } from "os"

export default cmd({
  command: "share-local [session]",
  describe: "Generate a local HTML share of a session without publishing online",
  builder(yargs) {
    return yargs
      .positional("session", {
        describe: "Session ID to share (defaults to current session)",
        type: "string",
        demandOption: false,
      })
      .option("open", {
        alias: "o",
        describe: "Open the generated HTML file in browser",
        type: "boolean",
        default: false,
      })
  },
  async handler(argv) {
    await Instance.provide({
      directory: process.cwd(),
      init: async () => {},
      fn: async () => {
        try {
          let sessionID = argv.session

          // If no session ID provided, try to get the current session
          if (!sessionID) {
            // This would typically get the active session from context
            // For now we'll need to handle this appropriately
            UI.error("No session ID provided and current session detection not implemented yet")
            process.exit(1)
          }

          // Verify session exists
          try {
            await Session.get(sessionID)
          } catch (error) {
            UI.error(`Session ${sessionID} not found`)
            process.exit(1)
          }

          // Generate the HTML file
          const htmlPath = await ShareLocal.generateHTML(sessionID)

          const shareID = ShareLocal.generateShareID(sessionID)
          const relativePath = path.relative(process.cwd(), htmlPath)

          prompts.outro(`Local share generated successfully!`, {
            output: process.stderr,
          })

          process.stdout.write(`Share ID: ${shareID}${EOL}`)
          process.stdout.write(`File: ${relativePath}${EOL}`)
          process.stdout.write(`Full path: ${htmlPath}${EOL}`)

          if (argv.open) {
            // TODO: Implement opening in browser
            prompts.log.warn("Opening in browser not yet implemented", {
              output: process.stderr,
            })
          }
        } catch (error) {
          UI.error(`Failed to generate local share: ${error instanceof Error ? error.message : String(error)}`)
          process.exit(1)
        }
      },
    })
  },
})
