import crypto from "node:crypto";
import { RoomManager } from "./room-manager.js";
import { NotFoundError } from "./errors.js";
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
  // 活跃时间戳（仅用于 rooms 列表排序展示；
  // room 状态不因掉线/空闲而改变 —— server 空闲退出后回放续战，见 index.ts）
  // ============================================================

  /** 更新参与者活跃时间 */
  private touchParticipant(room: Room, userId: string): void {
    const p = room.participants.get(userId);
    if (p) p.lastActiveAt = Date.now();
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

    return {
      messages: this.getMessagesAfter(roomId, afterId),
      // yourTurn=false 且参与者不在列表里 → 已被移除（被踢），客户端应停止
      yourTurn: room.status === "in_progress" && room.participants.has(userId),
      roomStatus: room.status,
      round: room.currentRound,
      convergenceScore: room.convergenceScore,
      conclusion: room.conclusion,
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
