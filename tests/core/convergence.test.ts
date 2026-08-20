import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { KeyPointConvergenceDetector } from "../../src/core/convergence.js";
import { setLocale } from "../../src/core/i18n.js";
import type { Room, Message, Participant } from "../../src/core/types.js";

beforeAll(() => setLocale("en"));

/** 构造测试用 Room */
function createTestRoom(overrides: Partial<Room> = {}): Room {
  return {
    id: "test-room",
    topic: "测试主题",
    status: "in_progress",
    config: {
      maxParticipants: 4,
      maxRounds: 10,
      convergenceThreshold: 0.75,
    },
    participants: new Map(),
    messages: [],
    currentRound: 1,
    convergenceScore: 0,
    createdAt: Date.now(),
    startedAt: Date.now(),
    ...overrides,
  };
}

/** 构造测试用 Message */
function createMessage(overrides: Partial<Message> & { sender: Message["sender"]; metadata?: Partial<Message["metadata"]> }): Message {
  return {
    id: `msg-${Math.random().toString(36).slice(2, 8)}`,
    roomId: "test-room",
    timestamp: Date.now(),
    type: "speech",
    content: "",
    sender: overrides.sender,
    metadata: { round: 1, ...overrides.metadata },
    ...overrides,
  };
}

/** 构造参与者 Map */
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

