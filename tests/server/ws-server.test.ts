import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import http from "node:http";
import { WebSocket } from "ws";
import { SpectateServer } from "../../src/server/ws-server.js";
import type { BattleEvent, GetStatusOutput } from "../../src/core/types.js";

/** Collect messages from a WebSocket into an array, returns a getter */
function collectMessages(ws: WebSocket): { next: () => Promise<unknown> } {
  const messages: unknown[] = [];
  const waiters: Array<(msg: unknown) => void> = [];

  ws.on("message", (data) => {
    const parsed = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      waiter(parsed);
    } else {
      messages.push(parsed);
    }
  });

  return {
    next(): Promise<unknown> {
      const buffered = messages.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout waiting for message")), 3000);
        waiters.push((msg) => {
          clearTimeout(timeout);
          resolve(msg);
        });
      });
    },
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => reject(new Error("Timeout waiting for open")), 3000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

function waitForClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    ws.once("close", () => resolve());
  });
}

function createTestServer(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
  });
}

describe("SpectateServer", () => {
  let server: http.Server;
  let port: number;
  let spectateServer: SpectateServer;
  let clients: WebSocket[];
  let mockGetStatus: ReturnType<typeof vi.fn>;

  const mockStatus: GetStatusOutput = {
    status: "in_progress",
    topic: "AI Ethics",
    round: 1,
    convergenceScore: 0.3,
    participants: [{ id: "p-1", name: "Alice" }],
    messages: [],
  };

  beforeEach(async () => {
    clients = [];
    mockGetStatus = vi.fn().mockReturnValue(mockStatus);
    const result = await createTestServer();
    server = result.server;
    port = result.port;
    spectateServer = new SpectateServer(server, mockGetStatus);
  });

  afterEach(async () => {
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) {
        client.close();
      }
    }
    spectateServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** Connect and immediately start collecting messages (avoids race condition) */
  function connectClient(roomId: string) {
    const ws = new WebSocket(`ws://localhost:${port}/ws/spectate?roomId=${roomId}`);
    clients.push(ws);
    const collector = collectMessages(ws);
    return { ws, messages: collector };
  }

  // ==================== Connection ====================
  describe("Connection", () => {
    it("should accept connection and send initial status", async () => {
      const { ws, messages } = connectClient("room-1");
      await waitForOpen(ws);

      const msg = (await messages.next()) as { type: string; data: GetStatusOutput };
      expect(msg.type).toBe("initial_status");
      expect(msg.data.topic).toBe("AI Ethics");
      expect(mockGetStatus).toHaveBeenCalledWith({ roomId: "room-1" });
    });

    it("should reject connection without roomId", async () => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/spectate`);
      clients.push(ws);

      await waitForClose(ws);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it("should reject connection when getStatus throws (room not found)", async () => {
      mockGetStatus.mockImplementation(() => {
        throw new Error("Room not found");
      });

      const { ws } = connectClient("nonexistent");
      await waitForClose(ws);
      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  });

  // ==================== Broadcasting ====================
  describe("Broadcasting", () => {
    it("should broadcast event to room subscribers", async () => {
      const { ws, messages } = connectClient("room-1");
      await waitForOpen(ws);
      // Consume initial status
      await messages.next();

      const event: BattleEvent = {
        type: "new_message",
        message: {
          id: "msg-1",
          roomId: "room-1",
          timestamp: Date.now(),
          type: "speech",
          sender: { name: "Alice", role: "ai", userId: "p-1" },
          content: "Hello!",
          metadata: { round: 1 },
        },
      };

      spectateServer.broadcastToRoom("room-1", event);
      const received = await messages.next();
      expect(received).toEqual(event);
    });

    it("should not broadcast to clients in different rooms", async () => {
      const c1 = connectClient("room-1");
      const c2 = connectClient("room-2");
      await waitForOpen(c1.ws);
      await waitForOpen(c2.ws);
      await c1.messages.next();
      await c2.messages.next();

      const event: BattleEvent = { type: "convergence_update", score: 0.5 };
      spectateServer.broadcastToRoom("room-1", event);

      const received = await c1.messages.next();
      expect(received).toEqual(event);

      // ws2 should not receive — use a short timeout
      const noMsg = await Promise.race([
        c2.messages.next(),
        new Promise((resolve) => setTimeout(() => resolve("no_message"), 200)),
      ]);
      expect(noMsg).toBe("no_message");
    });

    it("should broadcast to multiple clients in same room", async () => {
      const c1 = connectClient("room-1");
      const c2 = connectClient("room-1");
      await waitForOpen(c1.ws);
      await waitForOpen(c2.ws);
      await c1.messages.next();
      await c2.messages.next();

      const event: BattleEvent = { type: "discussion_completed", conclusion: "Consensus reached" };
      spectateServer.broadcastToRoom("room-1", event);

      const [r1, r2] = await Promise.all([c1.messages.next(), c2.messages.next()]);
      expect(r1).toEqual(event);
      expect(r2).toEqual(event);
    });
  });

  // ==================== Disconnection cleanup ====================
  describe("Disconnection", () => {
    it("should clean up when client disconnects", async () => {
      const { ws, messages } = connectClient("room-1");
      await waitForOpen(ws);
      await messages.next();

      ws.close();
      await waitForClose(ws);

      // Broadcasting should not throw after cleanup
      const event: BattleEvent = { type: "convergence_update", score: 0.8 };
      expect(() => spectateServer.broadcastToRoom("room-1", event)).not.toThrow();
    });
  });
});
