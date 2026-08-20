import Koa from "koa";
import Router from "@koa/router";
import bodyParser from "koa-bodyparser";
import cors from "@koa/cors";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import ejs from "ejs";
import { BattleError } from "../core/errors.js";
import { t, parseLocale, getSpectateI18n } from "../core/i18n.js";
import type { CreateRoomInput, JoinRoomOutput, GetStatusOutput, SendMessageOutput, PollOutput, SpectateOutput, BattleEvent } from "../core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 输入长度限制
const MAX_TOPIC_LENGTH = 200;
const MAX_CONTENT_LENGTH = 10000;
const MAX_NAME_LENGTH = 50;

// 统一响应格式
function succeed(data: unknown, message?: string) {
  return { code: 200, message: message ?? "ok", data: data ?? null };
}

function fail(message: string, code?: number) {
  return { code: code ?? 500, message, data: null };
}

export interface ApiContext {
  createRoom(input: CreateRoomInput): any;
  joinRoom(input: any): JoinRoomOutput;
  getStatus(input: { roomId: string }): GetStatusOutput;
  sendMessage(input: any): SendMessageOutput;
  poll(input: { roomId: string; userId: string; after?: string }): PollOutput;
  spectate(input: { roomId: string; after?: string }): SpectateOutput;
  addInterjection(roomId: string, userId: string, content: string): void;
  endRoom(roomId: string): string;
  deleteRoom(roomId: string): void;
  listRooms(): Array<{ id: string; topic: string; status: string; participants: number; messages: number; createdAt: number; completedAt?: number; lastActiveAt: number }>;
  /** 注册 SSE 事件监听，返回取消函数 */
  onEvent(callback: (roomId: string, event: BattleEvent) => void): () => void;
}

