import crypto from "node:crypto";
import type { Storage } from "./storage.js";
import type { Room, CreateRoomInput, CreateRoomOutput, JoinRoomInput, JoinRoomOutput, Participant, Message } from "./types.js";
import { NotFoundError, ConflictError, ForbiddenError } from "./errors.js";
import { t } from "./i18n.js";

const DEFAULT_CONFIG = {
  maxParticipants: 10,
  maxRounds: Infinity,
  convergenceThreshold: 0.75,
};

function generateRoomId(): string {
  const uuid = crypto.randomUUID();
  return crypto.createHash("md5").update(uuid).digest("hex").substring(13, 19);
}

const ADJECTIVES = ["Swift", "Bold", "Calm", "Keen", "Wise", "Brave", "Sharp", "Bright", "Cool", "Lucky"];
const ANIMALS = ["Fox", "Owl", "Bear", "Wolf", "Hawk", "Lion", "Deer", "Lynx", "Puma", "Crow"];

function generateNickname(): string {
  return `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`;
}

function logStorageError(e: unknown): void {
  process.stderr.write(`[ai-battle] Storage error: ${e}\n`);
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private storage?: Storage;

  constructor(storage?: Storage) {
    this.storage = storage;
  }

  createRoom(input: CreateRoomInput): CreateRoomOutput {
    let roomId = generateRoomId();
    while (this.rooms.has(roomId)) roomId = generateRoomId();

    const room: Room = {
      id: roomId,
      topic: input.topic || "Open Discussion",
      status: "waiting",
      config: {
        maxParticipants: input.maxParticipants ?? DEFAULT_CONFIG.maxParticipants,
        maxRounds: input.maxRounds ?? DEFAULT_CONFIG.maxRounds,
        convergenceThreshold: DEFAULT_CONFIG.convergenceThreshold,
      },
      participants: new Map(),
      messages: [],
      currentRound: 0,
      convergenceScore: 0,
      createdAt: Date.now(),
    };
    this.rooms.set(roomId, room);
    this.storage?.appendEvent(roomId, {
      type: "room_created",
      data: { id: roomId, topic: room.topic, config: room.config, createdAt: room.createdAt },
    });
    return {
      roomId,
      topic: room.topic,
      maxParticipants: room.config.maxParticipants,
      joinUrl: `/battle/${roomId}`,
      spectateUrl: `/battle/${roomId}/eatmelon`,
    };
  }

  /** 解析昵称：显式传入（--name，用户意图，更新存储） > 已保存 > 随机生成 */
  resolveNickname(providedName?: string): string {
    if (providedName) {
      if (this.storage) {
        try { this.storage.saveNickname(providedName); } catch (e) { logStorageError(e); }
      }
      return providedName;
    }
    if (this.storage) {
      const saved = this.storage.getProfile().nickname;
      if (saved) return saved;
    }
    const name = generateNickname();
    if (this.storage) {
      try { this.storage.saveNickname(name); } catch (e) { logStorageError(e); }
    }
    return name;
  }

  joinRoom(input: JoinRoomInput): JoinRoomOutput {
    const room = this.rooms.get(input.roomId);
    if (!room) throw new NotFoundError();

    // 重连：同一 userId 再次 join 只刷新状态，不重复加人、不重复发系统消息
    const existing = input.userId ? room.participants.get(input.userId) : undefined;
    if (existing) {
      const now = Date.now();
      if (input.modelName !== undefined) existing.modelName = input.modelName;
      if (input.participantName && input.participantName !== existing.name) existing.name = input.participantName;
      existing.lastActiveAt = now;
      existing.lastSendAt = now;
      return {
        userId: existing.id,
        topic: room.topic,
        currentParticipants: Array.from(room.participants.values()).map((p) => ({ id: p.id, name: p.name })),
        roomStatus: room.status,
      };
    }

    if (room.participants.size >= room.config.maxParticipants) throw new ConflictError("roomFull");

    // 不带 userId 的 join 每次生成全新 id：
    // 同一个用户开两个 agent（如 Claude + Gemini）各自加入时，
    // 拿到各自独立的参与者身份，poll/发消息/掉线检测互不干扰。
    const userId = input.userId || crypto.randomUUID();
    const name = input.participantName || this.resolveNickname();
    const modelName = input.modelName;
    const now = Date.now();
    const participant: Participant = { id: userId, name, modelName, joinedAt: now, isCreator: room.participants.size === 0, lastActiveAt: now, lastSendAt: now };
    room.participants.set(userId, participant);

    // 系统消息：xxx 加入了讨论
    const sysMsg: Message = {
      id: crypto.randomUUID(), roomId: input.roomId, timestamp: now,
      type: "system", sender: { name: "system", role: "system" },
      content: `${name} ${t("userJoined")}`, metadata: {},
    };
    room.messages.push(sysMsg);

    this.storage?.appendEvent(room.id, { type: "participant_joined", data: participant });
    this.storage?.appendEvent(room.id, { type: "message", data: sysMsg });

    if (room.status === "waiting") {
      room.status = "in_progress";
      room.startedAt = Date.now();
      room.currentRound = 1;
      this.storage?.appendEvent(room.id, { type: "room_started", data: { startedAt: room.startedAt } });
    }

    return {
      userId,
      topic: room.topic,
      currentParticipants: Array.from(room.participants.values()).map((p) => ({ id: p.id, name: p.name })),
      roomStatus: room.status,
    };
  }

  loadFromStorage(): void {
    if (!this.storage) return;
    for (const [id, room] of this.storage.loadActiveRooms()) {
      this.rooms.set(id, room);
    }
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  get activeRoomCount(): number {
    return this.rooms.size;
  }

  getAllRooms(): Room[] {
    return Array.from(this.rooms.values());
  }

  completeRoom(roomId: string, conclusion: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new NotFoundError();
    room.status = "completed";
    room.conclusion = conclusion;
    room.completedAt = Date.now();
    this.storage?.appendEvent(roomId, { type: "room_completed", data: { conclusion, completedAt: room.completedAt } });
  }

  /** 手动删除房间：内存 + 持久化数据一起清（ai-battle rm） */
  deleteRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new NotFoundError();
    this.rooms.delete(roomId);
    this.storage?.deleteRoom(roomId);
  }
}
