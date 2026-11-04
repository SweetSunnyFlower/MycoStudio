# AI 供应商模块（设置 → 供应商）

日期：2026-10-13

## 目标

在设置里增加「AI → 供应商」，管理 OpenAI 兼容的模型服务商（名称 / 地址 / Token / 模型）。
这一步只做供应商管理，不接任何 AI 用途（NL→SQL 等留到后面）。

## 数据与存储

配置文件 `ai-providers.json`（放在现有 `config_dir()` 下），权限 600：

```json
{
  "default_id": "<provider id>",
  "providers": [
    {
      "id": "<uuid>",
      "name": "DeepSeek",
      "base_url": "https://api.deepseek.com",
      "token": "sk-...",
      "default_model": "deepseek-v4-pro",
      "models": ["deepseek-v4-pro", "deepseek-v4-flash"]
    }
  ]
}
```

- **Token 明文存**（用户明确要求）：不再走钥匙串，也就没有 `has_token` 中间字段，
  列表卡片直接按 token 是否为空显示「已配置 / 未配置」。
- 首次运行（文件不存在）写入预置 DeepSeek：默认模型 `deepseek-v4-pro`，
  已知模型 `deepseek-v4-pro` / `deepseek-v4-flash`，token 为空（卡片提示未配置）。
  `deepseek-chat` / `deepseek-reasoner` 已于 2026-07-24 停用，不再使用。
- 全局只有一个默认供应商（`default_id`）。

## 左导航

设置左侧新增分组 **AI → 供应商**（section id `providers`），右侧内容区沿用现有的切换动画。

## 列表视图

- 标题「供应商」+ 右上「添加供应商」
- 三列 grid 卡片（与连接管理一致）：名称（粗体）、默认模型（等宽、次要色）、状态行
  （「✓ 默认 / 设为默认」+「已配置 Token / 未配置 Token」）
- 点卡片主体 = 设为默认（写库 + toast）；默认卡片加主色边框与「默认」徽标
- 右上 ⋯ 下拉：编辑 / 删除（均带 icon），点击不触发「设为默认」
- 删除弹二次确认；删的是默认供应商时额外提示「删除后默认会切到列表里的第一个」，
  删除后默认落到剩余第一个，列表为空则置空

## 编辑视图

右侧整块换成表单，顶部 `← 返回` + 标题（添加供应商 / 编辑供应商），两张卡片：

**基本信息**

- 名称（必填）
- 地址 Base URL（必填，等宽，占位 `https://api.deepseek.com`）
- API Token：密码框（默认显示为圆点）+ 眼睛 icon 切换明文；编辑时预填真实 token
  （明文存储，不再有「留空则不改」的隐式语义）；行右侧一个「测试」按钮

**模型**

- 默认模型：可输入的下拉（候选来自已知模型，也允许直接敲）
- 已知模型：chip 列表（每个带 × 删除）+ 一行「输入模型名 + 添加」
- 小节标题右侧「同步模型」按钮

底部操作条：取消 / 保存（校验名称、地址、Token 必填）。

表单采用**全部整行**布局：地址与 Token 偏长，两列会被挤扁。

## 测试 Token 与同步模型

两者共用同一个接口 `GET {base_url}/models`（`Authorization: Bearer <token>`）：

- **测试**：先打 `/models`，成功即 token 有效且不消耗额度；返回 404（厂商未提供该接口）时
  退回发一次最小对话 `POST /chat/completions`（`max_tokens: 1`，单条 "ping"）确认鉴权。
  结果就地显示：成功绿色「Token 有效 · 可用模型 N 个」，失败红色带服务端原始信息。
- **同步模型**：把 `/models` 返回的 id 合并进已知模型，toast 报新增数量。
  地址或 token 为空时按钮禁用。

## 后端命令

- `list_ai_providers` → `{ default_id, providers }`
- `save_ai_provider(provider)` → 新增或更新（按 id）
- `delete_ai_provider(id)`
- `set_default_ai_provider(id)`
- `sync_ai_models(id)` → 返回合并后的模型列表
- `test_ai_provider(id)` → 返回 `{ ok, message, models }`

HTTP 用 `reqwest`（tauri 已传递依赖，无需新增体积）。

## 不做

- 不做 NL→SQL、对话等任何 AI 用途
- 不做模型参数（temperature 等）配置
- 不做多默认供应商
