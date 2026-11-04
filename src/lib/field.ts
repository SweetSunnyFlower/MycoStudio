export type FieldKind =
  | "text"
  | "json"
  | "number"
  | "boolean"
  | "date"
  | "time"
  | "datetime"
  | "enum"
  | "set"
  | "binary";

/** 解析 MySQL `enum('a','b')` / `set('a','b')` 里的候选值 */
export function parseEnumValues(rawType: string): string[] {
  const m = /^(?:enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(rawType.trim());
  if (!m) return [];
  const out: string[] = [];
  const re = /'((?:[^']|'')*)'/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(m[1])) !== null) out.push(mm[1].replace(/''/g, "'"));
  return out;
}

/** 把列类型归一成前端可渲染的控件种类 */
export function fieldKind(dataType: string, rawType: string): FieldKind {
  const dt = (dataType || "").toLowerCase();
  const rt = (rawType || "").toLowerCase();
  if (rt.startsWith("enum")) return "enum";
  if (rt.startsWith("set")) return "set";
  if (dt.includes("bool")) return "boolean";
  if (/^tinyint\(1\)/.test(rt)) return "boolean";
  if (dt === "json") return "json";
  if (dt.includes("datetime") || dt.includes("timestamp")) return "datetime";
  if (dt === "date") return "date";
  if (dt === "time") return "time";
  if (dt.includes("blob") || dt.includes("binary")) return "binary";
  if (/(int|float|double|decimal|numeric|real)/.test(dt)) return "number";
  return "text";
}

/** 存储文本 → 原生控件的 value 格式 */
export function toWidget(kind: FieldKind, text: string): string {
  if (kind === "datetime") return text.replace(" ", "T").slice(0, 19);
  if (kind === "date") return text.slice(0, 10);
  if (kind === "time") return text.slice(0, 8);
  return text;
}

/** 原生控件的 value → 存储文本 */
export function fromWidget(kind: FieldKind, v: string): string {
  if (kind === "datetime") return v.replace("T", " ") + (v.length === 16 ? ":00" : "");
  if (kind === "time") return v + (v.length === 5 ? ":00" : "");
  return v;
}
