import { api } from "@/lib/api";

/**
 * SQL 历史 / 收藏。以前放在 localStorage（有 5MB 上限、清缓存就丢），
 * 现在统一存本地 SQLite，按「连接 + 库」隔离，跟连接、密钥一起备份。
 */

export interface HistoryItem {
  id: string;
  sql: string;
  at: number;
}

export interface SavedItem {
  id: string;
  name: string;
  sql: string;
}

export async function getHistory(conn: string, db: string): Promise<HistoryItem[]> {
  const rows = await api.listSqlHistory(conn, db);
  return rows.map((r) => ({ id: `h${r.id}`, sql: r.sql, at: r.created_at }));
}

export async function addHistory(conn: string, db: string, sql: string): Promise<void> {
  await api.pushSqlHistory(conn, db, sql);
}

export async function getSaved(conn: string, db: string): Promise<SavedItem[]> {
  const rows = await api.listSavedSql(conn, db);
  return rows.map((r) => ({ id: String(r.id), name: r.name, sql: r.sql }));
}

export async function addSaved(conn: string, db: string, name: string, sql: string): Promise<void> {
  await api.saveSql(conn, db, name, sql);
}

export async function removeSaved(id: string): Promise<void> {
  await api.deleteSavedSql(Number(id));
}

const MIGRATED_KEY = "dbdesktop:migrated:sql-library";

/**
 * 一次性把旧的 localStorage 历史 / 收藏搬进本地 SQLite。
 * 全部成功才清空旧键并打标记，失败就留着下次启动再试。
 */
export async function migrateLegacySqlLibrary(): Promise<void> {
  try {
    if (localStorage.getItem(MIGRATED_KEY)) return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("dbdesktop:history:") || key.startsWith("dbdesktop:saved:"))) {
        keys.push(key);
      }
    }
    if (keys.length === 0) {
      localStorage.setItem(MIGRATED_KEY, "1");
      return;
    }
    let failed = 0;
    const jobs: Promise<void>[] = [];
    for (const key of keys) {
      const isSaved = key.startsWith("dbdesktop:saved:");
      const rest = key.slice((isSaved ? "dbdesktop:saved:" : "dbdesktop:history:").length);
      const sep = rest.indexOf(":");
      if (sep < 0) continue;
      const conn = rest.slice(0, sep);
      const db = rest.slice(sep + 1);
      let list: unknown;
      try {
        list = JSON.parse(localStorage.getItem(key) ?? "[]");
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      // localStorage 里是新 → 旧，倒着推才能让最新的留在列表最上面
      const items = isSaved ? list : [...list].reverse();
      for (const item of items) {
        const row = item as { sql?: unknown; name?: unknown };
        if (typeof row?.sql !== "string" || !row.sql) continue;
        const sql = row.sql;
        const name = typeof row.name === "string" && row.name ? row.name : "未命名";
        jobs.push(
          (isSaved ? api.saveSql(conn, db, name, sql) : api.pushSqlHistory(conn, db, sql))
            .then(() => undefined)
            .catch(() => {
              failed += 1;
            }),
        );
      }
    }
    await Promise.all(jobs);
    if (failed > 0) return;
    for (const key of keys) localStorage.removeItem(key);
    localStorage.setItem(MIGRATED_KEY, "1");
  } catch {
    // 迁移失败不打扰用户，下次启动再试
  }
}
