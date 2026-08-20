/**
 * 共享文本处理工具
 * 从 convergence.ts 和 conclusion.ts 提取的公共逻辑
 */

/** 简单分词：英文按单词分割，中文按 bigram 分割 */
export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];

  // 提取英文单词
  const englishWords = lower.match(/[a-z]+/g);
  if (englishWords) tokens.push(...englishWords);

  // 提取中文字符（双字符 gram 提高匹配精度）
  const chineseChars = lower.match(/[\u4e00-\u9fff]+/g);
  if (chineseChars) {
    for (const segment of chineseChars) {
      if (segment.length <= 2) {
        tokens.push(segment);
      } else {
        for (let i = 0; i < segment.length - 1; i++) {
          tokens.push(segment.slice(i, i + 2));
        }
      }
    }
  }

  return tokens;
}

/** 判断两个 keyPoint 是否匹配（关键词 50%+ 重合） */
export function keyPointsMatch(a: string, b: string): boolean {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);

  if (wordsA.length === 0 || wordsB.length === 0) return false;

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  const commonCount = [...setA].filter((w) => setB.has(w)).length;
  const minSize = Math.min(setA.size, setB.size);

  return commonCount / minSize >= 0.5;
}
