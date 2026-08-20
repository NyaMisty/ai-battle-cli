#!/usr/bin/env node
// ============================================================
// AI Battle — 纯 CLI 客户端 + 本地常驻 server
//
// 用法：ai-battle <create|join|send|poll|say|end|status|rooms|serve>
// 首次调用任意命令时自动在后台拉起 HTTP server（serve 为前台运行）。
// ============================================================

import http from "node:http";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import axios from "axios";
import open from "open";
import { RoomManager } from "./core/room-manager.js";
import { Storage } from "./core/storage.js";
import { ChatEngine } from "./core/chat-engine.js";
import { NotFoundError } from "./core/errors.js";
import { KeyPointConvergenceDetector } from "./core/convergence.js";
import { DefaultConclusionGenerator } from "./core/conclusion.js";
import type { BattleEvent } from "./core/types.js";
import { t } from "./core/i18n.js";
import { createHttpApi } from "./server/http-api.js";
import { SpectateServer } from "./server/ws-server.js";

const PORT = parseInt(process.env.AI_BATTLE_PORT ?? "19820", 10);
const LOCAL_ORIGIN = `http://localhost:${PORT}`;
const LOCAL_BASE = `${LOCAL_ORIGIN}/battle`;
const LOG_FILE = process.env.AI_BATTLE_LOG ?? path.join(os.tmpdir(), "ai-battle.log");

const POLL_INTERVAL = 5000; // 轮询间隔 5 秒
const DEFAULT_WAIT = 300; // 默认最多等 5 分钟

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  process.stderr.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch {}
}