export function createHttpApi(ctx: ApiContext, hooks?: { onRequest?: () => void }): Koa {
  const app = new Koa();

  app.use(cors());
  app.use(bodyParser());

  // 请求活跃打点（server 空闲退出计时用）
  if (hooks?.onRequest) {
    app.use(async (c, next) => {
      hooks.onRequest!();
      await next();
    });
  }

  // Error handler
  app.use(async (c, next) => {
    try {
      await next();
    } catch (err: unknown) {
      const locale = parseLocale(c.get("Accept-Language"));
      const statusCode = err instanceof BattleError ? err.statusCode : 500;
      const message = err instanceof BattleError && err.errorKey
        ? t(err.errorKey, locale)
        : (err instanceof Error ? err.message : "Unknown error");
      c.status = statusCode;
      c.body = fail(message, statusCode);
    }
  });

  const router = new Router({ prefix: "/battle" });

  // 启动时收集本机所有 IP
  const localIPs = new Set(["127.0.0.1", "::1"]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) localIPs.add(a.address);
  }

  function isLocalRequest(c: any): boolean {
    const socket = c.req?.socket || c.socket;
    const remote = (socket?.remoteAddress ?? "").replace("::ffff:", "");
    return localIPs.has(remote);
  }

  // GET /health — 健康检查
  router.get("/health", async (c) => {
    c.body = succeed({ ok: true });
  });

  // GET /rooms — 历史房间列表（仅限本机）
  router.get("/rooms", async (c) => {
    if (!isLocalRequest(c)) { c.status = 403; c.body = fail("Local access only", 403); return; }
    c.body = succeed(ctx.listRooms());
  });

  // GET /history — 历史聊天页面（仅限本机）
  const historyTpl = path.resolve(__dirname, "..", "web", "history.ejs");
  router.get("/history", async (c) => {
    if (!isLocalRequest(c)) { c.status = 403; c.body = fail("Local access only", 403); return; }
    const locale = parseLocale(c.get("Accept-Language"));
    const rooms = ctx.listRooms();
    try {
      const html = await ejs.renderFile(historyTpl, { rooms, locale });
      c.type = "text/html";
      c.body = html;
    } catch (e) {
      c.status = 500;
      c.body = fail("Template error", 500);
    }
  });

  // POST /rooms — 创建房间
  router.post("/rooms", async (c) => {
    const { topic, maxParticipants, maxRounds } = c.request.body as any;
    if (typeof topic === "string" && topic.length > MAX_TOPIC_LENGTH) {
      c.status = 400;
      c.body = fail(`topic exceeds max length (${MAX_TOPIC_LENGTH})`, 400);
      return;
    }
    const input: CreateRoomInput = { topic };
    if (maxParticipants !== undefined) input.maxParticipants = maxParticipants;
    if (maxRounds !== undefined) input.maxRounds = maxRounds;
    c.body = succeed(await ctx.createRoom(input));
  });

  // POST /:roomId/join — 加入房间
  router.post("/:roomId/join", async (c) => {
    const roomId = c.params.roomId;
    const { userId, participantName, modelName } = c.request.body as any;
    if (typeof participantName === "string" && participantName.length > MAX_NAME_LENGTH) {
      c.status = 400;
      c.body = fail(`participantName exceeds max length (${MAX_NAME_LENGTH})`, 400);
      return;
    }
    const input: any = { roomId };
    if (userId !== undefined) input.userId = userId;
    if (participantName !== undefined) input.participantName = participantName;
    if (modelName !== undefined) input.modelName = modelName;
    const joinResult = ctx.joinRoom(input);

    // 附带已有消息
    let messages: unknown[] = [];
    try {
      const status = ctx.getStatus({ roomId });
      messages = status.messages ?? [];
    } catch {}

    c.body = succeed({ ...joinResult, messages });
  });

  // GET /:roomId/status — 获取状态
  router.get("/:roomId/status", async (c) => {
    c.body = succeed(ctx.getStatus({ roomId: c.params.roomId }));
  });

  // GET /:roomId/messages — 轮询新消息
  router.get("/:roomId/messages", async (c) => {
    const roomId = c.params.roomId;
    const userId = c.query.userId as string;
    const after = c.query.after as string | undefined;
    if (!userId) {
      c.status = 400;
      c.body = fail("userId is required", 400);
      return;
    }
    c.body = succeed(ctx.poll({ roomId, userId, after }));
  });

  // GET /:roomId/spectate — 观战 SSE
  router.get("/:roomId/spectate", async (c) => {
    const roomId = c.params.roomId;

    // 验证房间存在
    try {
      ctx.getStatus({ roomId });
    } catch {
      c.status = 404;
      c.body = fail(t("roomNotFound", parseLocale(c.get("Accept-Language"))), 404);
      return;
    }

    // 设置 SSE 头
    c.res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    // 发送初始状态
    const initial = ctx.spectate({ roomId });
    c.res.write(`event: init\ndata: ${JSON.stringify(initial)}\n\n`);

    // 监听后续事件
    const unsubscribe = ctx.onEvent((evtRoomId, event) => {
      if (evtRoomId !== roomId) return;
      c.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    });

    // 心跳
    const heartbeat = setInterval(() => {
      c.res.write(`:heartbeat\n\n`);
    }, 15000);

    // 清理
    c.req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });

    // 阻止 Koa 关闭响应
    c.respond = false;
  });

  // POST /:roomId/messages — 发送消息
  router.post("/:roomId/messages", async (c) => {
    const roomId = c.params.roomId;
    const { userId, content, keyPoints } = c.request.body as any;
    if (!userId || !content) {
      c.status = 400;
      c.body = fail("userId and content are required", 400);
      return;
    }
    if (typeof content === "string" && content.length > MAX_CONTENT_LENGTH) {
      c.status = 400;
      c.body = fail(`content exceeds max length (${MAX_CONTENT_LENGTH})`, 400);
      return;
    }
    const input: any = { roomId, userId, content };
    if (keyPoints !== undefined) input.keyPoints = keyPoints;
    c.body = succeed(ctx.sendMessage(input));
  });

  // POST /:roomId/interjection — 人类插话
  router.post("/:roomId/interjection", async (c) => {
    const { userId, content } = c.request.body as any;
    if (!userId || !content) {
      c.status = 400;
      c.body = fail("userId and content are required", 400);
      return;
    }
    if (typeof content === "string" && content.length > MAX_CONTENT_LENGTH) {
      c.status = 400;
      c.body = fail(`content exceeds max length (${MAX_CONTENT_LENGTH})`, 400);
      return;
    }
    ctx.addInterjection(c.params.roomId, userId, content);
    c.body = succeed(null);
  });

  // POST /:roomId/end — 结束讨论
  router.post("/:roomId/end", async (c) => {
    const conclusion = ctx.endRoom(c.params.roomId);
    c.body = succeed({ conclusion });
  });

  // DELETE /:roomId — 手动删除房间数据（仅限本机）
  router.delete("/:roomId", async (c) => {
    if (!isLocalRequest(c)) { c.status = 403; c.body = fail("Local access only", 403); return; }
    ctx.deleteRoom(c.params.roomId);
    c.body = succeed(null);
  });


  // 启动时预加载模板和 marked.js
  const spectateTpl = path.resolve(__dirname, "..", "web", "spectate.ejs");
  let markedJs = "";
  try {
    // 从实际解析到的 marked 包取 UMD 构建（deps 会被 npm 提升到包外，不能用相对路径猜）
    const markedEntry = createRequire(import.meta.url).resolve("marked");
    markedJs = fs.readFileSync(path.join(path.dirname(markedEntry), "marked.umd.js"), "utf-8");
  } catch {}

  // GET /:roomId/eatmelon — 观战页面
  router.get("/:roomId/eatmelon", async (c) => {
    try {
      const locale = parseLocale(c.get("Accept-Language"));
      const html = await ejs.renderFile(spectateTpl, {
        locale: locale.startsWith("zh") ? "zh" : locale,
        i18nJson: getSpectateI18n(locale),
        markedJs,
      });
      c.type = "text/html";
      c.body = html;
    } catch {
      c.status = 404;
      c.body = "Spectate page not found";
    }
  });

  app.use(router.routes());
  app.use(router.allowedMethods());

  // 404 handler
  app.use(async (c) => {
    c.status = 404;
    c.body = fail("Not found", 404);
  });

  return app;
}

