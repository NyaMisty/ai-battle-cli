import type { Room, Message, ConvergenceDetector, ConvergenceResult } from "./types.js";
import { tokenize, keyPointsMatch } from "./text-utils.js";
import { t } from "./i18n.js";

export interface ConvergenceDetectorConfig {
  /** 最近 N 轮用于分析（默认 3） */
  recentRounds: number;
}

const DEFAULT_CONFIG: ConvergenceDetectorConfig = {
  recentRounds: 3,
};

/**
 * 基于关键论点的收敛检测器
 *
 * 三维度加权计算：
 * - 论点重合度 (0.5)
 * - 让步信号 (0.3)
 * - 新论点衰减 (0.2)
 */
export class KeyPointConvergenceDetector implements ConvergenceDetector {
  private config: ConvergenceDetectorConfig;

  constructor(config: Partial<ConvergenceDetectorConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  analyze(room: Room, _newKeyPoints?: string[]): ConvergenceResult {
    const { messages, participants } = room;

    if (messages.length === 0) {
      return { score: 0, converged: false, reason: t("noMessages") };
    }

    const overlapScore = this.calcKeyPointOverlap(room);
    const concessionScore = this.calcConcessionSignal(room);
    const decayScore = this.calcNewPointDecay(room);

    const finalScore = 0.5 * overlapScore + 0.3 * concessionScore + 0.2 * decayScore;
    const converged = finalScore >= room.config.convergenceThreshold;

    const reason = [
      converged ? t("converged") : t("notConverged"),
      `(${t("score")}: ${finalScore.toFixed(2)}, ${t("threshold")}: ${room.config.convergenceThreshold})`,
      `${t("overlapScore")}: ${overlapScore.toFixed(2)}`,
      `${t("concessionScore")}: ${concessionScore.toFixed(2)}`,
      `${t("decayScore")}: ${decayScore.toFixed(2)}`,
    ].join("，");

    return { score: finalScore, converged, reason };
  }

  // ============================================================
  // 维度一：论点重合度（权重 0.5）
  // ============================================================

  private calcKeyPointOverlap(room: Room): number {
    const { messages, participants } = room;
    const userIds = Array.from(participants.keys());

    if (userIds.length < 2) return 0;

    const currentRound = room.currentRound;
    const minRound = Math.max(1, currentRound - this.config.recentRounds + 1);

    // 收集每个参与者在最近 N 轮的所有 keyPoints
    const participantKeyPoints = new Map<string, string[]>();
    for (const pid of userIds) {
      participantKeyPoints.set(pid, []);
    }

    for (const msg of messages) {
      const pid = msg.sender.userId;
      const round = msg.metadata.round ?? 0;
      if (pid && participantKeyPoints.has(pid) && round >= minRound && msg.metadata.keyPoints) {
        participantKeyPoints.get(pid)!.push(...msg.metadata.keyPoints);
      }
    }

    // 两两计算重合率
    let totalOverlap = 0;
    let pairCount = 0;

    for (let i = 0; i < userIds.length; i++) {
      for (let j = i + 1; j < userIds.length; j++) {
        const kpA = participantKeyPoints.get(userIds[i])!;
        const kpB = participantKeyPoints.get(userIds[j])!;
        totalOverlap += this.calcPairOverlap(kpA, kpB);
        pairCount++;
      }
    }

    return pairCount > 0 ? totalOverlap / pairCount : 0;
  }

  /** 计算两个参与者的 keyPoints 重合率 */
  private calcPairOverlap(kpA: string[], kpB: string[]): number {
    if (kpA.length === 0 || kpB.length === 0) return 0;

    let matchCount = 0;
    const usedB = new Set<number>();

    for (const a of kpA) {
      for (let bi = 0; bi < kpB.length; bi++) {
        if (usedB.has(bi)) continue;
        if (keyPointsMatch(a, kpB[bi])) {
          matchCount++;
          usedB.add(bi);
          break;
        }
      }
    }

    return matchCount / Math.min(kpA.length, kpB.length);
  }

  // ============================================================
  // 维度二：让步信号（权重 0.3）
  // ============================================================

  private static readonly CONCESSION_PATTERNS_ZH = [
    "同意", "认可", "你说得对", "接受", "赞同", "有道理", "确实", "认同", "好的方案",
  ];

  private static readonly CONCESSION_PATTERNS_EN = [
    "agree", "good point", "you're right", "i accept", "fair point", "makes sense", "convinced",
  ];

  private calcConcessionSignal(room: Room): number {
    const { messages } = room;
    const currentRound = room.currentRound;

    // 最近 2 轮的消息
    const recentRound = Math.max(1, currentRound - 1);
    const recentMessages = messages.filter(
      (m) => (m.metadata.round ?? 0) >= recentRound && m.type === "speech",
    );

    if (recentMessages.length === 0) return 0;

    let concessionCount = 0;
    for (const msg of recentMessages) {
      if (this.hasConcessionSignal(msg.content)) {
        concessionCount++;
      }
    }

    return concessionCount / recentMessages.length;
  }

  private hasConcessionSignal(content: string): boolean {
    const lower = content.toLowerCase();
    for (const pat of KeyPointConvergenceDetector.CONCESSION_PATTERNS_ZH) {
      if (lower.includes(pat)) return true;
    }
    for (const pat of KeyPointConvergenceDetector.CONCESSION_PATTERNS_EN) {
      if (lower.includes(pat)) return true;
    }
    return false;
  }

  // ============================================================
  // 维度三：新论点衰减（权重 0.2）
  // ============================================================

  private calcNewPointDecay(room: Room): number {
    const { messages } = room;
    const currentRound = room.currentRound;

    if (currentRound < 1) return 0;

    // 按轮次收集 keyPoints
    const roundKeyPoints = new Map<number, string[]>();
    for (const msg of messages) {
      const round = msg.metadata.round ?? 0;
      if (round < 1) continue;
      if (!roundKeyPoints.has(round)) roundKeyPoints.set(round, []);
      if (msg.metadata.keyPoints) {
        roundKeyPoints.get(round)!.push(...msg.metadata.keyPoints);
      }
    }

    // 计算每轮新增不重复 keyPoint 数量
    const newPointCounts = new Map<number, number>();
    const allPreviousPoints: string[] = [];

    const rounds = Array.from(roundKeyPoints.keys()).sort((a, b) => a - b);
    for (const round of rounds) {
      const kps = roundKeyPoints.get(round)!;
      let newCount = 0;
      for (const kp of kps) {
        const isNew = !allPreviousPoints.some((prev) => keyPointsMatch(kp, prev));
        if (isNew) newCount++;
      }
      newPointCounts.set(round, newCount);
      allPreviousPoints.push(...kps);
    }

    // 判断衰减分数
    const lastRoundNew = newPointCounts.get(currentRound) ?? 0;
    const prevRoundNew = newPointCounts.get(currentRound - 1) ?? 0;

    if (lastRoundNew <= 1 && prevRoundNew <= 1) {
      return 1.0;
    }
    if (lastRoundNew <= 1) {
      return 0.7;
    }
    return Math.max(0, 1 - lastRoundNew / 5);
  }
}
