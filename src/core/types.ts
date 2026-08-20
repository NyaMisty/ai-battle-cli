// ============================================================
// AI Battle — 核心类型定义
// ============================================================

/** 房间状态（异常终止/超时同样落为 completed，结论文本说明原因；数据清理靠 rm 手动删除） */
export type RoomStatus = "waiting" | "in_progress" | "completed";

/** 消息类型 */
export type MessageType = "speech" | "interjection" | "system" | "summary" | "conclusion";

/** 消息发送者角色 */
export type SenderRole = "ai" | "human" | "system";

/** 下一步动作 */
export type NextAction = "poll" | "completed";

// ============================================================
// 核心数据模型
// ============================================================

/** 参与者 */
export interface Participant {
  id: string;
  /** 用户昵称 */
  name: string;
  /** AI 模型名称 */
  modelName?: string;
  joinedAt: number;
  isCreator: boolean;
  /** 最后 poll 时间 */
  lastActiveAt: number;
  /** 最后发消息时间 */
  lastSendAt: number;
}

/** 消息发送者 */
export interface MessageSender {
  userId?: string;
  name: string;
  role: SenderRole;
}

/** 消息元数据 */
export interface MessageMetadata {
  round?: number;
  keyPoints?: string[];
}

/** 消息 */
export interface Message {
  id: string;
  roomId: string;
  timestamp: number;
  type: MessageType;
  sender: MessageSender;
  content: string;
  metadata: MessageMetadata;
}

/** 房间配置 */
export interface RoomConfig {
  maxParticipants: number;
  maxRounds: number;
  convergenceThreshold: number;
}

/** 房间 */
export interface Room {
  id: string;
  topic: string;
  status: RoomStatus;
  config: RoomConfig;
  participants: Map<string, Participant>;
  messages: Message[];
  currentRound: number;
  convergenceScore: number;
  conclusion?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
}

// ============================================================
// CLI / HTTP API 输入输出类型
// ============================================================

/** ai-battle create 输入 */
export interface CreateRoomInput {
  topic?: string;
  maxParticipants?: number;
  maxRounds?: number;
}

/** ai-battle create 输出 */
export interface CreateRoomOutput {
  roomId: string;
  topic: string;
  maxParticipants: number;
  joinUrl: string;
  spectateUrl: string;
}

/** ai-battle join / POST /:roomId/join 输入 */
export interface JoinRoomInput {
  roomId: string;
  /** 不传则服务端生成全新 id（同一用户的多个 agent 各自独立） */
  userId?: string;
  participantName?: string;
  modelName?: string;
}

/** ai-battle join 输出 */
export interface JoinRoomOutput {
  userId: string;
  topic: string;
  currentParticipants: Array<{ id: string; name: string }>;
  roomStatus: RoomStatus;
}

/** ai-battle send 输入 */
export interface SendMessageInput {
  roomId: string;
  userId: string;
  content: string;
  keyPoints?: string[];
}

/** ai-battle send 输出 */
export interface SendMessageOutput {
  messageId: string;
  nextAction: NextAction;
  convergenceScore?: number;
  converged?: boolean;
}

/** ai-battle poll 输出 */
export interface PollOutput {
  messages: Message[];
  yourTurn: boolean;
  roomStatus: RoomStatus;
  round: number;
  convergenceScore: number;
  conclusion?: string;
}

/** ai-battle status 输出 */
export interface GetStatusOutput {
  status: RoomStatus;
  topic: string;
  round: number;
  convergenceScore: number;
  participants: Array<{ id: string; name: string }>;
  messages: Message[];
  conclusion?: string;
  createdAt: number;
}

/** 观战（spectate.ejs / SSE）输出 */
export interface SpectateOutput {
  topic: string;
  messages: Message[];
  participants: Array<{ id: string; name: string }>;
  roomStatus: RoomStatus;
  round: number;
  convergenceScore: number;
  conclusion?: string;
}

// ============================================================
// 收敛检测接口
// ============================================================

/** 收敛分析结果 */
export interface ConvergenceResult {
  score: number;
  converged: boolean;
  reason: string;
}

/** 收敛检测器接口 */
export interface ConvergenceDetector {
  analyze(room: Room, newKeyPoints?: string[]): ConvergenceResult;
}

/** 结论生成器接口 */
export interface ConclusionGenerator {
  generate(room: Room): string;
}

// ============================================================
// 事件类型（用于 WebSocket/SSE 推送）
// ============================================================

export type BattleEvent =
  | { type: "participant_joined"; participant: { id: string; name: string } }
  | { type: "participant_left"; participant: { id: string; name: string } }
  | { type: "new_message"; message: Message }
  | { type: "convergence_update"; score: number }
  | { type: "discussion_completed"; conclusion: string };
