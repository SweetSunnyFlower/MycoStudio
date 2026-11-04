import { save } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import type { Node } from "@xyflow/react";
import { api } from "@/lib/api";
import { graphToSvg, svgToPngBytes } from "@/lib/graphSvg";
import type { SchemaGraph } from "@/lib/types";

/**
 * 导出 ER 图。**不克隆 DOM**：按布局数据自己拼 SVG（见 graphSvg.ts），
 * PNG 只是把这串 SVG 光栅化一次——几百张表也不会卡住主线程。
 */

/** 系统保存对话框有时不会补后缀（尤其用户手输了文件名），这里兜一下 */
export function ensureExtension(path: string, ext: string): string {
  const suffix = `.${ext}`;
  return path.toLowerCase().endsWith(suffix) ? path : `${path}${suffix}`;
}

export async function exportGraphImage(options: {
  graph: SchemaGraph;
  nodes: Node[];
  kind: "png" | "svg";
  baseName: string;
  /** 只导出当前视图 */
  crop?: { x: number; y: number; width: number; height: number } | null;
  hits?: string[];
}): Promise<string | null> {
  const { graph, nodes, kind, baseName, crop, hits } = options;
  try {
    const { svg, width, height } = graphToSvg(graph, nodes, { crop, hits });
    const picked = await save({
      defaultPath: `${baseName}.${kind}`,
      filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
    });
    if (!picked) return null;
    const path = ensureExtension(picked, kind);
    if (kind === "svg") {
      await api.writeTextFile(path, svg);
    } else {
      const bytes = await svgToPngBytes(svg, width, height);
      await api.writeBytesFile(path, bytes);
    }
    toast.success(`已导出 ${kind.toUpperCase()}（${width}×${height}）`);
    return path;
  } catch (e) {
    toast.error("导出图片失败", { description: String(e) });
    return null;
  }
}
