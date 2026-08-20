import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { DefaultConclusionGenerator } from "../../src/core/conclusion.js";
import { setLocale } from "../../src/core/i18n.js";
import type { Room, Message, Participant } from "../../src/core/types.js";

beforeAll(() => setLocale("en"));

/** 构造测试用 Room */
function createTestRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: "test-room",
    topic: "AI 是否会取代人类工作",
    status: "completed",
    config: {
      maxParticipants: 4,
      maxRounds: 10,
      convergenceThreshold: 0.75,
    },
    participants: new Map(),
    messages: [],
    currentRound: 3,
    convergenceScore: 0.8,
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

function createMessage(overrides: Partial<Message> & { sender: Message["sender"] }): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    roomId: "test-room",
    timestamp: Date.now(),
    type: "speech",
    content: "",
    metadata: { round: 1 },
    ...overrides,
  };
}

function createParticipants(...names: string[]): Map<string, Participant> {
  const map = new Map<string, Participant>();
  names.forEach((name, i) => {
    map.set(`p${i + 1}`, {
      id: `p${i + 1}`,
      name,
      joinedAt: Date.now(),
      isCreator: i === 0,
    });
  });
  return map;
}

describe("DefaultConclusionGenerator", () => {
  let generator: DefaultConclusionGenerator;

  beforeEach(() => {
    generator = new DefaultConclusionGenerator();
  });

  describe("正常讨论记录", () => {
    it("应生成包含所有章节的 Markdown", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 3,
        convergenceScore: 0.82,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "AI 在重复性工作上已经超过人类",
            metadata: { round: 1, keyPoints: ["AI擅长重复性工作", "部分岗位会被取代"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "人类的创造力不可替代",
            metadata: { round: 1, keyPoints: ["创造力不可替代", "AI只是工具"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "同意创造力重要，但简单工作确实在被替代",
            metadata: { round: 2, keyPoints: ["创造力很重要", "简单工作被替代"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "确实，重复性工作可能被取代",
            metadata: { round: 2, keyPoints: ["重复性工作可能被取代", "创造力不可替代"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "总结：AI取代部分工作，但创造性工作仍需人类",
            metadata: { round: 3, keyPoints: ["部分取代", "创造性工作需要人类"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "同意，AI和人类可以协作",
            metadata: { round: 3, keyPoints: ["部分取代", "人机协作"] },
          }),
        ],
      });

      const conclusion = generator.generate(room);

      // 检查各章节存在
      expect(conclusion).toContain("# Discussion Conclusion：AI 是否会取代人类工作");
      expect(conclusion).toContain("## Overview");
      expect(conclusion).toContain("## Positions");
      expect(conclusion).toContain("## Consensus Points");
      expect(conclusion).toContain("## Disagreements");
      expect(conclusion).toContain("## Discussion Summary");

      // 检查讨论概况内容
      expect(conclusion).toContain("Alice");
      expect(conclusion).toContain("Bob");
      expect(conclusion).toContain("3"); // 轮次
      expect(conclusion).toContain("0.82"); // 收敛分数
    });

    it("应正确分类共识和分歧", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "观点1",
            metadata: { round: 1, keyPoints: ["性能优化", "低延迟"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "观点2",
            metadata: { round: 1, keyPoints: ["安全性", "权限控制"] },
          }),
          // 最后一轮有共识也有分歧
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "最终观点",
            metadata: { round: 2, keyPoints: ["性能优化", "安全性"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "最终观点",
            metadata: { round: 2, keyPoints: ["安全性", "可扩展性"] },
          }),
        ],
      });

      const conclusion = generator.generate(room);
      // "安全性" 是共识（双方都提到）
      expect(conclusion).toContain("安全性");
      // 应有共识和分歧章节
      expect(conclusion).toContain("## Consensus Points");
      expect(conclusion).toContain("## Disagreements");
    });
  });

  describe("包含 summary 消息", () => {
    it("应在讨论摘要中包含 summary 类型消息", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我的观点",
            metadata: { round: 1, keyPoints: ["观点A"] },
          }),
          createMessage({
            type: "summary",
            sender: { name: "系统", role: "system" },
            content: "第一轮总结：Alice 提出了观点A",
            metadata: { round: 1 },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "补充观点",
            metadata: { round: 2, keyPoints: ["观点B"] },
          }),
          createMessage({
            type: "summary",
            sender: { name: "系统", role: "system" },
            content: "第二轮总结：Alice 补充了观点B",
            metadata: { round: 2 },
          }),
        ],
      });

      const conclusion = generator.generate(room);
      expect(conclusion).toContain("第一轮总结：Alice 提出了观点A");
      expect(conclusion).toContain("第二轮总结：Alice 补充了观点B");
    });
  });

  describe("边界情况", () => {
    it("空讨论 → 优雅处理", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice"),
        messages: [],
        currentRound: 0,
        convergenceScore: 0,
      });

      const conclusion = generator.generate(room);
      // 不崩溃，仍然生成结构
      expect(conclusion).toContain("# Discussion Conclusion");
      expect(conclusion).toContain("## Overview");
    });

    it("没有 keyPoints 的消息 → 不崩溃", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 1,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "随便聊聊",
            metadata: { round: 1 },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "也是随便聊",
            metadata: { round: 1 },
          }),
        ],
      });

      const conclusion = generator.generate(room);
      expect(conclusion).toContain("# Discussion Conclusion");
    });

    it("无参与者 → 不崩溃", () => {
      const room = createTestRoom({
        participants: new Map(),
        messages: [],
      });

      const conclusion = generator.generate(room);
      expect(conclusion).toContain("# Discussion Conclusion");
    });
  });
});
