import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createHttpApi, type ApiContext } from "../../src/server/http-api.js";
import { NotFoundError, ConflictError, ForbiddenError, BadRequestError } from "../../src/core/errors.js";

function createMockContext(): ApiContext {
  return {
    createRoom: vi.fn().mockReturnValue({
      roomId: "room-1",
      topic: "AI Ethics",
      maxParticipants: 10,
      joinUrl: "http://localhost/battle/room-1",
      spectateUrl: "http://localhost/battle/room-1/eatmelon",
    }),
    joinRoom: vi.fn().mockReturnValue({
      userId: "p-1",
      topic: "AI Ethics",
      currentParticipants: [{ id: "p-1", name: "Alice" }],
      roomStatus: "in_progress",
    }),
    getStatus: vi.fn().mockReturnValue({
      status: "in_progress",
      topic: "AI Ethics",
      round: 1,
      convergenceScore: 0,
      participants: [{ id: "p-1", name: "Alice" }],
      messages: [],
    }),
    sendMessage: vi.fn().mockReturnValue({
      messageId: "msg-1",
      nextAction: "poll",
      convergenceScore: 0.3,
    }),
    poll: vi.fn().mockReturnValue({
      messages: [],
      yourTurn: true,
      roomStatus: "in_progress",
      round: 1,
      convergenceScore: 0,
    }),
    spectate: vi.fn().mockReturnValue({
      topic: "AI Ethics",
      messages: [],
      participants: [{ id: "p-1", name: "Alice" }],
      roomStatus: "in_progress",
      round: 1,
      convergenceScore: 0,
    }),
    addInterjection: vi.fn(),
    endRoom: vi.fn().mockReturnValue("Discussion concluded"),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
}

describe("HTTP API", () => {
  let ctx: ApiContext;
  let callback: ReturnType<ReturnType<typeof createHttpApi>["callback"]>;

  beforeEach(() => {
    ctx = createMockContext();
    callback = createHttpApi(ctx).callback();
  });

  // ==================== GET /health ====================
  describe("GET /health", () => {
    it("should return ok", async () => {
      const res = await request(callback).get("/battle/health");

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(200);
      expect(res.body.data.ok).toBe(true);
    });
  });

  // ==================== POST /rooms ====================
  describe("POST /rooms", () => {
    it("should create a room with valid input", async () => {
      const res = await request(callback)
        .post("/battle/rooms")
        .send({ topic: "AI Ethics" });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(200);
      expect(res.body.data.roomId).toBe("room-1");
      expect(res.body.data.spectateUrl).toContain("eatmelon");
      expect(ctx.createRoom).toHaveBeenCalledWith({ topic: "AI Ethics" });
    });

    it("should pass optional parameters", async () => {
      await request(callback)
        .post("/battle/rooms")
        .send({ topic: "T", maxParticipants: 6, maxRounds: 20 });

      expect(ctx.createRoom).toHaveBeenCalledWith({ topic: "T", maxParticipants: 6, maxRounds: 20 });
    });

    it("should create room without topic", async () => {
      const res = await request(callback)
        .post("/battle/rooms")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(200);
    });

    it("should return 400 when topic exceeds max length", async () => {
      const res = await request(callback)
        .post("/battle/rooms")
        .send({ topic: "a".repeat(201) });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(400);
      expect(res.body.message).toContain("max length");
    });
  });

  // ==================== POST /:roomId/join ====================
  describe("POST /:roomId/join", () => {
    it("should join a room with valid input", async () => {
      const res = await request(callback)
        .post("/battle/room-1/join")
        .send({ participantName: "Alice" });

      expect(res.status).toBe(200);
      expect(res.body.data.userId).toBe("p-1");
      expect(ctx.joinRoom).toHaveBeenCalledWith({ roomId: "room-1", participantName: "Alice" });
    });

    it("should return messages from getStatus in join response", async () => {
      const mockMessages = [{ id: "msg-0", content: "Hello" }];
      vi.mocked(ctx.getStatus).mockReturnValue({
        status: "in_progress",
        topic: "AI Ethics",
        round: 1,
        convergenceScore: 0,
        participants: [],
        messages: mockMessages as any,
      });

      const res = await request(callback)
        .post("/battle/room-1/join")
        .send({ participantName: "Alice" });

      expect(res.status).toBe(200);
      expect(res.body.data.messages).toEqual(mockMessages);
    });

    it("should join without participantName", async () => {
      const res = await request(callback)
        .post("/battle/room-1/join")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.userId).toBeDefined();
    });

    it("should return 404 when room not found", async () => {
      vi.mocked(ctx.joinRoom).mockImplementation(() => { throw new NotFoundError(); });

      const res = await request(callback)
        .post("/battle/nonexistent/join")
        .send({ participantName: "Alice" });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(404);
    });

    it("should return 409 when room is full", async () => {
      vi.mocked(ctx.joinRoom).mockImplementation(() => { throw new ConflictError("房间已满"); });

      const res = await request(callback)
        .post("/battle/room-1/join")
        .send({ participantName: "Alice" });

      expect(res.status).toBe(409);
      expect(res.body.message).toBe("房间已满");
    });

    it("should return 400 when participantName exceeds max length", async () => {
      const res = await request(callback)
        .post("/battle/room-1/join")
        .send({ participantName: "a".repeat(51) });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("max length");
    });
  });

  // ==================== GET /:roomId/status ====================
  describe("GET /:roomId/status", () => {
    it("should return room status", async () => {
      const res = await request(callback)
        .get("/battle/room-1/status");

      expect(res.status).toBe(200);
      expect(res.body.data.topic).toBe("AI Ethics");
      expect(res.body.data.participants).toHaveLength(1);
      expect(ctx.getStatus).toHaveBeenCalledWith({ roomId: "room-1" });
    });

    it("should return error when room not found", async () => {
      vi.mocked(ctx.getStatus).mockImplementation(() => { throw new NotFoundError(); });

      const res = await request(callback)
        .get("/battle/nonexistent/status");

      expect(res.status).toBe(404);
    });
  });

  // ==================== GET /:roomId/messages ====================
  describe("GET /:roomId/messages", () => {
    it("should poll for new messages", async () => {
      const res = await request(callback)
        .get("/battle/room-1/messages")
        .query({ userId: "p-1" });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(200);
      expect(res.body.data.yourTurn).toBe(true);
      expect(res.body.data.roomStatus).toBe("in_progress");
      expect(ctx.poll).toHaveBeenCalledWith({ roomId: "room-1", userId: "p-1", after: undefined });
    });

    it("should pass after parameter", async () => {
      await request(callback)
        .get("/battle/room-1/messages")
        .query({ userId: "p-1", after: "msg-5" });

      expect(ctx.poll).toHaveBeenCalledWith({ roomId: "room-1", userId: "p-1", after: "msg-5" });
    });

    it("should return 400 when userId is missing", async () => {
      const res = await request(callback)
        .get("/battle/room-1/messages");

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(400);
      expect(res.body.message).toContain("userId");
    });

    it("should return error when room not found", async () => {
      vi.mocked(ctx.poll).mockImplementation(() => { throw new NotFoundError(); });

      const res = await request(callback)
        .get("/battle/nonexistent/messages")
        .query({ userId: "p-1" });

      expect(res.status).toBe(404);
    });
  });

  // ==================== GET /:roomId/spectate (SSE) ====================
  describe("GET /:roomId/spectate", () => {
    it("should return 404 when room not found", async () => {
      vi.mocked(ctx.getStatus).mockImplementation(() => { throw new NotFoundError(); });

      const res = await request(callback)
        .get("/battle/nonexistent/spectate");

      expect(res.status).toBe(404);
    });

    // SSE streaming tests require a real HTTP server, not supertest.
    // The 404 test above covers the validation path.
    // SSE behavior is tested via integration tests.
  });

  // ==================== POST /:roomId/messages ====================
  describe("POST /:roomId/messages", () => {
    it("should send a message", async () => {
      const res = await request(callback)
        .post("/battle/room-1/messages")
        .send({ userId: "p-1", content: "Hello world" });

      expect(res.status).toBe(200);
      expect(res.body.data.messageId).toBe("msg-1");
      expect(ctx.sendMessage).toHaveBeenCalledWith({ roomId: "room-1", userId: "p-1", content: "Hello world" });
    });

    it("should pass optional keyPoints", async () => {
      await request(callback)
        .post("/battle/room-1/messages")
        .send({ userId: "p-1", content: "Hello", keyPoints: ["point1"] });

      expect(ctx.sendMessage).toHaveBeenCalledWith({ roomId: "room-1", userId: "p-1", content: "Hello", keyPoints: ["point1"] });
    });

    it("should return 400 when userId is missing", async () => {
      const res = await request(callback)
        .post("/battle/room-1/messages")
        .send({ content: "Hello" });

      expect(res.status).toBe(400);
    });

    it("should return 400 when content is missing", async () => {
      const res = await request(callback)
        .post("/battle/room-1/messages")
        .send({ userId: "p-1" });

      expect(res.status).toBe(400);
    });

    it("should return 400 when content exceeds max length", async () => {
      const res = await request(callback)
        .post("/battle/room-1/messages")
        .send({ userId: "p-1", content: "a".repeat(10001) });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("max length");
    });
  });

  // ==================== POST /:roomId/interjection ====================
  describe("POST /:roomId/interjection", () => {
    it("should add an interjection", async () => {
      const res = await request(callback)
        .post("/battle/room-1/interjection")
        .send({ userId: "Human", content: "What about privacy?" });

      expect(res.status).toBe(200);
      expect(res.body.code).toBe(200);
      expect(ctx.addInterjection).toHaveBeenCalledWith("room-1", "Human", "What about privacy?");
    });

    it("should return 400 when userId is missing", async () => {
      const res = await request(callback)
        .post("/battle/room-1/interjection")
        .send({ content: "Hello" });

      expect(res.status).toBe(400);
    });

    it("should return 400 when content is missing", async () => {
      const res = await request(callback)
        .post("/battle/room-1/interjection")
        .send({ userId: "Human" });

      expect(res.status).toBe(400);
    });

    it("should return 400 when content exceeds max length", async () => {
      const res = await request(callback)
        .post("/battle/room-1/interjection")
        .send({ userId: "Human", content: "a".repeat(10001) });

      expect(res.status).toBe(400);
      expect(res.body.message).toContain("max length");
    });
  });

  // ==================== POST /:roomId/end ====================
  describe("POST /:roomId/end", () => {
    it("should end a room", async () => {
      const res = await request(callback)
        .post("/battle/room-1/end")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body.data.conclusion).toBe("Discussion concluded");
      expect(ctx.endRoom).toHaveBeenCalledWith("room-1");
    });
  });

  // ==================== GET /:roomId/eatmelon ====================
  describe("GET /:roomId/eatmelon", () => {
    it("should return HTML page", async () => {
      const res = await request(callback).get("/battle/room-1/eatmelon");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toContain("text/html");
    });
  });

  // ==================== Error handling ====================
  describe("Error handling", () => {
    it("should map BattleError to correct status code (404)", async () => {
      vi.mocked(ctx.getStatus).mockImplementation(() => { throw new NotFoundError(); });

      const res = await request(callback).get("/battle/room-1/status");

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(404);
    });

    it("should map BattleError to correct status code (409)", async () => {
      vi.mocked(ctx.joinRoom).mockImplementation(() => { throw new ConflictError("房间已满"); });

      const res = await request(callback)
        .post("/battle/room-1/join")
        .send({ participantName: "Alice" });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe(409);
    });

    it("should map BattleError to correct status code (403)", async () => {
      vi.mocked(ctx.endRoom).mockImplementation(() => { throw new ForbiddenError(); });

      const res = await request(callback)
        .post("/battle/room-1/end")
        .send({});

      expect(res.status).toBe(403);
      expect(res.body.code).toBe(403);
    });

    it("should map BattleError to correct status code (400)", async () => {
      vi.mocked(ctx.sendMessage).mockImplementation(() => { throw new BadRequestError("参数错误"); });

      const res = await request(callback)
        .post("/battle/room-1/messages")
        .send({ userId: "p-1", content: "test" });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe(400);
    });

    it("should return 500 with error message when non-BattleError throws", async () => {
      vi.mocked(ctx.createRoom).mockImplementation(() => { throw new Error("Internal failure"); });

      const res = await request(callback)
        .post("/battle/rooms")
        .send({ topic: "Test" });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe(500);
      expect(res.body.message).toBe("Internal failure");
    });
  });

  // ==================== 404 for unknown routes ====================
  describe("404 handler", () => {
    it("should return 404 for unknown routes", async () => {
      const res = await request(callback).get("/battle/unknown/route/here");

      expect(res.status).toBe(404);
      expect(res.body.code).toBe(404);
      expect(res.body.message).toBe("Not found");
    });

    it("should return 404 for routes outside /battle prefix", async () => {
      const res = await request(callback).get("/some/other/path");

      expect(res.status).toBe(404);
    });
  });

  // ==================== CORS ====================
  describe("CORS", () => {
    it("should include CORS headers", async () => {
      const res = await request(callback)
        .get("/battle/room-1/status")
        .set("Origin", "http://localhost:3001");

      expect(res.headers["access-control-allow-origin"]).toBeDefined();
    });
  });
});
