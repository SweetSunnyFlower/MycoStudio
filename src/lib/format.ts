/**
 * 后端给的是整数毫秒。本地库的小查询几乎都是 0，直接写 "0ms" 会让人以为没计时，
 * 不足 1ms 一律显示 "<1ms"。
 */
export function formatElapsed(ms: number): string {
  return ms < 1 ? "<1ms" : `${ms}ms`;
}
