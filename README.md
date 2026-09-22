# chat-mcp

A local Codex plugin for code reviews, design comparisons, and debugging through your ChatGPT account in Chrome.

## Install

Requires **Codex, Node.js 22+ (with npm), Git, Chrome 116+**, and a ChatGPT account.

```sh
git clone https://github.com/phykn/chat-mcp.git
cd chat-mcp
npm run setup
```

Setup installs dependencies, builds and registers the plugin, prepares the Chrome extension, and checks the connection. It prepares the Codex CLI if needed. No separate marketplace registration is required.

### Connect Chrome once

Setup opens Chrome's extension settings and the prepared extension folder in an interactive terminal. If needed, open `chrome://extensions` manually.

1. Enable **Developer mode** and click **Load unpacked**.
2. Select **the exact folder printed by setup**. Paste the path into the folder picker’s address bar on Windows, or use **Cmd+Shift+G** on macOS.
3. Sign in to the ChatGPT tab that opens. Select **Chat** if prompted.
4. Return to the terminal and press **Enter** to verify the connection.

The default folder is `.chat-mcp/extension` under your home directory. **Do not select the repository's `extension` folder or a `manifest.json` file.** The prepared folder contains the generated configuration.

To finish later, enter `q`, then run `npm run doctor` when ready.

## Use

Open a **new Codex task** after installation and ask:

> Check my Chat MCP connection.

Then:

> Use Chat MCP to review my changes.

Keep the connected ChatGPT tab open, Chrome visible, and your PC awake during requests. The bridge starts when needed; Chrome reconnects automatically after restarting. If you close the tab, click **Open ChatGPT** in the extension popup.

## Update

From the repository folder:

```sh
git pull --ff-only
npm run setup
```

Setup preserves pairing and updates the plugin and connected extension. Open a new Codex task afterward.

## Troubleshoot

```sh
npm run doctor
```

Checks plugin activation, extension files, MCP startup, and ChatGPT readiness without sending a chat request. Follow the reported next step.

Requests automatically keep reading the existing response after a lost send acknowledgement or a temporary connection failure. New-chat preparation waits for the page to become ready, and response reading tolerates a page reload during generation. If recovery times out, retry with the **same request ID and identical inputs**; it will not send the prompt again. To stop recovery, use `chatgpt_cancel` with that ID. Do not create replacement requests while one remains unresolved.

Large inputs get up to 60 seconds for the editor to accept and send them. Preparation, sending, and response reading still share the request's five-minute limit.

`COMMAND_EXPIRED` means a delayed command was stopped before execution. Cancel its request to clear any unchanged draft it owns, then start a new request with a new ID. Keep Chrome visible and the PC awake. If a response remains stuck, preserve any draft, reload the connected tab, and retrieve the request with its original ID and inputs.

For development, `npm test` runs the full suite. `npm run test:stability` repeats the request recovery, bridge restart, extension lifecycle, and offline Chrome DOM tests ten times. These simulated fault checks do not replace testing with a signed-in ChatGPT tab.

| Issue | Fix |
| --- | --- |
| `npm` or `git` not found | Install Node.js or Git, then reopen your terminal. |
| PowerShell blocks `npm.ps1` | Use `npm.cmd run setup` or `npm.cmd run doctor`. |
| Extension fails to load | Rerun setup and select its printed folder, not the repository's `extension` folder. |
| Waiting for a connection | Click **Open ChatGPT** in the extension, sign in, then run doctor. |
| Tools missing in Codex | Enable Chat MCP and open a new task. |

Already added the GitHub marketplace? Run setup to prepare the runtime and extension. If you also installed the GitHub plugin, enable only the local plugin printed by setup (normally `chat-mcp@personal`).

For marketplace registration, use `https://github.com/phykn/chat-mcp`, ref `main`, and leave **Sparse paths empty**. Registration alone does not prepare a working installation.

For unattended setup, use `npm run setup -- --non-interactive`. It skips windows and prompts. Run `npm run doctor` to check readiness: exit code `0` means ready; `1` means action is needed.

## Usage notice

For individual development workflows, not bulk collection or multi-user hosting. This project is not affiliated with OpenAI.

Browser automation may conflict with [service terms](https://openai.com/policies/) and lead to account restrictions. Only send code and prompts you are authorized to share; exclude credentials and confidential information.

## License

[MIT](LICENSE). Provided without warranty.
