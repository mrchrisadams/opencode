import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import type * as SDK from "@opencode-ai/sdk/v2"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import path from "path"
import { mkdir, writeFile } from "fs/promises"

export namespace ShareLocal {
  const log = Log.create({ service: "share-local" })

  type Data =
    | {
        type: "session"
        data: SDK.Session
      }
    | {
        type: "message"
        data: SDK.Message
      }
    | {
        type: "part"
        data: SDK.Part
      }
    | {
        type: "session_diff"
        data: SDK.FileDiff[]
      }
    | {
        type: "model"
        data: SDK.Model[]
      }

  /**
   * Collect all data for a session that would normally be synced to the remote share service
   * @param sessionID The session to collect data for
   * @returns Array of data objects containing session information
   */
  export async function collectData(sessionID: string): Promise<Data[]> {
    log.info("collecting data for local share", { sessionID })
    const session = await Session.get(sessionID)
    const diffs = await Session.diff(sessionID)
    const messages = await Array.fromAsync(MessageV2.stream(sessionID))
    const models = await Promise.all(
      messages
        .filter((m) => m.info.role === "user")
        .map((m) => (m.info as SDK.UserMessage).model)
        .map((m) => Provider.getModel(m.providerID, m.modelID).then((m) => m)),
    )

    return [
      {
        type: "session",
        data: session,
      },
      ...messages.map((x) => ({
        type: "message" as const,
        data: x.info,
      })),
      ...messages.flatMap((x) => x.parts.map((y) => ({ type: "part" as const, data: y }))),
      {
        type: "session_diff",
        data: diffs,
      },
      {
        type: "model",
        data: models,
      },
    ]
  }

  /**
   * Generate a share ID using the same logic as the remote share service
   * @param sessionID The session ID to generate a share ID for
   * @returns The generated share ID
   */
  export function generateShareID(sessionID: string): string {
    const isTest = process.env.NODE_ENV === "test" || sessionID.startsWith("test_")
    return (isTest ? "test_" : "") + sessionID.slice(-8)
  }

  /**
   * Generate HTML file for local sharing
   * @param sessionID The session to generate HTML for
   * @returns Path to the generated HTML file
   */
  export async function generateHTML(sessionID: string): Promise<string> {
    const data = await collectData(sessionID)
    const shareID = generateShareID(sessionID)

    // Create shares directory if it doesn't exist
    const sharesDir = path.join(Instance.directory, ".opencode", "shares")
    await mkdir(sharesDir, { recursive: true })

    // Generate HTML content
    const htmlContent = generateHTMLContent(shareID, data)

    // Write HTML file
    const htmlPath = path.join(sharesDir, `${shareID}.html`)
    await writeFile(htmlPath, htmlContent)

    log.info("generated local share HTML", { path: htmlPath, shareID })
    return htmlPath
  }

  /**
   * Generate HTML content with embedded data
   * @param shareID The share ID
   * @param data The data to embed in the HTML
   * @returns HTML content as string
   */
  function generateHTMLContent(shareID: string, data: Data[]): string {
    // Simple HTML template - in a real implementation this would be more sophisticated
    // and include the actual CSS and JavaScript from the web component
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>OpenCode Share - ${shareID}</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        .container { max-width: 800px; margin: 0 auto; padding: 20px; }
        .header { border-bottom: 1px solid #eee; padding-bottom: 20px; margin-bottom: 20px; }
        .content { display: flex; flex-direction: column; gap: 10px; }
        .message { background: #f5f5f5; padding: 10px; border-radius: 4px; margin-bottom: 10px; }
        .part { margin: 5px 0; padding: 5px; background: #fff; border-left: 3px solid #007acc; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>OpenCode Share</h1>
            <p>Share ID: ${shareID}</p>
        </div>
        <div class="content">
            <div id="data-container"></div>
        </div>
    </div>
    <script>
        // Embed the data in the HTML
        const shareData = ${JSON.stringify(data)};
        
        // Simple rendering of the data
        const container = document.getElementById('data-container');
        shareData.forEach(item => {
            const div = document.createElement('div');
            div.className = 'message';
            
            if (item.type === 'session') {
                div.innerHTML = '<h3>Session: ' + (item.data.title || 'Untitled') + '</h3>';
            } else if (item.type === 'message') {
                div.innerHTML = '<h4>Message (' + item.data.role + ')</h4><pre>' + JSON.stringify(item.data, null, 2) + '</pre>';
            } else if (item.type === 'part') {
                div.innerHTML = '<div class="part"><strong>Part (' + item.data.type + ')</strong><pre>' + JSON.stringify(item.data, null, 2) + '</pre></div>';
            } else {
                div.innerHTML = '<h4>' + item.type + '</h4><pre>' + JSON.stringify(item.data, null, 2) + '</pre>';
            }
            
            container.appendChild(div);
        });
    </script>
</body>
</html>`
  }
}
