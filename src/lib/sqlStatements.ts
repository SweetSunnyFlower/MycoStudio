/**
 * 把一段脚本拆成可逐条执行的语句。
 *
 * 只用于我们自己生成的 DDL 脚本（没有存储过程 / 触发器），
 * 所以按分号拆、跳过注释行与空行就够；单引号里的分号不会误拆。
 */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i];
    if (ch === "'") {
      // '' 是转义的单引号，不改变字符串状态
      if (inString && script[i + 1] === "'") {
        current += "''";
        i += 1;
        continue;
      }
      inString = !inString;
      current += ch;
      continue;
    }
    if (ch === ";" && !inString) {
      const statement = stripLeadingComments(current);
      if (statement) out.push(`${statement};`);
      current = "";
      continue;
    }
    current += ch;
  }
  const tail = stripLeadingComments(current);
  if (tail) out.push(tail.endsWith(";") ? tail : `${tail};`);
  return out;
}

function stripLeadingComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}