process.on("uncaughtException", (err) => {
  log(`FATAL: ${err.stack ?? err.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  log(`FATAL: ${reason}`);
});

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
  return "localhost";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** AI_BATTLE_NO_OPEN=1 时不自动打开观战页面（无头/测试环境） */
function openSpectate(url: string): void {
  if (process.env.AI_BATTLE_NO_OPEN) return;
  open(url).catch(() => {});
}

/** HTTP 请求：POST/GET 到指定 URL，自动解包 { code, data } 响应 */
async function post(url: string, body?: Record<string, unknown>): Promise<any> {
  const { data } = await axios.post(url, body);
  return data?.data ?? data;
}

async function get(url: string): Promise<any> {
  const { data } = await axios.get(url);
  return data?.data ?? data;
}

/** 从 axios 错误中提取消息 */
function errMsg(e: any): string {
  return e?.response?.data?.message ?? e?.message ?? String(e);
}

/** 房间参数：纯 roomId 走本机；完整 URL 则取其 host（支持加入远程房间）。base 不含 /battle 前缀 */
function parseRoomRef(arg: string): { base: string; roomId: string } {
  if (/^https?:\/\//i.test(arg)) {
    const u = new URL(arg);
    const m = u.pathname.match(/battle\/([A-Za-z0-9]+)/);
    return { base: `${u.protocol}//${u.host}`, roomId: m?.[1] ?? u.pathname.replace(/\//g, "") };
  }
  return { base: LOCAL_ORIGIN, roomId: arg };
}

// ============================================================
// Server（serve 命令 / 后台自动拉起）
// ============================================================

async function isServerUp(): Promise<boolean> {
  try {
    await axios.get(`${LOCAL_BASE}/health`, { timeout: 1000 });
    return true;
  } catch (e: any) {
    if (e?.response) return true;
    return false;
  }
}

async function startServer(): Promise<void> {
  if (await isServerUp()) {
    console.error(`AI Battle server already running on port ${PORT}`);
    return;
  }

  log("Starting HTTP server...");

  let storage: Storage | undefined;
  try {
    storage = new Storage();
  } catch { storage = undefined; }

  const roomManager = new RoomManager(storage);
  roomManager.loadFromStorage();

  const chatEngine = new ChatEngine({
    roomManager, storage,
    convergenceDetector: new KeyPointConvergenceDetector(),
    conclusionGenerator: new DefaultConclusionGenerator(),
  });

  let spectateServer: SpectateServer | null = null;

  const localCtx = {
    createRoom: (input: any) => {
      const result = roomManager.createRoom(input);
      const host = getLocalIP();
      return {
        ...result,
        joinUrl: `http://${host}:${PORT}/battle/${result.roomId}`,
        spectateUrl: `http://${host}:${PORT}/battle/${result.roomId}/eatmelon`,
      };
    },
    joinRoom: (input: any) => {
      const baseName = roomManager.resolveNickname(input.participantName);
      const result = roomManager.joinRoom({ ...input, participantName: baseName });
      const displayName = input.modelName ? `${baseName}@${input.modelName}` : baseName;
      spectateServer?.broadcastToRoom(input.roomId, {
        type: "participant_joined",
        participant: { id: result.userId, name: displayName },
      });
      return result;
    },
    sendMessage: (input: any) => chatEngine.submitMessage(input),
    getStatus: (input: { roomId: string }) => {
      let room = roomManager.getRoom(input.roomId);
      // 内存没有则从 storage 回放（已完成的房间）
      if (!room && storage) {
        const all = storage.loadAllRooms();
        room = all.get(input.roomId);
      }
      if (!room) throw new NotFoundError();
      return {
        status: room.status, topic: room.topic,
        round: room.currentRound, convergenceScore: room.convergenceScore, createdAt: room.createdAt,
        participants: Array.from(room.participants.values()).map(p => ({ id: p.id, name: p.name })),
        messages: room.messages,
      };
    },
    poll: (input: { roomId: string; userId: string; after?: string }) =>
      chatEngine.getPollData(input.roomId, input.userId, input.after),
    spectate: (input: { roomId: string; after?: string }) =>
      chatEngine.getSpectateData(input.roomId, input.after),
    addInterjection: (roomId: string, userId: string, content: string) =>
      chatEngine.addInterjection(roomId, userId, content),
    endRoom: (roomId: string) => chatEngine.endRoom(roomId),
    listRooms: () => {
      // 内存中的活跃房间 + storage 中的历史房间
      const all = new Map<string, any>();
      if (storage) {
        for (const [id, room] of storage.loadAllRooms()) {
          all.set(id, room);
        }
      }
      for (const room of roomManager.getAllRooms()) {
        all.set(room.id, room); // 内存里的覆盖 storage 的（更新）
      }
      return Array.from(all.values()).map((r: any) => {
        const participants = r.participants instanceof Map ? Array.from(r.participants.values()) : [];
        const msgs = Array.isArray(r.messages) ? r.messages : [];
        const speechCount = msgs.filter((m: any) => m.type === "speech").length;
        const lastActive = participants.length > 0
          ? Math.max(...participants.map((p: any) => p.lastActiveAt ?? p.joinedAt ?? 0))
          : r.completedAt ?? r.createdAt;
        return {
          id: r.id, topic: r.topic, status: r.status,
          participants: participants.length,
          messages: speechCount,
          createdAt: r.createdAt, completedAt: r.completedAt,
          lastActiveAt: lastActive,
        };
      });
    },
    onEvent: (callback: (roomId: string, event: BattleEvent) => void) => {
      chatEngine.onEvent(callback);
      // 返回取消函数：从 eventListeners 中移除
      return () => chatEngine.removeEventListener(callback);
    },
  };

  const app = createHttpApi(localCtx);
  const httpServer = http.createServer(app.callback());

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(PORT, () => {
      spectateServer = new SpectateServer(httpServer, localCtx.getStatus);
      chatEngine.onEvent((roomId, event) => {
        spectateServer?.broadcastToRoom(roomId, event);
      });
      log(`HTTP server started: http://${getLocalIP()}:${PORT}/battle/`);
      resolve();
    });
    httpServer.on("error", reject);
  }).catch((err: Error) => {
    console.error(`Failed to listen on port ${PORT}: ${err.message}`);
    process.exit(1);
  });
}

