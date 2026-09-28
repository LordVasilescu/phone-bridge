# PhoneBridge — Drive a Coding Agent From Your Phone

PhoneBridge is a single-file, zero-dependency Node.js server that lets you control an AI coding
agent running on your PC from your phone's browser over home Wi-Fi. You type a request on your
phone; the PC runs the agent headlessly with full tool access in a chosen project folder and
streams progress back to a mobile-first chat UI.

The current version drives the **Grok Build** CLI; the original **Claude Code** version is kept
as `server.claude.legacy.js`.

## Features

- **LAN web app** — binds to `0.0.0.0` and prints every local IPv4 address at startup so you can
  open `http://<pc-ip>:8770` on your phone. The mobile UI (HTML/CSS/JS) is embedded in the server.
- **Access-key gate** — every API route except `/health` requires an `X-Key` header. The key comes
  from `BRIDGE_KEY` or is randomly generated into a local `.access-key` file on first run; the
  phone remembers it in `localStorage`.
- **Job queue** — requests become jobs processed one at a time; the phone polls `/job/:id` for
  live progress (text and reasoning), with a configurable timeout (default 20 minutes).
  A synchronous `/chat-sync` endpoint is also available.
- **Persistent sessions** — the agent's session ID is captured from its streaming JSON output and
  resumed on the next request; stale sessions are detected and cleared automatically.
  `/reset` starts a new conversation.
- **Headless agent runner** — spawns the CLI with streaming JSON output in the configured working
  directory and parses events incrementally.
- **Quick-action buttons** and a status panel (`/status`) in the UI.

## Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| GET    | `/`         | Mobile chat UI |
| GET    | `/health`   | Liveness check (no key) |
| GET    | `/status`   | Working directory, session, queue state |
| POST   | `/chat`     | Queue a job, returns job id |
| GET    | `/job/:id`  | Poll job progress/result |
| POST   | `/chat-sync`| Run a job and wait for the result |
| POST   | `/reset`    | Start a fresh agent session |

## Tech stack

Node.js (built-ins only: `http`, `child_process`, `crypto`, `os`), vanilla HTML/CSS/JS,
Grok Build CLI / Claude Code CLI (headless, streaming JSON).

## Setup

Prerequisites: Node.js 18+ and the agent CLI installed and signed in on the PC.

```bash
node server.js            # or double-click Start-PhoneBridge.bat on Windows
```

1. Note the access key and the `http://192.168.x.x:8770` URL printed in the terminal.
2. On a phone connected to the same Wi-Fi, open that URL and enter the key once.
3. Chat. Keep the PC awake and the terminal open.

Configuration is via environment variables (all optional) — see `.env.example`:
`BRIDGE_PORT`, `BRIDGE_HOST`, `BRIDGE_PROJECT` (agent working directory), `BRIDGE_BIBLE`,
`BRIDGE_KEY`, `GROK_PATH`, `BRIDGE_TIMEOUT_MS`.

## Security notes

- Intended for a **trusted home network only**. The agent runs with tool permissions
  auto-approved, so anyone holding the access key can make it edit files and run commands in
  the working directory.
- The server does not expose anything to the public internet by itself; do not port-forward it.

## License

© 2026 Mathew Vasilescu. All rights reserved. See [LICENSE](LICENSE).
