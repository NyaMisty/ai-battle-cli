import { describe, it, expect, beforeEach } from "vitest";
import { RoomManager } from "../../src/core/room-manager.js";
import { NotFoundError, ConflictError, ForbiddenError } from "../../src/core/errors.js";
import type { Room } from "../../src/core/types.js";

describe("RoomManager", () => {
  let manager: RoomManager;

  beforeEach(() => {
    manager = new RoomManager();
  });

  describe("createRoom", () => {
    it("应创建房间并返回 roomId 和 URL", () => {
      const result = manager.createRoom({
        topic: "AI 的未来",
      });
      expect(result.roomId).toBeDefined();
      expect(result.joinUrl).toContain(result.roomId);
      expect(result.spectateUrl).toContain(result.roomId);
    });

    it("应使用默认配置", () => {
      const result = manager.createRoom({
        topic: "测试主题",
      });
      const room = manager.getRoom(result.roomId);
      expect(room).toBeDefined();
      expect(room!.config.maxParticipants).toBe(10);
      expect(room!.config.maxRounds).toBe(Infinity);
      expect(room!.config.convergenceThreshold).toBe(0.75);
    });

    it("应支持自定义配置", () => {
      const result = manager.createRoom({
        topic: "测试主题",
        maxParticipants: 8,
        maxRounds: 20,
      });
      const room = manager.getRoom(result.roomId);
      expect(room!.config.maxParticipants).toBe(8);
      expect(room!.config.maxRounds).toBe(20);
    });

    it("应初始化正确的房间状态", () => {
      const result = manager.createRoom({
        topic: "测试",
      });
      const room = manager.getRoom(result.roomId);
      expect(room!.status).toBe("waiting");
      expect(room!.currentRound).toBe(0);
      expect(room!.convergenceScore).toBe(0);
      expect(room!.messages).toEqual([]);
      expect(room!.participants.size).toBe(0);
    });

    it("每次创建的 roomId 应唯一", () => {
      const r1 = manager.createRoom({ topic: "A" });
      const r2 = manager.createRoom({ topic: "B" });
      expect(r1.roomId).not.toBe(r2.roomId);
    });
  });

  describe("joinRoom", () => {
    let roomId: string;

    beforeEach(() => {
      const result = manager.createRoom({
        topic: "测试",
      });
      roomId = result.roomId;
    });

    it("应成功加入房间", () => {
      const result = manager.joinRoom({
        roomId,
        participantName: "Claude",
      });
      expect(result.userId).toBeDefined();
      expect(result.roomStatus).toBe("in_progress");
      expect(result.currentParticipants).toHaveLength(1);
      expect(result.currentParticipants[0].name).toBe("Claude");
    });

    it("第一个加入者应被标记为创建者", () => {
      const result = manager.joinRoom({
        roomId,
        participantName: "Creator",
      });
      const room = manager.getRoom(roomId)!;
      const participant = room.participants.get(result.userId)!;
      expect(participant.isCreator).toBe(true);
    });

    it("后续加入者不应被标记为创建者", () => {
      manager.joinRoom({ roomId, participantName: "First" });
      const result = manager.joinRoom({ roomId, participantName: "Second" });
      const room = manager.getRoom(roomId)!;
      const participant = room.participants.get(result.userId)!;
      expect(participant.isCreator).toBe(false);
    });

    it("多人加入应返回全部参与者", () => {
      manager.joinRoom({ roomId, participantName: "A" });
      const result = manager.joinRoom({ roomId, participantName: "B" });
      expect(result.currentParticipants).toHaveLength(2);
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() =>
        manager.joinRoom({ roomId: "nonexistent", participantName: "X" })
      ).toThrow(NotFoundError);
    });

    it("房间已满时应抛出 ConflictError", () => {
      // 创建最大2人的房间
      const { roomId: smallRoom } = manager.createRoom({
        topic: "小房间",
        maxParticipants: 2,
      });
      manager.joinRoom({ roomId: smallRoom, participantName: "A" });
      manager.joinRoom({ roomId: smallRoom, participantName: "B" });
      expect(() =>
        manager.joinRoom({ roomId: smallRoom, participantName: "C" })
      ).toThrow(ConflictError);
    });

    it("加入即自动开始", () => {
      const result = manager.joinRoom({ roomId, participantName: "First" });
      const room = manager.getRoom(roomId)!;
      expect(room.status).toBe("in_progress");
      expect(room.startedAt).toBeDefined();
      expect(room.currentRound).toBe(1);
    });

    it("同一用户两个 agent 各自匿名 join 应得到独立身份（互不干扰）", () => {
      const agentA = manager.joinRoom({ roomId, participantName: "Misty", modelName: "claude" });
      const agentB = manager.joinRoom({ roomId, participantName: "Misty", modelName: "gemini" });
      expect(agentA.userId).toBeDefined();
      expect(agentB.userId).toBeDefined();
      expect(agentA.userId).not.toBe(agentB.userId);

      const room = manager.getRoom(roomId)!;
      expect(room.participants.size).toBe(2);
      const names = Array.from(room.participants.values()).map((p) => p.name);
      expect(names).toEqual(["Misty", "Misty"]);
    });

    it("带相同 userId 重复 join 视为重连：不重复加人、不重复系统消息", () => {
      const first = manager.joinRoom({ roomId, participantName: "A" });
      const room = manager.getRoom(roomId)!;
      const msgCountAfterJoin = room.messages.length;

      const again = manager.joinRoom({ roomId, userId: first.userId, modelName: "opus" });
      expect(again.userId).toBe(first.userId);
      expect(room.participants.size).toBe(1);
      expect(room.messages.length).toBe(msgCountAfterJoin); // 没有新的 "xxx 加入了讨论"

      const p = room.participants.get(first.userId)!;
      expect(p.modelName).toBe("opus");
    });

    it("重连不应被房间已满拦截", () => {
      const { roomId: smallRoom } = manager.createRoom({ topic: "小房间", maxParticipants: 1 });
      const a = manager.joinRoom({ roomId: smallRoom, participantName: "A" });
      // 房间已满，但老参与者重连应成功
      const re = manager.joinRoom({ roomId: smallRoom, userId: a.userId });
      expect(re.userId).toBe(a.userId);
      // 新人仍应被拒
      expect(() => manager.joinRoom({ roomId: smallRoom, participantName: "B" })).toThrow(ConflictError);
    });
  });

  describe("getRoom", () => {
    it("应返回已存在的房间", () => {
      const { roomId } = manager.createRoom({
        topic: "测试",
      });
      expect(manager.getRoom(roomId)).toBeDefined();
    });

    it("房间不存在时应返回 undefined", () => {
      expect(manager.getRoom("nonexistent")).toBeUndefined();
    });
  });

  describe("completeRoom", () => {
    it("应标记房间为已完成", () => {
      const { roomId } = manager.createRoom({
        topic: "测试",
      });
      manager.joinRoom({ roomId, participantName: "A" });
      manager.completeRoom(roomId, "最终结论");
      const room = manager.getRoom(roomId)!;
      expect(room.status).toBe("completed");
      expect(room.conclusion).toBe("最终结论");
      expect(room.completedAt).toBeDefined();
    });
  });

  describe("closeRoom", () => {
    it("关闭房间（数据保留）", () => {
      const { roomId } = manager.createRoom({
        topic: "测试",
      });
      manager.joinRoom({ roomId, participantName: "Creator" });
      manager.closeRoom(roomId, "Test close");
      const room = manager.getRoom(roomId);
      expect(room).toBeDefined();
      expect(room!.status).toBe("closed");
      expect(room!.completedAt).toBeDefined();
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() => manager.closeRoom("nonexistent", "reason")).toThrow(NotFoundError);
    });
  });
});
