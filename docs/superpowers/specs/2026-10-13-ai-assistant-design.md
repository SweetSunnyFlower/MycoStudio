# 工作台 AI 助手（多轮对话）

日期：2026-10-13

## 目标

在工作台里放一个多轮对话的 AI 助手，围绕「当前连接的数据库」帮你写 SQL、解释 SQL、解读执行计划、定位报错。
这一步不做 tool calling（让模型自己查库），留到下一步。

## 前置检查：没有可用供应商

任何 AI 入口（打开助手、发消息、快捷指令）先做一次检查：

1. 没有任何供应商
2. 有供应商但默认供应商的 `token` 为空

以上任一情况 → **不发起请求**，`toast.error("还没有可用的 AI 供应商，先去设置里添加", { action: 打开设置 })`，
并且把助手的输入框置为禁用态（提示同上）。避免出现「点了没反应」或「报一句看不懂的 HTTP 错误」。

## 会话存储：SQLite

文件 `~/.myco-studio/ai.sqlite`（复用已有的 sqlx sqlite 依赖，不引新库）。

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id            TEXT PRIMARY KEY,
  connection_id TEXT,              -- 会话归属的连接，可空（未打开连接时）
  title         TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  role            TEXT NOT NULL,   -- user / assistant
  content         TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
```

会话按连接分组：不同库的表结构完全不同，混在一起模型会答串。

## 上下文策略（方案 A：先喂上下文）

每轮请求都按这个顺序拼：

1. **system**：角色与规则 + schema 摘要
   - 表名清单（只列名字，不带字段）——受 token 预算限制，最多 N 张
   - 用户在当前会话里提到过的表、以及工作台里选中的表，给**完整 DDL**
   - 规则：只输出 SQL 时用 ```sql 代码块；不要臆造表名字段名；不确定就问
2. **最近 K 轮原文**（默认 K = 8，可配）
3. **更早轮次的摘要**（超过 K 轮的压成一段「此前讨论过…」）
4. 当前用户输入

schema 摘要按关键词裁剪：从表名清单里匹配用户输入/最近几轮里出现的表名，只带这些表的 DDL。

## 流式协议

后端一边收一边往前端推 Tauri 事件：

- `ai://chunk`  `{ conversation_id, delta }`
- `ai://done`   `{ conversation_id, content }`
- `ai://error`  `{ conversation_id, message }`

要求：可取消（用户关抽屉/切会话时中断；后端用 `tokio::select!` + 取消标记）。
助手回复落库在 `done` 时一次性写入。

## UI

- 工作台右侧可折叠的「AI 助手」抽屉（沿用行详情抽屉的视觉与动效）
- 顶部：会话切换（新建 / 历史列表 / 删除），标题默认取首条用户消息前 20 字
- 中部：消息流；assistant 的 ```sql 代码块带「填入编辑器」按钮
- 底部：多行输入，Enter 发送 / Shift+Enter 换行；请求中显示「停止」
- **快捷指令**：在 SQL 编辑器里选中一段 SQL，右键或工具栏 →「解释 / 优化 / 修错」，
  把预设 prompt + 选中内容作为一条用户消息发进助手（不开新弹窗）
- 空态给 3 条示例指令（「解释这条 SQL」「给 users 表加个索引」「这个报错怎么修」）

## 技术选型

- 对话调用用 **rig-core**（锁 `0.44`）：`chat()` / `stream_chat(prompt, history)` 自带多轮与流式。
  provider 统一走它的 OpenAI 兼容 client + 用户填的 base_url（不锁 DeepSeek 专用 provider，
  因为要支持 oneapi 这类自建网关）。
- 已有的「测试 Token / 同步模型」保持手写 reqwest——Rig 没有「列出模型」的能力。
- **base_url 语义**：供应商配置里填的是根地址（如 `https://api.deepseek.com`），
  `/v1` 这类版本段由我们拼接，避免出现 `/v1/v1/chat/completions`。

## 不做

- tool calling（让模型自己查库、自己跑 SQL）——下一步单独设计，涉及只读边界与确认
- 跨连接的共享会话
- 多模态、图片理解
