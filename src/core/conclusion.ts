import type { Room, Message, ConclusionGenerator } from "./types.js";
import { keyPointsMatch } from "./text-utils.js";
import { t } from "./i18n.js";

/**
 * 默认结论生成器
 * 从讨论记录中提取并生成 Markdown 格式的结论
 */
export class DefaultConclusionGenerator implements ConclusionGenerator {
  generate(room: Room): string {
    const sections: string[] = [];

    sections.push(this.generateTitle(room));
    sections.push(this.generateOverview(room));
    sections.push(this.generateStances(room));
    sections.push(this.generateConsensus(room));
    sections.push(this.generateDivergence(room));
    sections.push(this.generateSummary(room));

    return sections.join("\n\n");
  }

  private generateTitle(room: Room): string {
    return `# ${t("conclusionTitle")}：${room.topic}`;
  }

  private generateOverview(room: Room): string {
    const participantNames = Array.from(room.participants.values())
      .map((p) => p.name)
      .join("、");

    return [
      `## ${t("overview")}`,
      `- ${t("participants")}：${participantNames || t("none")}`,
      `- ${t("totalRounds")}：${room.currentRound}`,
      `- ${t("convergenceScore")}：${room.convergenceScore}`,
    ].join("\n");
  }

  private generateStances(room: Room): string {
    const lines = [`## ${t("positions")}`];
    const participants = Array.from(room.participants.values());

    if (participants.length === 0) {
      lines.push(t("noParticipants"));
    } else {
      for (const p of participants) {
        lines.push(`### ${p.name}`);
        lines.push(`- ${t("noSpecificProposal")}`);
      }
    }

    return lines.join("\n");
  }

  private generateConsensus(room: Room): string {
    const lines = [`## ${t("consensus")}`];
    const { consensusPoints } = this.extractConsensusAndDivergence(room);

    if (consensusPoints.length === 0) {
      lines.push(t("noConsensus"));
    } else {
      for (const point of consensusPoints) {
        lines.push(`- ${point}`);
      }
    }

    return lines.join("\n");
  }

  private generateDivergence(room: Room): string {
    const lines = [`## ${t("disagreements")}`];
    const { divergencePoints } = this.extractConsensusAndDivergence(room);

    if (divergencePoints.length === 0) {
      lines.push(t("noDisagreements"));
    } else {
      for (const point of divergencePoints) {
        lines.push(`- ${point}`);
      }
    }

    return lines.join("\n");
  }

  private generateSummary(room: Room): string {
    const lines = [`## ${t("discussionSummary")}`];
    const summaryMessages = room.messages.filter((m) => m.type === "summary");

    if (summaryMessages.length === 0) {
      // 没有 summary 消息时，提取最后一轮的发言作为摘要
      const lastRound = room.currentRound;
      const lastRoundMessages = room.messages.filter(
        (m) => m.metadata.round === lastRound && m.type === "speech",
      );

      if (lastRoundMessages.length === 0) {
        lines.push(t("noContent"));
      } else {
        for (const msg of lastRoundMessages) {
          lines.push(`- **${msg.sender.name}**：${msg.content}`);
        }
      }
    } else {
      for (const msg of summaryMessages) {
        lines.push(`- ${msg.content}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 从最后几轮的 keyPoints 中提取共识和分歧
   * 共识：多个参与者都提到的 keyPoint
   * 分歧：仅某个参与者提到的 keyPoint
   */
  private extractConsensusAndDivergence(room: Room): {
    consensusPoints: string[];
    divergencePoints: string[];
  } {
    const userIds = Array.from(room.participants.keys());
    if (userIds.length === 0) {
      return { consensusPoints: [], divergencePoints: [] };
    }

    // 取最后 2 轮
    const currentRound = room.currentRound;
    const minRound = Math.max(1, currentRound - 1);

    // 收集每个参与者最后几轮的 keyPoints
    const participantKeyPoints = new Map<string, string[]>();
    for (const pid of userIds) {
      participantKeyPoints.set(pid, []);
    }

    for (const msg of room.messages) {
      const pid = msg.sender.userId;
      const round = msg.metadata.round ?? 0;
      if (pid && participantKeyPoints.has(pid) && round >= minRound && msg.metadata.keyPoints) {
        participantKeyPoints.get(pid)!.push(...msg.metadata.keyPoints);
      }
    }

    // 收集所有参与者的 keyPoints（去重）
    const allKeyPointSets = Array.from(participantKeyPoints.values());

    // 提取共识：在多个参与者中都出现的 keyPoint
    const consensusPoints: string[] = [];
    const divergencePoints: string[] = [];
    const processed = new Set<string>();

    for (const [, kps] of participantKeyPoints) {
      for (const kp of kps) {
        const lower = kp.toLowerCase();
        if (processed.has(lower)) continue;
        processed.add(lower);

        // 检查有多少参与者有匹配的 keyPoint
        let matchCount = 0;
        for (const otherKps of allKeyPointSets) {
          const hasMatch = otherKps.some((other) => keyPointsMatch(kp, other));
          if (hasMatch) matchCount++;
        }

        if (matchCount >= 2) {
          consensusPoints.push(kp);
        } else {
          divergencePoints.push(kp);
        }
      }
    }

    return { consensusPoints, divergencePoints };
  }
}
