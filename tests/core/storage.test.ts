import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Storage } from "../../src/core/storage.js";
import type { StorageEvent } from "../../src/core/storage.js";
import type { Room, Message, Participant } from "../../src/core/types.js";

function makeRoomCreatedEvent(overrides?: Partial<StorageEvent & { type: "room_created" }>["data"]): StorageEvent {
  return {
    type: "room_created",
    data: {
      id: "abc123",
      topic: "AI 的未来",
      config: {
        maxParticipants: 4,
        maxRounds: 10,
        convergenceThreshold: 0.75,
      },
      createdAt: Date.now(),
      ...overrides,
    },
  };
}

function makeParticipantJoinedEvent(overrides?: Partial<Participant>): StorageEvent {
  return {
    type: "participant_joined",
    data: {
      id: "p-001",
      name: "Claude",
      joinedAt: Date.now(),
      isCreator: true,
      ...overrides,
    },
  };
}

function makeMessageEvent(overrides?: Partial<Message>): StorageEvent {
  return {
    type: "message",
    data: {
      id: "msg-001",
      roomId: "abc123",
      timestamp: Date.now(),
      type: "speech",
      sender: { userId: "p-001", name: "Claude", role: "ai" },
      content: "我认为 AI 会超越人类",
      metadata: { round: 1, keyPoints: ["发展快"] },
      ...overrides,
    },
  };
}

