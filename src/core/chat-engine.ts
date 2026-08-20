import crypto from "node:crypto";
import { RoomManager } from "./room-manager.js";
import { NotFoundError } from "./errors.js";
import { t } from "./i18n.js";
import type { Storage } from "./storage.js";
import type {
  Room,
  ConvergenceDetector,
  ConclusionGenerator,
  SendMessageInput,
  SendMessageOutput,
  PollOutput,
  SpectateOutput,
  Message,
  BattleEvent,
} from "./types.js";

export interface ChatEngineOptions {
  roomManager: RoomManager;
  storage?: Storage;
  convergenceDetector?: ConvergenceDetector;
  conclusionGenerator?: ConclusionGenerator;
}

export class ChatEngine {
  private roomManager: RoomManager;
  private storage?: Storage;
  private convergenceDetector?: ConvergenceDetector;
  private conclusionGenerator?: ConclusionGenerator;
  private eventListeners: Array<(roomId: string, event: BattleEvent) => void> = [];

  constructor(opts: ChatEngineOptions) {
    this.roomManager = opts.roomManager;
    this.storage = opts.storage;
    this.convergenceDetector = opts.convergenceDetector;
    this.conclusionGenerator = opts.conclusionGenerator;
  }

  private emit(roomId: string, event: BattleEvent): void {
    for (const listener of this.eventListeners) {
      listener(roomId, event);
    }
  }

  // ============================================================
  // 心跳 & 超时
  // ============================================================

  /** 5 分钟无 poll 算可能掉线 */
  private static readonly POLL_TIMEOUT = 5 * 60 * 1000;
  /** 10 分钟无 send 算可能掉线 */
  private static readonly SEND_TIMEOUT = 10 * 60 * 1000;
  /** 全员掉线后 20 分钟自动关闭房间 */
  private static readonly ROOM_IDLE_TIMEOUT = 20 * 60 * 1000;

  /** 更新参与者活跃时间 */
  private touchParticipant(room: Room, userId: string): void {
    const p = room.participants.get(userId);
    if (p) p.lastActiveAt = Date.now();
  }

  /** 检查并清理：掉线参与者 + 空闲房间 */
  private checkActivity(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room || room.status !== "in_progress") return;

    const now = Date.now();

    // 1. 房间整体空闲超过 20 分钟 → 结束（原因写入结论，状态统一为 completed）
    const lastActivity = Math.max(...Array.from(room.participants.values()).map(p => p.lastActiveAt));
    if (now - lastActivity > ChatEngine.ROOM_IDLE_TIMEOUT) {
      this.roomManager.completeRoom(roomId, "Idle timeout");
      this.emit(roomId, { type: "discussion_completed", conclusion: "Idle timeout" });
      return;
    }

    // 2. 清理掉线参与者（3分钟无poll 或 10分钟无send）
    const disconnected: string[] = [];
    for (const [id, p] of room.participants) {
      const pollTimeout = now - p.lastActiveAt > ChatEngine.POLL_TIMEOUT;
      const sendTimeout = now - p.lastSendAt > ChatEngine.SEND_TIMEOUT;
      // Both must timeout — AI may be thinking (no poll) but recently sent (still active)
      if (pollTimeout && sendTimeout) disconnected.push(id);
    }

    for (const id of disconnected) {
      const name = room.participants.get(id)?.name ?? id;
      room.participants.delete(id);
      // 系统消息持久化
      const sysMsg: Message = {
        id: crypto.randomUUID(), roomId, timestamp: Date.now(),
        type: "system", sender: { name: "system", role: "system" },
        content: `${name} ${t("userLeft")}`, metadata: {},
      };
      room.messages.push(sysMsg);
      this.storage?.appendEvent(roomId, { type: "message", data: sysMsg });
      this.emit(roomId, { type: "participant_left", participant: { id, name } });
    }

