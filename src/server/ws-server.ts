import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { BattleEvent, GetStatusOutput } from "../core/types.js";

interface ClientInfo {
  ws: WebSocket;
  roomId: string;
  alive: boolean;
}

export class SpectateServer {
  private wss: WebSocketServer;
  private clients = new Set<ClientInfo>();
  private heartbeatInterval: ReturnType<typeof setInterval>;
  private getStatus: (input: { roomId: string }) => GetStatusOutput;

  /** 当前观战连接数（server 空闲退出判断用：有观众就不退） */
  get connectionCount(): number {
    return this.clients.size;
  }

  constructor(server: http.Server, getStatus: (input: { roomId: string }) => GetStatusOutput) {
    this.getStatus = getStatus;

    this.wss = new WebSocketServer({
      server,
      path: "/ws/spectate",
    });

    this.wss.on("connection", (ws, req) => {
      this.handleConnection(ws, req);
    });

    // Heartbeat: ping every 30s, close if no pong within 10s
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients) {
        if (!client.alive) {
          client.ws.terminate();
          this.clients.delete(client);
          continue;
        }
        client.alive = false;
        client.ws.ping();
      }
    }, 30_000);
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Parse roomId from query string
    const urlStr = req.url ?? "";
    const queryStr = urlStr.split("?")[1] ?? "";
    const params = new URLSearchParams(queryStr);
    const roomId = params.get("roomId");

    if (!roomId) {
      ws.close(4000, "roomId is required");
      return;
    }

    // Validate room exists by fetching status
    let status: GetStatusOutput;
    try {
      status = this.getStatus({ roomId });
    } catch {
      ws.close(4004, "Room not found");
      return;
    }

    const client: ClientInfo = { ws, roomId, alive: true };
    this.clients.add(client);

    // Send initial status
    ws.send(JSON.stringify({ type: "initial_status", data: status }));

    ws.on("pong", () => {
      client.alive = true;
    });

    ws.on("close", () => {
      this.clients.delete(client);
    });

    ws.on("error", () => {
      this.clients.delete(client);
    });
  }

  /** 向指定房间的所有观战者广播事件 */
  broadcastToRoom(roomId: string, event: BattleEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.clients) {
      if (client.roomId === roomId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  /** 关闭服务 */
  close(): void {
    clearInterval(this.heartbeatInterval);
    for (const client of this.clients) {
      client.ws.terminate();
    }
    this.clients.clear();
    this.wss.close();
  }
}