/** CLI 用：确保本机 server 已在运行（没有则后台拉起一个） */
async function ensureServerUp(): Promise<void> {
  if (await isServerUp()) return;

  const self = fileURLToPath(import.meta.url);
  log(`Spawning background server: ${self} serve`);
  try {
    const child = spawn(process.execPath, [...process.execArgv, self, "serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    // 拉起失败也可能是别的进程刚好启动完成，继续等健康检查
    log(`Spawn failed: ${e}`);
  }

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await isServerUp()) return;
    await sleep(300);
  }
  throw new Error(`server failed to start on port ${PORT} (see ${LOG_FILE})`);
}

/** 远程房间直接连，本机房间才需要本地 server */
async function ensureRefServer(base: string): Promise<void> {
  if (base === LOCAL_ORIGIN) await ensureServerUp();
}

// ============================================================
// 共享输出逻辑
// ============================================================

interface WaitResult {
  msgs: any[];
  lastId?: string;
  completed: boolean;
  kicked: boolean;
  conclusion?: string;
}

/** 只保留别人的发言/插话（过滤自己的消息和系统提示） */
function othersMsgs(allMsgs: any[], pid: string): any[] {
  return allMsgs.filter((m: any) => m.sender?.userId !== pid && m.type !== "system");
}

/** 短阻塞等回复：直到别人发消息 / 房间结束 / 被踢 / 超时（waitSec=0 时只拉取一次） */
async function waitForReplies(
  base: string, roomId: string, pid: string,
  afterId?: string, waitSec = DEFAULT_WAIT,
): Promise<WaitResult> {
  const deadline = Date.now() + waitSec * 1000;
  let cursor = afterId;

  for (;;) {
    let result: any;
    try {
      const query = new URLSearchParams({ userId: pid });
      if (cursor) query.set("after", cursor);
      result = await get(`${base}/battle/${roomId}/messages?${query}`);
    } catch {
      // HTTP 错误（房间不存在、被踢等）→ 停止轮询
      return { msgs: [], lastId: cursor, completed: false, kicked: true };
    }

    const allMsgs = result.messages ?? [];
    if (allMsgs.length > 0) cursor = allMsgs[allMsgs.length - 1].id;

    if (result.roomStatus === "completed" || result.roomStatus === "closed") {
      const msgs = othersMsgs(allMsgs, pid);
      return { msgs, lastId: cursor, completed: true, kicked: false, conclusion: result.conclusion };
    }

    // yourTurn=false 且参与者不在列表里 → 被踢了
    if (!result.yourTurn) {
      return { msgs: [], lastId: cursor, completed: false, kicked: true };
    }

    const newMsgs = othersMsgs(allMsgs, pid);
    if (newMsgs.length > 0) {
      return { msgs: newMsgs, lastId: cursor, completed: false, kicked: false };
    }

    if (Date.now() + POLL_INTERVAL > deadline) {
      return { msgs: [], lastId: cursor, completed: false, kicked: false };
    }
    await sleep(POLL_INTERVAL);
  }
}

function formatMessages(msgs: any[]): string {
  return msgs.map((m: any) => `[${m.sender?.name}] ${m.content}`).join("\n\n");
}

/** 输出等待结果，返回拼好的行 */
function renderWaitResult(roomArg: string, pid: string, r: WaitResult, convergedHint?: string): string[] {
  const lines: string[] = [];
  if (r.kicked) {
    lines.push(``, `⛔ ${t("cli.disconnected")}`);
  } else if (r.completed) {
    if (r.msgs.length > 0) lines.push(``, formatMessages(r.msgs));
    lines.push(``, `🏁 ${t("cli.completed")}`, r.conclusion ?? "");
  } else if (r.msgs.length > 0) {
    lines.push(``, formatMessages(r.msgs));
    if (convergedHint) {
      lines.push(``, `⚡ ${convergedHint}`);
    } else {
      lines.push(``, `[DISCUSSION IN PROGRESS — YOU MUST REPLY] → ai-battle send ${roomArg} --as ${pid} --content "..."`);
    }
  } else {
    lines.push(``, `⏳ ${t("cli.noNewMessages")}`);
    lines.push(`[WAITING — DO NOT STOP] → ai-battle poll ${roomArg} --as ${pid} --after ${r.lastId ?? ""}`);
  }
  return lines;
}

