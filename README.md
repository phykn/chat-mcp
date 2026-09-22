# chat-mcp

A local Codex plugin for code reviews and analysis through your ChatGPT account in Chrome.

## 1. Install

Requires **Codex, Node.js 22+, Git, Chrome 116+**, and a ChatGPT account.

```sh
git clone https://github.com/phykn/chat-mcp.git
cd chat-mcp
npm run setup
```

Setup registers the local Codex plugin with its MCP tools and usage skill, and prepares the Chrome extension.

### Add the GitHub marketplace

In Codex's **Add plugin marketplace** dialog, use:

| Field | Value |
| --- | --- |
| Source | `https://github.com/phykn/chat-mcp` |
| Git ref | `main` |
| Sparse paths | Leave empty |

The catalog is `.agents/plugins/marketplace.json`, and the plugin lives at the repository root. There is no `plugins/codex` directory. Sparse paths filter the checkout; they do not change the marketplace root. See the [Codex marketplace documentation](https://developers.openai.com/plugins/build/plugins#marketplace-metadata).

Adding the marketplace makes the plugin discoverable; it does not build the MCP server or prepare the Chrome extension. Git checkouts do not include `dist/plugin/main.js`. Use `npm run setup` above for a working local installation. Repository changes must reach the selected Git ref before the GitHub marketplace can use them.

## 2. Connect Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the extension folder printed by setup.
3. ChatGPT opens and connects automatically. Sign in and select **Chat** if shown.

Keep the connected tab open. It reconnects after Chrome restarts.
While waiting for a response, Chat MCP selects this tab so ChatGPT can finish rendering.
Keep Chrome visible and the PC awake while requests run. After a screen lock or sleep, restore the screen and retry the same request to retrieve its answer.

## 3. Use it

Start a new Codex task and say:

> Use Chat MCP to review my changes.

Codex can also invoke it automatically during development tasks.

## Update

Run `git pull` and `npm run setup` in the project folder, then start a new Codex task. The connected extension updates automatically.

## Usage notice

For individual development workflows, not bulk collection or multi-user service hosting. This project is not affiliated with OpenAI.

Browser automation may conflict with service terms and lead to account restrictions or suspension. You are responsible for complying with applicable [terms and policies](https://openai.com/policies/), including for personal use.

Selected code, diffs, and prompts are sent to ChatGPT. Only share content you are authorized to disclose; exclude credentials and confidential information.

## License

[MIT](LICENSE). Provided without warranty; see the license for limitations of liability.
