import { api } from "@/lib/api";

/**
 * 模型对比的「已确认状态」落库。
 *
 * 按「连接 + 库 + 对比目标」隔离：哪些改动勾选了要执行、哪些被明确忽略，
 * 下次打开同一次对比还能接着看，不用重新判断一遍。
 */

export interface DiffState {
  /** 勾选要执行的改动 id */
  checked: string[];
  /** 明确忽略（不再关心）的改动 id */
  ignored: string[];
  savedAt: number;
}

export function diffScopeKey(parts: {
  connectionId?: string | null;
  database: string;
  /** 对比目标（PDM 文件路径 / 库名），用来源 + 名字保证同一对模型只有一个键 */
  target?: string;
}): string {
  return `model-diff:${parts.connectionId ?? "-"}:${parts.database}:${parts.target ?? "-"}`;
}

export async function loadDiffState(key: string): Promise<DiffState | null> {
  try {
    const raw = await api.getAppSetting(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DiffState;
    return {
      checked: Array.isArray(parsed.checked) ? parsed.checked : [],
      ignored: Array.isArray(parsed.ignored) ? parsed.ignored : [],
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
    };
  } catch {
    return null;
  }
}

export async function saveDiffState(key: string, checked: string[], ignored: string[]): Promise<void> {
  const state: DiffState = { checked, ignored, savedAt: Date.now() };
  await api.setAppSetting(key, JSON.stringify(state));
}