// ============================================================
// 参数解析
// ============================================================

function parse(
  options: Record<string, { type: "string" }>,
  args: string[],
): { values: Record<string, string | undefined>; positionals: string[] } {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true }) as any;
  } catch (e: any) {
    console.error(`Bad arguments: ${e.message}\n`);
    printUsage();
    process.exit(1);
  }
}

function parseIntOpt(v: string | undefined, name: string): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`--${name} must be a non-negative number`);
    process.exit(1);
  }
  return n;
}

// ============================================================
// 子命令
// ============================================================

async function cmdCreate(args: string[]): Promise<void> {
  const { values } = parse({
    topic: { type: "string" },
    name: { type: "string" },
    model: { type: "string" },
    "max-participants": { type: "string" },
    "max-rounds": { type: "string" },
  }, args);
  await ensureServerUp();

  const room = await post(`${LOCAL_BASE}/rooms`, {
    topic: values.topic,
    maxParticipants: parseIntOpt(values["max-participants"], "max-participants"),
    maxRounds: parseIntOpt(values["max-rounds"], "max-rounds"),
  });
  const joined = await post(`${LOCAL_BASE}/${room.roomId}/join`, {
    participantName: values.name,
    modelName: values.model,
  });
  const myName = joined.currentParticipants?.find((p: any) => p.id === joined.userId)?.name ?? "unknown";
  const pid = joined.userId;

  // 自动打开观战页面
  openSpectate(`http://${getLocalIP()}:${PORT}/battle/${room.roomId}/eatmelon`);

  const text = [
    t("cli.roomCreated"),
    ``,
    `  ${t("cli.roomId")}      ${room.roomId}`,
    `  ${t("cli.topic")}       ${room.topic}`,
    `  ${t("cli.joinUrl")}   http://${getLocalIP()}:${PORT}/battle/${room.roomId}`,
    `  ${t("cli.eatmelon")}   http://${getLocalIP()}:${PORT}/battle/${room.roomId}/eatmelon`,
    `  ${t("cli.history")}   http://${getLocalIP()}:${PORT}/battle/history`,
    `  ${t("cli.nickname")}     ${myName}`,
    `  ${t("cli.yourId")}      ${pid}`,
    ``,
    t("cli.shareHint"),
    ``,
    `→ ai-battle send ${room.roomId} --as ${pid} --content "..."`,
  ].join("\n");
  console.log(text);
}

async function cmdJoin(args: string[]): Promise<void> {
  const { values, positionals } = parse({
    as: { type: "string" },
    name: { type: "string" },
    model: { type: "string" },
    wait: { type: "string" },
  }, args);
  if (!positionals[0]) { console.error("join: missing <roomId|url>"); process.exit(1); }

  const roomArg = positionals[0];
  const ref = parseRoomRef(roomArg);
  await ensureRefServer(ref.base);

  const result = await post(`${ref.base}/battle/${ref.roomId}/join`, {
    userId: values.as,
    participantName: values.name,
    modelName: values.model,
  });
  const myName = result.currentParticipants?.find((p: any) => p.id === result.userId)?.name ?? "unknown";
  const pid = result.userId;
  const participants = result.currentParticipants?.map((p: any) => p.name).join(", ") ?? "";

  // 自动打开观战页面
  openSpectate(`${ref.base}/battle/${ref.roomId}/eatmelon`);

  const lines = [
    `${t("cli.joined")}`,
    ``,
    `  ${t("cli.topic")}       ${result.topic}`,
    `  ${t("cli.nickname")}     ${myName}`,
    `  ${t("cli.members")}   ${participants}`,
    `  ${t("cli.yourId")}      ${pid}`,
  ];

  // 已有消息直接展示
  const existing = (result.messages ?? []).filter((m: any) => m.type === "speech" && m.sender?.userId !== pid);  if (existing.length > 0) {
    lines.push(``, formatMessages(existing));
    lines.push(``, `→ ai-battle send ${roomArg} --as ${pid} --content "..."`);
    console.log(lines.join("\n"));
    return;
  }

  // 没有消息，等一等
  const waitSec = parseIntOpt(values.wait, "wait") ?? DEFAULT_WAIT;
  if (waitSec === 0) {
    lines.push(``, `→ ai-battle send ${roomArg} --as ${pid} --content "..."`);
    console.log(lines.join("\n"));
    return;
  }
  lines.push(``, `⏳ ${t("cli.waitingForMessages")}`);
  const r = await waitForReplies(ref.base, ref.roomId, pid, undefined, waitSec);
  lines.push(...renderWaitResult(roomArg, pid, r));
  console.log(lines.join("\n"));
}

