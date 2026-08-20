import { describe, it, expect } from "vitest";
import type { Room, RoomStatus } from "../../src/core/types.js";

describe("types", () => {
  it("Room 类型可以正确构造", () => {
    const room: Room = {
      id: "test-room",
      topic: "测试主题",
      status: "waiting" as RoomStatus,
      config: {
        maxParticipants: 4,
        maxRounds: 10,
        convergenceThreshold: 0.75,
      },
      participants: new Map(),
      messages: [],
      currentRound: 0,
      convergenceScore: 0,
      createdAt: Date.now(),
    };
    expect(room.id).toBe("test-room");
    expect(room.status).toBe("waiting");
  });
});
