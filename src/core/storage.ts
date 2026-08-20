import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import type { Room, Participant, Message, RoomStatus, RoomConfig } from "./types.js";

// ============================================================
// JSONL 事件类型
// ============================================================

export type StorageEvent =
  | { type: "room_created"; data: { id: string; topic: string; config: RoomConfig; createdAt: number } }
  | { type: "room_started"; data: { startedAt: number } }
  | { type: "room_updated"; data: Partial<{ currentRound: number; convergenceScore: number; status: RoomStatus }> }
  | { type: "room_completed"; data: { conclusion: string; completedAt: number } }
  | { type: "participant_joined"; data: Participant }
  | { type: "message"; data: Message };

// ============================================================
// Storage — JSONL 事件日志
// ============================================================

export class Storage {
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? path.join(os.homedir(), ".ai-battle");
    fs.mkdirSync(path.join(this.dataDir, "rooms"), { recursive: true });
  }

  private roomPath(roomId: string): string {
    return path.join(this.dataDir, "rooms", `${roomId}.jsonl`);
  }

  /** 追加事件到房间的 JSONL 文件 */
  appendEvent(roomId: string, event: StorageEvent): void {
    const filePath = this.roomPath(roomId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({ ...event, ts: Date.now() }) + "\n");
  }

  /** 启动时回放所有房间文件，重建活跃房间 */
  loadActiveRooms(): Map<string, Room> {
    const rooms = new Map<string, Room>();
    for (const [id, room] of this.loadAllRooms()) {
      if (room.status !== "completed" && room.status !== "closed") {
        rooms.set(id, room);
      }
    }
    return rooms;
  }

  /** 回放所有房间（含已完成/已解散） */
  loadAllRooms(): Map<string, Room> {
    const rooms = new Map<string, Room>();
    const roomsDir = path.join(this.dataDir, "rooms");
    if (!fs.existsSync(roomsDir)) return rooms;

    for (const file of fs.readdirSync(roomsDir)) {
      if (!file.endsWith(".jsonl")) continue;
      const roomId = file.replace(".jsonl", "");
      const room = this.replayRoom(roomId);
      if (room) rooms.set(roomId, room);
    }
    return rooms;
  }

  /** 回放单个房间的事件日志 */
  private replayRoom(roomId: string): Room | undefined {
    const filePath = this.roomPath(roomId);
    if (!fs.existsSync(filePath)) return undefined;

    let room: Room | undefined;
    const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);

    for (const line of lines) {
      const event = JSON.parse(line) as StorageEvent & { ts: number };

      switch (event.type) {
        case "room_created": {
          const d = event.data;
          room = {
            id: d.id, topic: d.topic, config: d.config,
            status: "waiting" as RoomStatus,
            participants: new Map(), messages: [],
            currentRound: 0, convergenceScore: 0, createdAt: d.createdAt,
          };
          break;
        }
        case "room_started":
          if (room) {
            room.status = "in_progress";
            room.startedAt = event.data.startedAt;
            room.currentRound = 1;
          }
          break;
        case "participant_joined":
          if (room) room.participants.set(event.data.id, event.data);
          break;
        case "message":
          if (room) room.messages.push(event.data);
          break;
        case "room_updated":
          if (room) {
            const u = event.data;
            if (u.currentRound !== undefined) room.currentRound = u.currentRound;
            if (u.convergenceScore !== undefined) room.convergenceScore = u.convergenceScore;
            if (u.status !== undefined) room.status = u.status;
          }
          break;
        case "room_completed":
          if (room) {
            room.status = "completed";
            room.conclusion = event.data.conclusion;
            room.completedAt = event.data.completedAt;
          }
          break;
      }
    }
    return room;
  }

  /** 删除房间文件 */
  deleteRoom(roomId: string): void {
    const filePath = this.roomPath(roomId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  // ============================================================
  // 用户信息持久化
  // ============================================================

  private get profilesPath(): string {
    return path.join(this.dataDir, "profiles.json");
  }

  /** 获取或创建用户信息 */
  getProfile(): { userId: string; nickname?: string } {
    if (fs.existsSync(this.profilesPath)) {
      try {
        return JSON.parse(fs.readFileSync(this.profilesPath, "utf-8"));
      } catch {}
    }
    const profile = { userId: crypto.randomUUID() };
    fs.writeFileSync(this.profilesPath, JSON.stringify(profile, null, 2));
    return profile;
  }

  /** 更新昵称 */
  saveNickname(nickname: string): void {
    const profile = this.getProfile();
    profile.nickname = nickname;
    fs.writeFileSync(this.profilesPath, JSON.stringify(profile, null, 2));
  }
}