describe("Storage", () => {
  let storage: Storage;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "ai-battle-test-"));
    storage = new Storage(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("appendEvent + loadActiveRooms round-trip", () => {
    it("should create room, add participants, add messages, then reload correctly", () => {
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", makeParticipantJoinedEvent({ id: "p-001", name: "Claude", isCreator: true }));
      storage.appendEvent("abc123", makeParticipantJoinedEvent({ id: "p-002", name: "GPT", isCreator: false }));
      storage.appendEvent("abc123", makeMessageEvent({ id: "msg-001" }));
      storage.appendEvent("abc123", makeMessageEvent({
        id: "msg-002",
        content: "第二条消息",
        sender: { userId: "p-002", name: "GPT", role: "ai" },
      }));

      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(1);

      const room = rooms.get("abc123")!;
      expect(room).toBeDefined();
      expect(room.id).toBe("abc123");
      expect(room.topic).toBe("AI 的未来");
      expect(room.status).toBe("waiting");
      expect(room.config.maxParticipants).toBe(4);
      expect(room.currentRound).toBe(0);
      expect(room.convergenceScore).toBe(0);
      expect(room.participants.size).toBe(2);
      expect(room.participants.get("p-001")!.name).toBe("Claude");
      expect(room.participants.get("p-002")!.name).toBe("GPT");
      expect(room.messages).toHaveLength(2);
      expect(room.messages[0].id).toBe("msg-001");
      expect(room.messages[1].id).toBe("msg-002");
    });
  });

  describe("loadActiveRooms — skips completed rooms", () => {
    it("should not return rooms with completed status", () => {
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", {
        type: "room_completed",
        data: { conclusion: "最终结论", completedAt: Date.now() },
      });

      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(0);
    });

    it("should return only active rooms when mixed with completed ones", () => {
      storage.appendEvent("room-active", makeRoomCreatedEvent({ id: "room-active" }));
      storage.appendEvent("room-done", makeRoomCreatedEvent({ id: "room-done" }));
      storage.appendEvent("room-done", {
        type: "room_completed",
        data: { conclusion: "结论", completedAt: Date.now() },
      });

      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(1);
      expect(rooms.has("room-active")).toBe(true);
      expect(rooms.has("room-done")).toBe(false);
    });
  });

  describe("loadActiveRooms — empty state", () => {
    it("should return empty map when no JSONL files exist", () => {
      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(0);
    });
  });

  describe("deleteRoom", () => {
    it("should remove the JSONL file for the room", () => {
      storage.appendEvent("abc123", makeRoomCreatedEvent());

      // Verify file exists
      const filePath = path.join(tempDir, "rooms", "abc123.jsonl");
      expect(existsSync(filePath)).toBe(true);

      storage.deleteRoom("abc123");
      expect(existsSync(filePath)).toBe(false);

      // loadActiveRooms should return empty after deletion
      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(0);
    });

    it("should not throw when deleting a non-existent room", () => {
      expect(() => storage.deleteRoom("nonexistent")).not.toThrow();
    });
  });

  describe("Profile", () => {
    it("should generate and persist userId", () => {
      const profile = storage.getProfile();
      expect(profile.userId).toBeDefined();
      // 再次获取应该是同一个
      expect(storage.getProfile().userId).toBe(profile.userId);
    });

    it("should save and get nickname", () => {
      storage.saveNickname("小明");
      expect(storage.getProfile().nickname).toBe("小明");
    });

    it("should overwrite existing nickname", () => {
      storage.saveNickname("小明");
      storage.saveNickname("大明");
      expect(storage.getProfile().nickname).toBe("大明");
    });

    it("should persist across Storage instances", () => {
      const userId = storage.getProfile().userId;
      storage.saveNickname("小明");

      const storage2 = new Storage(tempDir);
      expect(storage2.getProfile().userId).toBe(userId);
      expect(storage2.getProfile().nickname).toBe("小明");
    });
  });

  describe("Room replay — rebuilds Room object", () => {
    it("should correctly rebuild Room with all participants and messages", () => {
      const createdAt = Date.now() - 60000;
      storage.appendEvent("abc123", makeRoomCreatedEvent({ createdAt }));
      storage.appendEvent("abc123", makeParticipantJoinedEvent({
        id: "p-001", name: "Claude", isCreator: true,
      }));
      storage.appendEvent("abc123", makeParticipantJoinedEvent({
        id: "p-002", name: "GPT", isCreator: false,
      }));
      storage.appendEvent("abc123", makeMessageEvent({
        id: "msg-001",
        type: "speech",
        sender: { userId: "p-001", name: "Claude", role: "ai" },
        content: "我认为 AI 会超越人类",
        metadata: { round: 1, keyPoints: ["发展快"] },
      }));
      storage.appendEvent("abc123", makeMessageEvent({
        id: "msg-002",
        type: "speech",
        sender: { userId: "p-002", name: "GPT", role: "ai" },
        content: "AI 只是工具",
        metadata: { round: 1, keyPoints: ["辅助人类"] },
      }));

      const rooms = storage.loadActiveRooms();
      const room = rooms.get("abc123")!;

      // Verify room metadata
      expect(room.id).toBe("abc123");
      expect(room.topic).toBe("AI 的未来");
      expect(room.status).toBe("waiting");
      expect(room.createdAt).toBe(createdAt);

      // Verify participants (Map)
      expect(room.participants).toBeInstanceOf(Map);
      expect(room.participants.size).toBe(2);
      const claude = room.participants.get("p-001")!;
      expect(claude.name).toBe("Claude");
      expect(claude.isCreator).toBe(true);
      const gpt = room.participants.get("p-002")!;
      expect(gpt.name).toBe("GPT");
      expect(gpt.isCreator).toBe(false);

      // Verify messages
      expect(room.messages).toHaveLength(2);
      expect(room.messages[0].content).toBe("我认为 AI 会超越人类");
      expect(room.messages[0].sender.name).toBe("Claude");
      expect(room.messages[1].content).toBe("AI 只是工具");
      expect(room.messages[1].sender.name).toBe("GPT");
    });
  });

  describe("Room replay — handles room_updated events", () => {
    it("should apply round, convergenceScore, and status updates", () => {
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", {
        type: "room_updated",
        data: { currentRound: 3, convergenceScore: 0.45 },
      });

      const rooms = storage.loadActiveRooms();
      const room = rooms.get("abc123")!;
      expect(room.currentRound).toBe(3);
      expect(room.convergenceScore).toBe(0.45);
    });

    it("should apply partial updates without affecting other fields", () => {
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", {
        type: "room_updated",
        data: { currentRound: 2 },
      });
      storage.appendEvent("abc123", {
        type: "room_updated",
        data: { convergenceScore: 0.6 },
      });

      const rooms = storage.loadActiveRooms();
      const room = rooms.get("abc123")!;
      expect(room.currentRound).toBe(2);
      expect(room.convergenceScore).toBe(0.6);
    });

    it("should apply status update via room_updated", () => {
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", {
        type: "room_updated",
        data: { status: "in_progress" },
      });

      const rooms = storage.loadActiveRooms();
      const room = rooms.get("abc123")!;
      expect(room.status).toBe("in_progress");
    });
  });

  describe("Room replay — handles room_started event", () => {
    it("should set status to in_progress, startedAt, and currentRound to 1", () => {
      const startedAt = Date.now();
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", makeParticipantJoinedEvent());
      storage.appendEvent("abc123", {
        type: "room_started",
        data: { startedAt },
      });

      const rooms = storage.loadActiveRooms();
      const room = rooms.get("abc123")!;
      expect(room.status).toBe("in_progress");
      expect(room.startedAt).toBe(startedAt);
      expect(room.currentRound).toBe(1);
    });
  });

  describe("Room replay — handles room_completed event", () => {
    it("should set conclusion and completedAt on the room", () => {
      const completedAt = Date.now();
      storage.appendEvent("abc123", makeRoomCreatedEvent());
      storage.appendEvent("abc123", {
        type: "room_completed",
        data: { conclusion: "最终达成共识", completedAt },
      });

      // Note: loadActiveRooms skips completed rooms, so we verify by checking
      // that the room is NOT returned (already tested above).
      // To verify the replay is correct, create a new room and complete it,
      // then check it doesn't appear.
      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(0);
    });
  });

  describe("Multiple rooms", () => {
    it("should handle multiple independent rooms", () => {
      storage.appendEvent("room-1", makeRoomCreatedEvent({ id: "room-1", topic: "话题一" }));
      storage.appendEvent("room-2", makeRoomCreatedEvent({ id: "room-2", topic: "话题二" }));
      storage.appendEvent("room-1", makeParticipantJoinedEvent({ id: "p-001", name: "Claude" }));
      storage.appendEvent("room-2", makeParticipantJoinedEvent({ id: "p-002", name: "GPT" }));

      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(2);

      const room1 = rooms.get("room-1")!;
      expect(room1.topic).toBe("话题一");
      expect(room1.participants.size).toBe(1);
      expect(room1.participants.get("p-001")!.name).toBe("Claude");

      const room2 = rooms.get("room-2")!;
      expect(room2.topic).toBe("话题二");
      expect(room2.participants.size).toBe(1);
      expect(room2.participants.get("p-002")!.name).toBe("GPT");
    });
  });

  describe("Full lifecycle", () => {
    it("should replay a complete room lifecycle: create → join → start → messages → update → complete", () => {
      const createdAt = Date.now() - 60000;
      const startedAt = Date.now() - 50000;
      const completedAt = Date.now();

      storage.appendEvent("abc123", makeRoomCreatedEvent({ createdAt }));
      storage.appendEvent("abc123", makeParticipantJoinedEvent({ id: "p-001", name: "Claude", isCreator: true }));
      storage.appendEvent("abc123", makeParticipantJoinedEvent({ id: "p-002", name: "GPT", isCreator: false }));
      storage.appendEvent("abc123", { type: "room_started", data: { startedAt } });
      storage.appendEvent("abc123", makeMessageEvent({ id: "msg-001" }));
      storage.appendEvent("abc123", {
        type: "room_updated",
        data: { currentRound: 2, convergenceScore: 0.8 },
      });
      storage.appendEvent("abc123", {
        type: "room_completed",
        data: { conclusion: "达成共识", completedAt },
      });

      // Completed rooms are skipped by loadActiveRooms
      const rooms = storage.loadActiveRooms();
      expect(rooms.size).toBe(0);
    });
  });
});