async function cmdSend(args: string[]): Promise<void> {
  const { values, positionals } = parse({
    as: { type: "string" },
    content: { type: "string" },
    "key-points": { type: "string" },
    wait: { type: "string" },
  }, args);
  if (!positionals[0]) { console.error("send: missing <roomId|url>"); process.exit(1); }
  if (!values.as) { console.error(`send: missing required --as <yourId> (printed by create/join)`); process.exit(1); }
  if (values.content === undefined) { console.error("send: missing required --content <text>"); process.exit(1); }

  const roomArg = positionals[0];
  const ref = parseRoomRef(roomArg);
  await ensureRefServer(ref.base);

  const keyPoints = values["key-points"]?.split(";").map((s) => s.trim()).filter(Boolean);
  const result = await post(`${ref.base}/battle/${ref.roomId}/messages`, {
    userId: values.as, content: values.content, keyPoints,
  });

  const lines = [`💬 [You] ${values.content}`];

  if (result.nextAction === "completed") {
    lines.push(``, `🏁 ${t("cli.completed")}`, result.conclusion ?? "");
    console.log(lines.join("\n"));
    return;
  }

  // 等回复
  const waitSec = parseIntOpt(values.wait, "wait") ?? DEFAULT_WAIT;
  if (waitSec > 0) {
    const r = await waitForReplies(ref.base, ref.roomId, values.as, result.messageId, waitSec);
    const convergedHint = result.converged
      ? `${t("cli.convergedHint")} (${Math.round((result.convergenceScore ?? 0) * 100)}%)`
      : undefined;
    lines.push(...renderWaitResult(roomArg, values.as, r, convergedHint));
  }
  console.log(lines.join("\n"));
}

async function cmdPoll(args: string[]): Promise<void> {
  const { values, positionals } = parse({
    as: { type: "string" },
    after: { type: "string" },
    wait: { type: "string" },
  }, args);
  if (!positionals[0]) { console.error("poll: missing <roomId|url>"); process.exit(1); }
  if (!values.as) { console.error(`poll: missing required --as <yourId> (printed by create/join)`); process.exit(1); }

  const roomArg = positionals[0];
  const ref = parseRoomRef(roomArg);
  await ensureRefServer(ref.base);

  const waitSec = parseIntOpt(values.wait, "wait") ?? DEFAULT_WAIT;
  const r = await waitForReplies(ref.base, ref.roomId, values.as, values.after, waitSec);
  console.log(renderWaitResult(roomArg, values.as, r).join("\n").trim());
}

async function cmdSay(args: string[]): Promise<void> {
  const { values, positionals } = parse({
    as: { type: "string" },
    content: { type: "string" },
  }, args);
  if (!positionals[0]) { console.error("say: missing <roomId|url>"); process.exit(1); }
  if (!values.as) { console.error(`say: missing required --as <yourId> (printed by create/join)`); process.exit(1); }
  if (values.content === undefined) { console.error("say: missing required --content <text>"); process.exit(1); }

  const roomArg = positionals[0];
  const ref = parseRoomRef(roomArg);
  await ensureRefServer(ref.base);

  await post(`${ref.base}/battle/${ref.roomId}/interjection`, { userId: values.as, content: values.content });
  console.log(`💬 [Human] ${values.content}\n\n→ ai-battle send ${roomArg} --as ${values.as} --content "..."`);
}

