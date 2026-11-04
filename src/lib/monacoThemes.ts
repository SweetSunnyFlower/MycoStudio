/**
 * SQL 编辑器的主题。
 *
 * Monaco 自带的 vs / vs-dark 会给关键词上蓝色、字符串上绿色……和应用本身的黑白灰不搭，
 * 所以这里用中性色重写：关键词靠**加粗**区分，字符串/数字降一档灰，注释再淡一档并斜体。
 * 同时把编辑器里默认是蓝色的那些交互色（选中高亮、补全列表选中项、补全项图标等）也一起中性化。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function defineDbDesktopThemes(monaco: any) {
  monaco.editor.defineTheme("dbdesktop-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "a1a1aa", fontStyle: "italic" },
      { token: "keyword", foreground: "18181b", fontStyle: "bold" },
      { token: "predefined", foreground: "18181b" },
      { token: "identifier", foreground: "18181b" },
      { token: "string", foreground: "52525b" },
      { token: "number", foreground: "52525b" },
      { token: "operator", foreground: "71717a" },
      { token: "delimiter", foreground: "71717a" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#18181b",
      "editorGutter.background": "#ffffff",
      "editorLineNumber.foreground": "#a3a3a3",
      "editorLineNumber.activeForeground": "#525252",
      "editor.lineHighlightBackground": "#f4f4f5",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#18181b",
      "editor.selectionBackground": "#e4e4e7",
      "editor.inactiveSelectionBackground": "#f4f4f5",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#e4e4e7",
      "editorSuggestWidget.background": "#ffffff",
      "editorSuggestWidget.border": "#e4e4e7",
      "editorSuggestWidget.selectedBackground": "#f4f4f5",
      "editorSuggestWidget.highlightForeground": "#18181b",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#e4e4e7",
      "list.activeSelectionBackground": "#f4f4f5",
      "list.activeSelectionForeground": "#18181b",
      "list.highlightForeground": "#18181b",
      "symbolIcon.keywordForeground": "#52525b",
      "symbolIcon.fieldForeground": "#52525b",
      "symbolIcon.structForeground": "#52525b",
      "focusBorder": "#00000000",
      "scrollbarSlider.background": "#00000014",
      "scrollbarSlider.hoverBackground": "#00000026",
      "scrollbarSlider.activeBackground": "#00000033",
    },
  });

  monaco.editor.defineTheme("dbdesktop-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "71717a", fontStyle: "italic" },
      { token: "keyword", foreground: "fafafa", fontStyle: "bold" },
      { token: "predefined", foreground: "fafafa" },
      { token: "identifier", foreground: "e4e4e7" },
      { token: "string", foreground: "a1a1aa" },
      { token: "number", foreground: "a1a1aa" },
      { token: "operator", foreground: "a1a1aa" },
      { token: "delimiter", foreground: "a1a1aa" },
    ],
    colors: {
      "editor.background": "#18181b",
      "editor.foreground": "#e4e4e7",
      "editorGutter.background": "#18181b",
      "editorLineNumber.foreground": "#71717a",
      "editorLineNumber.activeForeground": "#d4d4d8",
      "editor.lineHighlightBackground": "#27272a",
      "editor.lineHighlightBorder": "#00000000",
      "editorCursor.foreground": "#e4e4e7",
      "editor.selectionBackground": "#3f3f46",
      "editor.inactiveSelectionBackground": "#27272a",
      "editorWidget.background": "#27272a",
      "editorWidget.border": "#3f3f46",
      "editorSuggestWidget.background": "#27272a",
      "editorSuggestWidget.border": "#3f3f46",
      "editorSuggestWidget.selectedBackground": "#3f3f46",
      "editorSuggestWidget.highlightForeground": "#fafafa",
      "editorHoverWidget.background": "#27272a",
      "editorHoverWidget.border": "#3f3f46",
      "list.activeSelectionBackground": "#3f3f46",
      "list.activeSelectionForeground": "#fafafa",
      "list.highlightForeground": "#fafafa",
      "symbolIcon.keywordForeground": "#a1a1aa",
      "symbolIcon.fieldForeground": "#a1a1aa",
      "symbolIcon.structForeground": "#a1a1aa",
      "focusBorder": "#00000000",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff26",
      "scrollbarSlider.activeBackground": "#ffffff33",
    },
  });
}
