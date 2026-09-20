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

## Usage notice

This is an experimental project for research and testing. It uses browser automation and is not affiliated with, endorsed by, or supported by OpenAI.

Use it at your own risk. Browser automation may conflict with third-party terms and policies and may result in account restrictions or suspension. You are responsible for reviewing and complying with the applicable [OpenAI terms and policies](https://openai.com/policies/) and those of any other services you use. A research or testing purpose does not exempt you from those requirements.

Selected source code, diffs, and prompts are sent to ChatGPT through your connected account. Review what you share and do not submit credentials, confidential information, or code you are not authorized to disclose.

The software is provided without warranty. To the maximum extent permitted by applicable law, the authors and contributors disclaim liability for account restrictions, suspensions, damages, or other consequences arising from its use. See [LICENSE](LICENSE) for the full warranty disclaimer and limitation of liability.

## License

This project is licensed under the [MIT License](LICENSE).
