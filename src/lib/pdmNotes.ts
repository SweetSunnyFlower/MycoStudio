import { createContext, useContext } from "react";

/** 字段笔记的 key：表名 + 字段名（PDM 里同名表/字段不会同时出现在一个模型里） */
export const pdmNoteKey = (table: string, column: string) => `${table}\u0000${column}`;

export interface PdmNoteApi {
  /** 当前文件已有的笔记：key → markdown */
  notes: Map<string, string>;
  /** 点字段后面的笔记 icon：把锚点矩形带出去，页面据此弹出编辑浮层 */
  onOpen: (table: string, column: string, anchor: DOMRect) => void;
}

export const PdmNoteContext = createContext<PdmNoteApi | null>(null);

export const usePdmNoteApi = () => useContext(PdmNoteContext);