    // 3. 所有人都掉线了 → 结束
    if (disconnected.length > 0 && room.participants.size === 0) {
      this.roomManager.completeRoom(roomId, "All participants disconnected");
      this.emit(roomId, { type: "discussion_completed", conclusion: "All participants disconnected" });
    }
  }

  // ============================================================
  // 轮询
  // ============================================================

  getMessagesAfter(roomId: string, afterId?: string): Message[] {
    const room = this.roomManager.getRoom(roomId);
    if (!room) throw new NotFoundError();
    if (!afterId) return [...room.messages];
    const idx = room.messages.findIndex((m) => m.id === afterId);
    if (idx === -1) return [...room.messages];
    return room.messages.slice(idx + 1);
  }

  getPollData(roomId: string, userId: string, afterId?: string): PollOutput {
    const room = this.roomManager.getRoom(roomId);
    if (!room) throw new NotFoundError();

    this.touchParticipant(room, userId);
    this.checkActivity(roomId);

    // room may have been completed by cleanup
    const refreshed = this.roomManager.getRoom(roomId);
    const r = refreshed ?? room;

    return {
      messages: this.getMessagesAfter(roomId, afterId),
      // yourTurn=false 且参与者不在列表里 → 已被移除（被踢），客户端应停止
      yourTurn: r.status === "in_progress" && r.participants.has(userId),
      roomStatus: r.status,
      round: r.currentRound,
      convergenceScore: r.convergenceScore,
      conclusion: r.conclusion,
    };
  }

  getSpectateData(roomId: string, afterId?: string): SpectateOutput {
    const room = this.roomManager.getRoom(roomId);
    if (!room) throw new NotFoundError();
    return {
      topic: room.topic,
      messages: this.getMessagesAfter(roomId, afterId),
      participants: Array.from(room.participants.values()).map((p) => ({ id: p.id, name: p.name })),
      roomStatus: room.status,
      round: room.currentRound,
      convergenceScore: room.convergenceScore,
      conclusion: room.conclusion,
    };
  }

  // ============================================================
  // 发消息
  // ============================================================

  submitMessage(input: SendMessageInput): SendMessageOutput {
    const room = this.roomManager.getRoom(input.roomId);
    if (!room) throw new NotFoundError();

    const participant = room.participants.get(input.userId);
    if (!participant) throw new NotFoundError("participantNotFound");

    this.touchParticipant(room, input.userId);
    if (participant) participant.lastSendAt = Date.now();

    const message: Message = {
      id: crypto.randomUUID(),
      roomId: input.roomId,
      timestamp: Date.now(),
      type: "speech",
      sender: { userId: input.userId, name: participant.modelName ? `${participant.name}的AI@${participant.modelName}` : participant.name, role: "ai" },
      content: input.content,
      metadata: { round: room.currentRound, keyPoints: input.keyPoints },
    };
    room.messages.push(message);
    this.storage?.appendEvent(input.roomId, { type: "message", data: message });
    this.emit(input.roomId, { type: "new_message", message });

    // 更新轮次（所有人发完一轮）
    const speechCount = room.messages.filter((m) => m.type === "speech").length;
    if (speechCount > 0 && room.participants.size > 0 && speechCount % room.participants.size === 0) {
      room.currentRound++;
    }

    // 更新收敛分数
    if (input.keyPoints && this.convergenceDetector) {
      const convergence = this.convergenceDetector.analyze(room, input.keyPoints);
      room.convergenceScore = convergence.score;
      this.emit(input.roomId, { type: "convergence_update", score: convergence.score });
    }

    this.storage?.appendEvent(input.roomId, {
      type: "room_updated",
      data: { currentRound: room.currentRound, convergenceScore: room.convergenceScore },
    });

    const converged = room.convergenceScore >= room.config.convergenceThreshold;
    return { messageId: message.id, nextAction: "poll", convergenceScore: room.convergenceScore, converged };
  }

  // ============================================================
  // 插话
  // ============================================================

  addInterjection(roomId: string, userId: string, content: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) throw new NotFoundError();
    const participant = room.participants.get(userId);
    const name = participant?.name ?? "Human";
    const message: Message = {
      id: crypto.randomUUID(),
      roomId,
      timestamp: Date.now(),
      type: "interjection",
      sender: { userId: userId, name, role: "human" },
      content,
      metadata: { round: room.currentRound },
    };
    room.messages.push(message);
    this.storage?.appendEvent(roomId, { type: "message", data: message });
    this.emit(roomId, { type: "new_message", message });
  }

  /** 主动结束讨论，生成结论 */
  endRoom(roomId: string): string {
    const room = this.roomManager.getRoom(roomId);
    if (!room) throw new NotFoundError();
    const conclusion = this.conclusionGenerator?.generate(room) ?? "Discussion ended";
    this.roomManager.completeRoom(roomId, conclusion);
    this.emit(roomId, { type: "discussion_completed", conclusion });
    return conclusion;
  }

  // ============================================================
  // 事件
  // ============================================================

  onEvent(callback: (roomId: string, event: BattleEvent) => void): void {
    this.eventListeners.push(callback);
  }

  removeEventListener(callback: (roomId: string, event: BattleEvent) => void): void {
    const idx = this.eventListeners.indexOf(callback);
    if (idx !== -1) this.eventListeners.splice(idx, 1);
  }
}
