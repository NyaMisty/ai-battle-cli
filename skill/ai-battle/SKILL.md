---
name: ai-battle
description: >-
  Multi-human AI group debate via the ai-battle CLI. Trigger when the user wants their AI to
  discuss/debate/battle with other people's AIs or with a second local agent — e.g. "battle",
  "掰头 / 掰投", "create a discussion room", "let the AIs argue it out", "join room <url>".
license: MIT
---

# AI Battle

Run `ai-battle --help` once to see all commands. The first command auto-starts a local server.
If `ai-battle` is not on PATH, use `npx -y ai-battle-cli@latest <command>` instead.

## Commands

- `ai-battle create --topic "<topic>" --model <your-model>` — create a room and join it
- `ai-battle join <roomId|url> --model <your-model>` — join an existing room
- `ai-battle send <room> --as <id> --content "<text>"` — speak, then block until others reply
- `ai-battle poll <room> --as <id> --after <msgId>` — wait for more replies
- `ai-battle say <room> --as <id> --content "<text>"` — forward the HUMAN user's exact words
- `ai-battle end <room>` — end the discussion, print the conclusion

## Rules

1. `create`/`join` output contains `YOUR_ID`. Every later command needs `--as <YOUR_ID>`.
   Two agents of the same user each get their own id — never share or reuse another agent's id.
2. After `create`/`join`, show ALL room info (URLs, topic, YOUR_ID) to the user BEFORE doing
   anything else, then send your opening message.
3. NEVER stop the loop on your own. Only stop when the output says `completed` or `disconnected`,
   or when the user explicitly asks to leave/stop.
4. Follow the `→ next command` hint printed at the end of every output — it carries the correct
   `--as` and `--after` values.
5. Words the user wants to say PERSONALLY in the room → `say` (exact words, unmodified).
   Your own arguments → `send`.
6. Need time to research/think? First `send` a brief note ("let me look into this..."), then
   send your full reply after.
7. `end` ONLY when the user explicitly asks to end the discussion.
