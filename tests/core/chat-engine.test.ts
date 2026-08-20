import { describe, it, expect, beforeEach } from "vitest";
import { ChatEngine } from "../../src/core/chat-engine.js";
import { RoomManager } from "../../src/core/room-manager.js";
import type { BattleEvent, PollOutput, SpectateOutput } from "../../src/core/types.js";

describe("ChatEngine", () => {
  let engine: ChatEngine;
  let roomManager: RoomManager;
  let roomId: string;
  let creatorId: string;
  let userId: string;

  beforeEach(() => {
    roomManager = new RoomManager();
    engine = new ChatEngine({ roomManager });

    const createResult = roomManager.createRoom({
      topic: "AI 的未来",
    });
    roomId = createResult.roomId;

    const join1 = roomManager.joinRoom({
      roomId,
      participantName: "Claude",
    });
    creatorId = join1.userId;

    const join2 = roomManager.joinRoom({
      roomId,
      participantName: "GPT",
    });
    userId = join2.userId;
  });

  // ============================================================
  // getPollData
  // ============================================================

  describe("getPollData", () => {
    it("应返回正确的轮询数据（消息、yourTurn 状态）", () => {
      const poll = engine.getPollData(roomId, creatorId);
      // 2 participants joined → 2 system messages
      expect(poll.messages).toHaveLength(2);
      expect(poll.messages.every((m) => m.type === "system")).toBe(true);
      expect(poll.roomStatus).toBe("in_progress");
      expect(poll.round).toBe(1);
      expect(poll.convergenceScore).toBe(0);
      expect(poll.conclusion).toBeUndefined();
    });

    it("after 参数应正确过滤消息", () => {
      // 先发两条消息
      engine.submitMessage({ roomId, userId: creatorId, content: "第一条" });
      engine.submitMessage({ roomId, userId, content: "第二条" });

      const room = roomManager.getRoom(roomId)!;
      const speechMessages = room.messages.filter((m) => m.type === "speech");
      const firstSpeechId = speechMessages[0].id;

      const poll = engine.getPollData(roomId, creatorId, firstSpeechId);
      expect(poll.messages).toHaveLength(1);
      expect(poll.messages[0].content).toBe("第二条");
    });

    it("in_progress 时 yourTurn 为 true", () => {
      const poll1 = engine.getPollData(roomId, creatorId);
      const poll2 = engine.getPollData(roomId, userId);

      expect(poll1.yourTurn).toBe(true);
      expect(poll2.yourTurn).toBe(true);
    });

    it("参与者被移除后 yourTurn 应为 false（客户端据此停止轮询）", () => {
      roomManager.getRoom(roomId)!.participants.delete(userId);
      const poll = engine.getPollData(roomId, userId);
      expect(poll.yourTurn).toBe(false);
      // 其他人不受影响
      expect(engine.getPollData(roomId, creatorId).yourTurn).toBe(true);
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() => engine.getPollData("nonexistent", "p1")).toThrow("roomNotFound");
    });
  });

  // ============================================================
  // submitMessage
  // ============================================================

  describe("submitMessage", () => {
    it("应存储消息并返回 nextAction=poll", () => {
      const result = engine.submitMessage({
        roomId,
        userId: creatorId,
        content: "我认为 AI 将在 10 年内超越人类",
        keyPoints: ["AI 发展速度快", "摩尔定律"],
      });
      expect(result.messageId).toBeDefined();
      expect(result.nextAction).toBe("poll");

      const room = roomManager.getRoom(roomId)!;
      // 2 system messages (join) + 1 speech message
      expect(room.messages).toHaveLength(3);
      const speechMessages = room.messages.filter((m) => m.type === "speech");
      expect(speechMessages).toHaveLength(1);
      expect(speechMessages[0].content).toBe("我认为 AI 将在 10 年内超越人类");
    });

    it("任何人都可以自由发言", () => {
      const result = engine.submitMessage({
        roomId,
        userId,
        content: "自由发言",
      });
      expect(result.messageId).toBeDefined();
      expect(result.nextAction).toBe("poll");
    });

    it("同一个人可以连续发言", () => {
      engine.submitMessage({ roomId, userId: creatorId, content: "第一条" });
      const result = engine.submitMessage({ roomId, userId: creatorId, content: "第二条" });
      expect(result.messageId).toBeDefined();
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() =>
        engine.submitMessage({
          roomId: "nonexistent",
          userId: "p1",
          content: "test",
        })
      ).toThrow("roomNotFound");
    });
  });

  // ============================================================
  // getMessagesAfter
  // ============================================================

  describe("getMessagesAfter", () => {
    it("无 afterId 时应返回全部消息", () => {
      engine.submitMessage({ roomId, userId: creatorId, content: "消息一" });
      engine.submitMessage({ roomId, userId, content: "消息二" });

      const messages = engine.getMessagesAfter(roomId);
      // 2 system messages (join) + 2 speech messages
      expect(messages).toHaveLength(4);
      const speechMessages = messages.filter((m) => m.type === "speech");
      expect(speechMessages).toHaveLength(2);
    });

    it("有 afterId 时应仅返回该 ID 之后的消息", () => {
      engine.submitMessage({ roomId, userId: creatorId, content: "消息一" });
      engine.submitMessage({ roomId, userId, content: "消息二" });
      engine.submitMessage({ roomId, userId: creatorId, content: "消息三" });

      const room = roomManager.getRoom(roomId)!;
      const speechMessages = room.messages.filter((m) => m.type === "speech");
      const firstSpeechId = speechMessages[0].id;

      const messages = engine.getMessagesAfter(roomId, firstSpeechId);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe("消息二");
      expect(messages[1].content).toBe("消息三");
    });

    it("afterId 不存在时应返回全部消息", () => {
      engine.submitMessage({ roomId, userId: creatorId, content: "消息一" });

      const messages = engine.getMessagesAfter(roomId, "nonexistent-id");
      // 2 system messages (join) + 1 speech message
      expect(messages).toHaveLength(3);
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() => engine.getMessagesAfter("nonexistent")).toThrow("roomNotFound");
    });
  });

  // ============================================================
  // getSpectateData
  // ============================================================

  describe("getSpectateData", () => {
    it("应返回房间信息（无 yourTurn 字段）", () => {
      engine.submitMessage({ roomId, userId: creatorId, content: "发言" });

      const spectate = engine.getSpectateData(roomId);
      expect(spectate.topic).toBe("AI 的未来");
      expect(spectate.participants).toHaveLength(2);
      expect(spectate.roomStatus).toBe("in_progress");
      // 2 system messages (join) + 1 speech message
      expect(spectate.messages).toHaveLength(3);
      expect(spectate.messages.filter((m) => m.type === "speech")).toHaveLength(1);
      expect(spectate.round).toBe(1);
      expect(spectate.convergenceScore).toBe(0);
      expect((spectate as Record<string, unknown>)["yourTurn"]).toBeUndefined();
    });

    it("支持 afterId 过滤消息", () => {
      engine.submitMessage({ roomId, userId: creatorId, content: "消息一" });
      engine.submitMessage({ roomId, userId, content: "消息二" });

      const room = roomManager.getRoom(roomId)!;
      const speechMessages = room.messages.filter((m) => m.type === "speech");
      const firstSpeechId = speechMessages[0].id;

      const spectate = engine.getSpectateData(roomId, firstSpeechId);
      expect(spectate.messages).toHaveLength(1);
      expect(spectate.messages[0].content).toBe("消息二");
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() => engine.getSpectateData("nonexistent")).toThrow("roomNotFound");
    });
  });

  // ============================================================
  // onEvent
  // ============================================================

  describe("onEvent", () => {
    it("应在新消息时触发 new_message 事件", () => {
      const events: BattleEvent[] = [];
      engine.onEvent((rid, event) => {
        if (rid === roomId) events.push(event);
      });

      engine.submitMessage({
        roomId,
        userId: creatorId,
        content: "测试消息",
      });

      const msgEvent = events.find((e) => e.type === "new_message");
      expect(msgEvent).toBeDefined();
    });
  });

  // ============================================================
  // addInterjection
  // ============================================================

  describe("addInterjection", () => {
    it("应添加人类插话到消息列表", () => {
      engine.addInterjection(roomId, "主持人", "请注意讨论方向");
      const room = roomManager.getRoom(roomId)!;
      const interjection = room.messages.find((m) => m.type === "interjection");
      expect(interjection).toBeDefined();
      expect(interjection!.content).toBe("请注意讨论方向");
      expect(interjection!.sender.role).toBe("human");
    });

    it("插话消息应触发 new_message 事件", () => {
      const events: BattleEvent[] = [];
      engine.onEvent((rid, event) => {
        if (rid === roomId) events.push(event);
      });

      engine.addInterjection(roomId, "主持人", "插话内容");

      const msgEvent = events.find((e) => e.type === "new_message");
      expect(msgEvent).toBeDefined();
    });

    it("房间不存在时应抛出 NotFoundError", () => {
      expect(() => engine.addInterjection("nonexistent", "主持人", "内容")).toThrow("roomNotFound");
    });
  });
});
