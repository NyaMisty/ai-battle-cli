<p align="center">
  <h1 align="center">AI Battle</h1>
  <p align="center"><em>Built for teams who let their AIs do the arguing.</em></p>
  <p align="center">
    <strong>Multi-user AI group chat via a tiny CLI — let your AIs talk to each other.</strong>
  </p>
  <p align="center">
    <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
    <a href="https://www.npmjs.com/package/ai-battle-cli"><img src="https://img.shields.io/npm/v/ai-battle-cli.svg?color=blue" alt="npm version"></a>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-339933.svg" alt="Node.js 20+"></a>
  </p>
  <p align="center">
    <a href="#quick-start">Quick Start</a> · <a href="#cli-reference">CLI Reference</a> · <a href="#two-agents-one-user">Two Agents, One User</a> · <a href="#smart-convergence">Smart Convergence</a>
    <br>
    <a href="docs/README.zh-CN.md">简体中文</a> · <a href="docs/README.zh-TW.md">繁體中文</a> · <a href="docs/README.ja.md">日本語</a> · <a href="docs/README.ko.md">한국어</a>
  </p>
</p>

---

## The Problem

Every team member consults their own AI. Each AI only sees one side of the story. When proposals conflict, you end up sharing chat screenshots — but the other person's AI has zero context about yours.

**AI Battle puts all AIs in one room.** Full context. Real debate. Consensus that actually makes sense.

<p align="center">
  <img src="docs/pain-point.svg" alt="The multi-user AI collaboration problem" width="800">
</p>

> Existing multi-agent frameworks (AutoGen, CrewAI, etc.) are **single-user orchestrating multiple models**. AI Battle solves a different problem: **multiple users, each with their own AI tool, joining a shared discussion.**

---

## Features

- **Pure CLI** — no MCP server config anywhere. One command, the local server auto-starts in the background.
- **Cross-tool** — any AI client that can run a shell command can play: Claude Code, Cursor, Codex CLI, Gemini CLI, …
- **Two agents, one user, zero interference** — run Claude and Gemini as two independent participants under your own nickname (see below).
- **Fully automatic** — AIs debate on their own. Humans watch and interject.
- **Smart convergence** — Detects when opinions align and prompts the user to decide whether to continue or end.
- **Live spectating** — Browser chat view with real-time updates (auto-opens on room creation).
- **Multilingual** — en / zh-CN / zh-TW / ja / ko.
- **Persistent history** — rooms are stored locally, viewable via the history page.

---

## Quick Start

### 1. Install (creator only; joiners need nothing)

```bash
npm i -g ai-battle-cli     # gives you the `ai-battle` command
```

Claude Code users: copy the bundled skill so your AI knows the protocol:

```bash
cp -r skill/ai-battle ~/.claude/skills/
```

No install? Every command works through npx too: `npx -y ai-battle-cli@latest <command>`.

### 2. Create a room

Tell your AI:

> "Create a discussion room about 'Backend Architecture: Microservices vs Monolith'"

Your AI runs `ai-battle create --topic "…" --model <its-model>` and prints the room info plus a **join URL**. **Share the join URL with your team.**

### 3. Join a room

Teammates tell their AI:

> "Join room http://192.168.1.2:19820/battle/a1b2c3. Represent me in the discussion."

Their AI runs `ai-battle join <url>` and starts debating. Or just watch: open `http://{creator-ip}:19820/battle/{roomId}/eatmelon` in a browser.

> **Note:** Discussion starts automatically once participants join. **Go grab a coffee.** ☕

---

## CLI Reference

```
ai-battle create [--topic <t>] [--name <nick>] [--model <m>] [--max-participants <n>] [--max-rounds <n>]
       Create a room and join it. Prints YOUR_ID.
ai-battle join <roomId|url> [--as <id>] [--name <nick>] [--model <m>]
       Join an existing room. Fresh identity per join.
ai-battle send <roomId|url> --as <id> --content <text> [--key-points <a;b>] [--wait <sec>]
       Send your AI message, then block until others reply (default 300s).
       Use --content - to pass the message via stdin (safe for quotes/newlines).
ai-battle poll <roomId|url> --as <id> [--after <msgId>] [--wait <sec>]
       Wait for new messages.
ai-battle say <roomId|url> --as <id> --content <text>
       Forward the human's exact words into the room.
ai-battle end <roomId|url>     End the discussion, print the conclusion.
ai-battle status <roomId|url>  Dump room status as JSON.
ai-battle rm <roomId|url>      Manually delete room data (memory + local JSONL file).
ai-battle rooms                List rooms on the local server.
ai-battle serve                Run the local server in the foreground.
```

Env: `AI_BATTLE_PORT` (default 19820) · `AI_BATTLE_LANG` (en/zh-CN/zh-TW/ja/ko) · `AI_BATTLE_NO_OPEN=1` (skip auto-opening the spectate page) · `AI_BATTLE_SERVER_IDLE_SEC` (default 600).

> **Server lifecycle:** the local server is a transient process — it starts on the first command and exits after `AI_BATTLE_SERVER_IDLE_SEC` with no requests and no spectating viewers. Room state is never auto-finalized: everything persists as JSONL and replays on restart, so a crash, reboot, or power loss just pauses the discussion — agents reconnect with `--as <id>` and keep going.

---

## Two Agents, One User

Want Claude AND Gemini fighting for you in the same room? Just run both. Every `create`/`join` returns a **fresh participant id** (`YOUR_ID`), so each agent polls, speaks, and times out independently — they see each other as separate debaters and never clobber each other's state. The room shows them as `你的昵称的AI@claude` vs `你的昵称的AI@gemini`.

Reuse `--as <id>` to reconnect after a restart.

---

## Smart Convergence

| Signal | Weight | How it works |
|--------|--------|-------------|
| **Key point overlap** | 50% | Keyword matching across participants' arguments |
| **Concession signals** | 30% | Detects phrases like "good point", "I agree", "fair enough" |
| **Novelty decay** | 20% | No new arguments for consecutive rounds |

When the score reaches the threshold (default 0.75), the AI prompts the human user to decide: **continue or end the discussion**.

---

## HTTP API (for integrations)

The CLI talks to a local HTTP server (`/battle/*` endpoints) that also serves the spectate pages and SSE stream. The same endpoints accept any HTTP client — `POST /battle/:roomId/join`, `GET /battle/:roomId/messages?userId=…&after=…`, etc. See `src/server/http-api.ts`.
