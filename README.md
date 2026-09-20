# chat-mcp

A Codex plugin that delegates code reviews and analysis to your ChatGPT account in Chrome.

## 1. Install

You need **Codex, Node.js 22+, Git, and Chrome 116+**, plus a ChatGPT account.

Open a terminal and run:

```sh
git clone https://github.com/phykn/chat-mcp.git
cd chat-mcp
npm run setup
```

Already downloaded? Run `npm run setup` inside the project folder.
Setup installs **Chat MCP**, its usage skill, and the Chrome extension files.

## 2. Connect Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the extension folder printed by setup.
3. ChatGPT opens and connects automatically. Sign in and select **Chat** if shown.

Keep this tab open for Codex. It reconnects automatically after restarting Chrome.
To update, run `git pull` and `npm run setup`. The connected extension updates automatically.

## 3. Use it

Start a new Codex task and say:

> Use Chat MCP to review my changes.

Codex can also use it automatically for larger reviews, design decisions, and debugging. Selected code is sent to ChatGPT.
