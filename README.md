# chat-mcp

A local Codex plugin for code reviews, design comparisons, and debugging through your ChatGPT account in Chrome.

Review and analysis requests run in your signed-in ChatGPT web tab. The plugin collects selected files locally and returns the answer to Codex, so the delegated analysis uses ChatGPT web access while keeping that source context out of the coordinating Codex conversation. Browser UI changes can still require compatibility updates; the recovery state below makes those failures inspectable without duplicate sends.

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

You can also ask for a structure or readability review of existing code. `review_with_chatgpt` with `scope: working_tree` accepts file or folder `paths` and includes their current contents even without a diff. Without paths, it prefers changed files, or reviews current tracked files when there are no eligible changes. `staged` and `branch` remain limited to changes in those scopes.

Keep the connected ChatGPT tab open and your PC awake during requests. Requests activate that tab and restore its Chrome window if minimized. The bridge starts when needed; Chrome reconnects automatically after restarting. If you close the tab, click **Open ChatGPT** in the extension popup.

Opening another tab does not change the connection. Chrome's internal replacement of the connected tab is followed automatically. If either side of the local connection stops responding, it is retired after 60 seconds without replies so Chrome can reconnect; pending commands are not replayed.

## Reasoning level

Both `chatgpt_ask` and `review_with_chatgpt` accept `reasoning_effort`: `low`, `medium`, `high`, or `xhigh`. Choose by task difficulty: low for bounded simple checks, medium for ordinary analysis, high for substantial reviews or debugging, and xhigh for difficult architecture or ambiguous failures. On the supported ChatGPT UI, low maps to **Instant** (`none`) and xhigh to **Extra High** (`max`). Omission keeps the current verified non-Pro setting. The selected setting remains in the shared tab after the request.

Every request verifies the selected model and reasoning before sending. **Pro is never used**: Pro, unknown controls/models, or an unconfirmed requested setting stop the request before Send. Results include `requested_reasoning_effort` and `applied_reasoning` (effort, actual UI label and raw value); health exposes the observed reasoning. The current supported model entries are Latest, GPT-5.6 Sol, and GPT-5.5. An unsupported UI needs an adapter update rather than a silent fallback.

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

Requests automatically keep reading the existing response after a lost send acknowledgement or a temporary connection failure. New-chat preparation waits for the page to become ready, and response reading tolerates a page reload during generation. If recovery times out, call **`chatgpt_result` with the original request ID**. Original inputs are not needed and the prompt is never resent. Completed results are available even when the browser is offline. An active worker returns its current status immediately; recovery after interruption is limited to 30 seconds per call. To stop recovery, use `chatgpt_cancel` with that ID. Do not create replacement requests while one remains unresolved.

Requests are recorded before context collection or any browser preparation. A preparation failure remains available through `chatgpt_result`; replay returns that failure without sending. Start a new ID after fixing a confirmed pre-send failure. A crashed worker's lock is reclaimed automatically on the next operation; live workers retain exclusive ownership of the shared tab. Retrying an original tool call with the same ID and identical inputs is also supported. `NOT_FOUND` means no local record exists; it is not proof that an older server never sent the message.

Results distinguish `send_state` (`not_sent`, `unknown`, `confirmed`), `worker_active`, `answer_state`, and `answer_complete`. `last_observation` reports the browser's last observed generation/completion state and timestamp; it is not a live guarantee. Only `answer_complete: true` is a completed answer. Cancelled fragments remain partial even when they look like a review. `cancel_requested: true` alone does not confirm cancellation: if its acknowledgement is lost, retrieve or cancel the same ID again. Follow `next_action` and `conversation_reusable`; a cancelled or failed latest request cannot reuse an older completed handle.

If an owned response stalls without a Stop control, the extension reloads that conversation once to recover its state. Cancellation also recovers a missing Stop control by reloading and checking ownership again. Existing drafts are preserved. These repairs apply to the shared extension, including requests from other Codex tasks.

Large inputs are inserted as one escaped text fragment with hard line breaks, then read back exactly before sending. This avoids creating an editor paragraph for every source line. Collected context is limited to **47,900 UTF-8 bytes and 1,200 lines**, including file/diff wrappers. Larger context is rejected before touching the browser with `CONTEXT_TOO_LARGE`; narrow the selected paths. The line limit prevents thousands of short lines from freezing the editor despite fitting the byte limit. Inputs get up to 60 seconds for the editor to accept and send them. Preparation, sending, and response reading still share the request's five-minute limit.

Use `chatgpt_preview` before large requests to inspect `bytes`, `lines`, limits, `files`, and `omitted` without accessing Chrome or sending content. For an ask, pass `mode: ask`, `prompt`, and optional `repo_path`/`context_paths`; for a review, pass `mode: review`, `repo_path`, `scope`, and optional `paths`/`base_ref`/`question`. Preview recollects files and does not reserve them. Explicitly selected ignored paths in working-tree reviews are reported as omitted; supply individual files through `chatgpt_ask` only when intentionally needed. Credential and generated-file exclusions still apply.

`COMMAND_EXPIRED` means a delayed command was stopped before execution. Cancel its request to clear any unchanged draft it owns, then start a new request with a new ID. Keep Chrome visible and the PC awake. If a response remains stuck, preserve any draft, reload the connected tab, and retrieve the request with its original ID and inputs.

For development, `npm test` runs the full suite. `npm run test:stability` repeats the request recovery, worker crash, bridge restart, extension lifecycle, and offline Chrome DOM tests ten times. These simulated fault checks do not replace testing with a signed-in ChatGPT tab. After building, `node scripts/live-smoke.mjs --live --interrupt --bridge-restart` sends actual test prompts through the connected account and checks sequential requests, follow-ups, replay, large input, and recovery after terminating an active MCP worker and the local bridge. It saves a content-free result summary under `artifacts/`. Run it only when the shared ChatGPT tab is free. Set `CHAT_MCP_TEST_SERVER` to test an installed server bundle instead of `dist/main.js`.

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