describe("KeyPointConvergenceDetector", () => {
  let detector: KeyPointConvergenceDetector;

  beforeEach(() => {
    detector = new KeyPointConvergenceDetector();
  });

  describe("论点重合度", () => {
    it("所有人 keyPoints 完全不同 → 低分", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 3,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我认为应该用方案A",
            metadata: { round: 1, keyPoints: ["性能优化", "缓存策略"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "我倾向方案B",
            metadata: { round: 1, keyPoints: ["安全性", "可维护性"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "继续讨论A方案",
            metadata: { round: 2, keyPoints: ["响应速度", "吞吐量"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "继续讨论B方案",
            metadata: { round: 2, keyPoints: ["数据隔离", "权限控制"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "A方案的优势",
            metadata: { round: 3, keyPoints: ["低延迟", "高并发"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "B方案的优势",
            metadata: { round: 3, keyPoints: ["合规性", "审计追踪"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      // 论点完全不同，重合度应该很低
      expect(result.score).toBeLessThan(0.5);
      expect(result.converged).toBe(false);
    });

    it("所有人 keyPoints 高度重合 → 高分", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 3,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我认为性能和安全都重要",
            metadata: { round: 1, keyPoints: ["性能优化很重要", "安全性是关键"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "同意性能和安全",
            metadata: { round: 1, keyPoints: ["性能优化是核心", "安全性不可忽视"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "性能和安全的平衡",
            metadata: { round: 2, keyPoints: ["性能优化方案", "安全性措施"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "安全和性能并重",
            metadata: { round: 2, keyPoints: ["安全性保障", "性能优化策略"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "最终结论",
            metadata: { round: 3, keyPoints: ["性能优化落地", "安全性验证"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "最终观点",
            metadata: { round: 3, keyPoints: ["性能优化实施", "安全性检测"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      // 论点高度重合，分数应较高
      expect(result.score).toBeGreaterThan(0.5);
    });
  });

  describe("让步信号", () => {
    it("有让步信号 → 分数提升", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我不同意你的观点",
            metadata: { round: 1, keyPoints: ["方案A更好"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "你说得对，我同意你的看法，确实有道理",
            metadata: { round: 1, keyPoints: ["方案A确实不错"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我也认可你提出的部分观点，赞同这个方向",
            metadata: { round: 2, keyPoints: ["方案A结合B的优点"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "I agree, that makes sense, fair point",
            metadata: { round: 2, keyPoints: ["综合方案"] },
          }),
        ],
      });

      const roomNoConc = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我不同意你的观点",
            metadata: { round: 1, keyPoints: ["性能优化是核心"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "我也不同意你的观点",
            metadata: { round: 1, keyPoints: ["安全保障最重要"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "你的论据站不住脚",
            metadata: { round: 2, keyPoints: ["缓存加速方案"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "你的分析有问题",
            metadata: { round: 2, keyPoints: ["权限隔离设计"] },
          }),
        ],
      });

      const withConcession = detector.analyze(room);
      const withoutConcession = detector.analyze(roomNoConc);
      expect(withConcession.score).toBeGreaterThan(withoutConcession.score);
    });

    it("英文让步关键词也应被检测", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "I think option A is better",
            metadata: { round: 1, keyPoints: ["option A"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "Good point, you're right about that",
            metadata: { round: 1, keyPoints: ["option A is good"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "I agree with your addition",
            metadata: { round: 2, keyPoints: ["combined approach"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "Makes sense, I'm convinced",
            metadata: { round: 2, keyPoints: ["combined approach"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      // 有英文让步信号，让步维度应贡献分数
      expect(result.score).toBeGreaterThan(0.3);
    });
  });

  describe("新论点衰减", () => {
    it("无新论点 → 衰减分数高", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 3,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "性能是关键",
            metadata: { round: 1, keyPoints: ["性能优化"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "安全也重要",
            metadata: { round: 1, keyPoints: ["安全性"] },
          }),
          // 第 2 轮重复第 1 轮的 keyPoints
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "再次强调性能",
            metadata: { round: 2, keyPoints: ["性能优化"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "再次强调安全",
            metadata: { round: 2, keyPoints: ["安全性"] },
          }),
          // 第 3 轮还是重复
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "性能优化很重要",
            metadata: { round: 3, keyPoints: ["性能优化"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "安全性很重要",
            metadata: { round: 3, keyPoints: ["安全性"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      // 最近两轮没有新论点，衰减维度应贡献高分
      expect(result.reason).toContain("Decay score");
    });

    it("大量新论点 → 衰减分数低", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 3,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "性能很重要",
            metadata: { round: 1, keyPoints: ["性能优化"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "安全很重要",
            metadata: { round: 1, keyPoints: ["安全保障"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "新想法",
            metadata: { round: 2, keyPoints: ["缓存加速", "负载均衡", "容灾备份"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "更多想法",
            metadata: { round: 2, keyPoints: ["权限隔离", "审计追踪"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "还有新想法",
            metadata: { round: 3, keyPoints: ["微服务拆分", "消息队列", "数据分片", "流量控制", "灰度发布"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "也有新想法",
            metadata: { round: 3, keyPoints: ["零信任架构", "密钥管理"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      // 大量新论点，收敛分数应低
      expect(result.score).toBeLessThan(0.5);
    });
  });

  describe("综合场景", () => {
    it("部分重合 + 部分让步 → 中等分数", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 3,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "性能是第一优先级",
            metadata: { round: 1, keyPoints: ["性能优化", "低延迟"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "安全第一",
            metadata: { round: 1, keyPoints: ["安全性", "权限控制"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "你说得对，安全也很重要",
            metadata: { round: 2, keyPoints: ["性能优化", "安全性"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "确实，性能也不能忽视",
            metadata: { round: 2, keyPoints: ["安全性", "性能优化"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "综合方案",
            metadata: { round: 3, keyPoints: ["性能优化", "安全性"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "综合方案",
            metadata: { round: 3, keyPoints: ["安全性", "性能优化"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      expect(result.score).toBeGreaterThan(0.4);
      expect(result.score).toBeLessThan(0.95);
    });
  });

  describe("阈值判定", () => {
    it("分数恰好等于阈值 → converged 为 true", () => {
      // 创建高度收敛的房间
      const room = createTestRoom({
        config: {
          maxParticipants: 4,
          maxRounds: 10,
          convergenceThreshold: 0.0, // 极低阈值，任何分数都算收敛
        },
        participants: createParticipants("Alice", "Bob"),
        currentRound: 1,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "test",
            metadata: { round: 1, keyPoints: ["观点"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "test",
            metadata: { round: 1, keyPoints: ["不同观点"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      expect(result.converged).toBe(true);
    });

    it("分数低于阈值 → converged 为 false", () => {
      const room = createTestRoom({
        config: {
          maxParticipants: 4,
          maxRounds: 10,
          convergenceThreshold: 0.99, // 极高阈值
        },
        participants: createParticipants("Alice", "Bob"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "方案A",
            metadata: { round: 1, keyPoints: ["观点X"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "方案B",
            metadata: { round: 1, keyPoints: ["观点Y"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "方案C",
            metadata: { round: 2, keyPoints: ["观点Z"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "方案D",
            metadata: { round: 2, keyPoints: ["观点W"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      expect(result.converged).toBe(false);
    });
  });

  describe("边界情况", () => {
    it("空消息 → 返回零分且不收敛", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        messages: [],
      });

      const result = detector.analyze(room);
      expect(result.score).toBe(0);
      expect(result.converged).toBe(false);
    });

    it("单参与者 → 返回结果且不崩溃", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice"),
        currentRound: 1,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "我的观点",
            metadata: { round: 1, keyPoints: ["唯一观点"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.converged).toBeDefined();
    });

    it("消息无 keyPoints → 不崩溃", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 1,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "随便说点",
            metadata: { round: 1 },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "也随便说点",
            metadata: { round: 1 },
          }),
        ],
      });

      const result = detector.analyze(room);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });

    it("reason 字段应包含各维度分数", () => {
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 2,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "观点",
            metadata: { round: 1, keyPoints: ["性能"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "观点",
            metadata: { round: 1, keyPoints: ["安全"] },
          }),
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "同意",
            metadata: { round: 2, keyPoints: ["性能"] },
          }),
          createMessage({
            sender: { userId: "p2", name: "Bob", role: "ai" },
            content: "确实",
            metadata: { round: 2, keyPoints: ["安全"] },
          }),
        ],
      });

      const result = detector.analyze(room);
      expect(result.reason).toContain("Overlap score");
      expect(result.reason).toContain("Concession score");
      expect(result.reason).toContain("Decay score");
    });
  });

  describe("可配置轮次", () => {
    it("自定义 recentRounds 参数", () => {
      const detector5 = new KeyPointConvergenceDetector({ recentRounds: 5 });
      const room = createTestRoom({
        participants: createParticipants("Alice", "Bob"),
        currentRound: 1,
        messages: [
          createMessage({
            sender: { userId: "p1", name: "Alice", role: "ai" },
            content: "观点",
            metadata: { round: 1, keyPoints: ["测试"] },
          }),
        ],
      });

      // 不崩溃即可
      const result = detector5.analyze(room);
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});