async function cmdEnd(args: string[]): Promise<void> {
  const { positionals } = parse({}, args);
  if (!positionals[0]) { console.error("end: missing <roomId|url>"); process.exit(1); }
  const ref = parseRoomRef(positionals[0]);
  await ensureRefServer(ref.base);

  const result = await post(`${ref.base}/battle/${ref.roomId}/end`, {});
  console.log(`🏁 ${t("cli.completed")}\n\n${result.conclusion ?? ""}`);
}

async function cmdStatus(args: string[]): Promise<void> {
  const { positionals } = parse({}, args);
  if (!positionals[0]) { console.error("status: missing <roomId|url>"); process.exit(1); }
  const ref = parseRoomRef(positionals[0]);
  await ensureRefServer(ref.base);

  const result = await get(`${ref.base}/battle/${ref.roomId}/status`);
  console.log(JSON.stringify(result, null, 2));
}

async function cmdRooms(): Promise<void> {
  await ensureServerUp();
  const rooms: any[] = await get(`${LOCAL_BASE}/rooms`);
  if (!rooms || rooms.length === 0) {
    console.log("(no rooms)");
    return;
  }
  const lines = rooms
    .slice()
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    .map((r) => `${r.id}  ${r.status.padEnd(11)} ${String(r.participants).padStart(2)}p ${String(r.messages).padStart(3)}msg  ${r.topic}`);
  console.log(lines.join("\n"));
}

function printUsage(): void {
  console.log(`AI Battle — let your AIs talk to each other (CLI)

Usage: ai-battle <command> [args]

Commands:
  create [--topic <t>] [--name <nick>] [--model <m>] [--max-participants <n>] [--max-rounds <n>]
         Create a room and join it. Prints YOUR_ID — pass it as --as on every later command.
  join <roomId|url> [--as <id>] [--name <nick>] [--model <m>] [--wait <sec>]
         Join an existing room. A fresh id is generated when --as is omitted, so two
         agents of the same user each get their own identity and never interfere.
  send <roomId|url> --as <id> --content <text> [--key-points <a;b>] [--wait <sec>]
         Send YOUR AI message, then block until others reply (default 300s).
  poll <roomId|url> --as <id> [--after <msgId>] [--wait <sec>]
         Wait for new messages after the given message id.
  say <roomId|url> --as <id> --content <text>
         Forward the HUMAN user's exact words into the room.
  end <roomId|url>
         End the discussion and print the conclusion.
  status <roomId|url>
         Dump room status as JSON.
  rooms  List rooms known to the local server.
  serve  Run the local HTTP server in the foreground.

Options:
  --wait <sec>   Max seconds to block waiting for replies (0 = don't wait).

Env: AI_BATTLE_PORT (default 19820), AI_BATTLE_LANG (en / zh-CN / zh-TW / ja / ko),
     AI_BATTLE_NO_OPEN=1 (do not auto-open the spectate page)`);
}

// ============================================================
// 主流程
// ============================================================

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  try {
    switch (cmd) {
      case "serve": await startServer(); break;
      case "create": await cmdCreate(rest); break;
      case "join": await cmdJoin(rest); break;
      case "send": await cmdSend(rest); break;
      case "poll": await cmdPoll(rest); break;
      case "say": await cmdSay(rest); break;
      case "end": await cmdEnd(rest); break;
      case "status": await cmdStatus(rest); break;
      case "rooms": await cmdRooms(); break;
      case undefined:
      case "help":
      case "--help":
      case "-h":
        printUsage();
        break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        printUsage();
        process.exit(1);
    }
  } catch (e: any) {
    const msg = `${t("cli.error")}: ${errMsg(e)}`;
    if (e?.response?.data?.message === "participantNotFound") {
      console.error(`${msg}\n\n→ you were removed from the room; rejoin with: ai-battle join <room> --as <yourId>`);
    } else {
      console.error(msg);
    }
    process.exit(1);
  }
}

await main();

export { type Room, type Message, type Participant } from "./core/types.js";
