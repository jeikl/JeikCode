# 02 - 模型与提供商配置指南 (Models & Providers)

配置文件路径：`~/.jeikcode/config.toml`（或 `$JEIKCODE_HOME/config.toml`）。

---

## 1. 语法规范与顶层标量位置

UI dùng chung ngôn ngữ giữa CLI/TUI, daemon và WebUI: `en` (English), `vi-VN` (Tiếng Việt), `zh-CN` (中文). Cài đặt mới hoặc thiếu giá trị dùng English, không tự chọn theo ngôn ngữ hệ điều hành. Lựa chọn đã lưu vẫn được giữ; alias `vi`/`vi_VN`, `zh`/`zh_CN` được chuẩn hóa khi lưu. Settings/onboarding lưu qua `/api/config/language`; không dịch lại hội thoại, tài liệu người dùng, hoặc thay đổi contract prefix append-only/hot-reload.

1. **顶层标量必须置于文件最顶部**：
   `default_model`、`default_provider`、`language`、`auto_update` 等必须位于文件最开头，处于任何 `[table]` 表段之前。
2. **增量更新**：修改配置时请增量添加或编辑，保留用户现有的其他模型和 API Key。
3. **编码格式**：UTF-8（无 BOM）。

---

## 2. 推荐解耦配置架构（账号与模型分离）

通过 `provider_accounts` 定义凭据与 Base URL，在 `models` 中复用并声明具体模型参数：

```toml
# =============================================================================
# 顶层全局默认项（必须位于所有 [table] 之前）
# =============================================================================
default_model = "deepseek/chat"
language = "en"                             # Ngôn ngữ UI: "en" | "vi-VN" | "zh-CN"; mặc định English

# =============================================================================
# 1. 账号连接 [provider_accounts.<account_id>]
# =============================================================================
[provider_accounts.deepseek]
provider = "deepseek"                       # 内置预设 ID
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"

[provider_accounts.custom-proxy]
provider = "openai-compatible"              # 自定义 OpenAI 兼容中转协议
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.your-proxy.com/v1"

# =============================================================================
# 2. 模型档案 [models."<account_id>/<model_alias>"]
# =============================================================================
[models."deepseek/chat"]
account = "deepseek"                        # 关联 provider_accounts
model = "deepseek-chat"                     # 实际模型 ID
context_window = 64000                      # 上下文窗口 Token 数
max_tokens = 8192                           # 最大输出 Token

[models."deepseek/reasoner"]
account = "deepseek"
model = "deepseek-reasoner"
context_window = 64000
reasoning_model = true                      # 声明为推理/深度思考模型
reasoning_history = "exclude"               # 思考历史是否在多轮中回传："exclude" | "include"
reasoning_effort = "high"                   # 思考强度："low" | "medium" | "high" | "max"
reasoning_levels = ["low", "medium", "high", "max"] # 循环切换档位列表

[models."custom/gpt4o"]
account = "custom-proxy"
model = "gpt-4o"
context_window = 128000
image_input = true                          # 开启图片直接输入（多模态视觉）
```

---

## 3. 单表直连配置（可选简易模式）

```toml
[providers.glm5]
type = "zhipu"
api_key = "xxxxxxxxxxxxxxxx.xxxxxxxx"
model = "glm-5.2"
context_window = 1000000
max_tokens = 131072
reasoning_model = true
reasoning_history = "exclude"
```

---

## 4. 内置预设提供商 ID 与通信协议

### 4.1 内置预设 ID (`provider` / `type`)
| 预设 ID | 厂商 / 平台 | 协议类型 | 默认 Base URL | 默认环境变量 Key |
| :--- | :--- | :--- | :--- | :--- |
| `deepseek` | DeepSeek | OpenAI 兼容 | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `zhipu` | 智谱 AI (GLM) | OpenAI 兼容 | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPUAI_API_KEY` |
| `aliyun` | 阿里百炼 | OpenAI 兼容 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| `siliconflow` | 硅基流动 | OpenAI 兼容 | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` |
| `volcengine` | 火山引擎 | OpenAI 兼容 | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` |
| `moonshot` | 月之暗面 Kimi | OpenAI 兼容 | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
| `minimax` | MiniMax | OpenAI 兼容 | `https://api.minimaxi.com/v1` | `MINIMAX_API_KEY` |
| `openrouter` | OpenRouter | OpenAI 兼容 | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai` | OpenAI | OpenAI 兼容 | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Claude | Anthropic Messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini | Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` |
| `ollama` | 本地 Ollama | Ollama 原生 | `http://localhost:11434` | (无需密钥) |

### 4.2 自定义协议类型 (`provider`)
- `openai-compatible` / `openai`：标准 OpenAI Chat 接口，`base_url` 需含 `/v1`。
- `responses-compatible` / `responses`：OpenAI Responses 新接口（`POST /v1/responses`）。
- `anthropic-compatible` / `anthropic`：Anthropic Messages 接口。
- `gemini-compatible` / `gemini`：Google Gemini 原生流式接口。
- `ollama`：Ollama 本地接口。

---

## 5. 核心参数与行为差异说明

| 参数名 | 类型 / 取值 | 详细行为与差异说明 |
| :--- | :--- | :--- |
| `context_window` | 整数 | 上下文总窗口 Token 限制（如 64000, 128000）。接近阈值时自动平滑压缩历史消息。 |
| `max_tokens` | 整数 | 单轮输出最大 Token 预算（如 8192, 16384）。 |
| `reasoning_model` | 布尔值 | 声明是否为深度推理模型（如 DeepSeek R1、o1、GLM-Zero 等）。 |
| **`reasoning_history`** | `"exclude"` \| `"include"` | **思考历史多轮回传控制**：<br>• `"exclude"`（默认）：多轮对话中不把前序轮次的 `<think>` 内容发回后端，大幅节省 Token 且避免多数模型 API 报错。<br>• `"include"`：保留并回传思考历史。Gemini 2.5/3、DeepSeek 官方或要求 `thoughtSignature` 校验的中转网关必须开启。 |
| **`reasoning_effort`** | `"low"` \| `"medium"` \| `"high"` \| `"max"` | **推理深度档位**。用于 OpenAI、DeepSeek 及 Gemini 3+（自动映射为 `thinkingLevel: LOW/MEDIUM/HIGH`）。 |
| `reasoning_levels` | 字符串数组 | TUI 界面中通过快捷键 `Ctrl+T` 循环切换思考强度的候选列表（如 `["low", "medium", "high", "max"]`）。 |
| **`thinking_budget`** | 整数 | **数值型思考 Token 预算**。Claude 设置 `thinking.budget_tokens`；Gemini 2.5 映射为 `thinkingBudget`（设为 0 关闭思考）；OpenAI 兼容协议会自动校验提升 `max_tokens > budget` 防报错。 |
| `thinking_enabled` | 布尔值 | 显式思考开关。Claude 未指定时跟随 budget；Gemini 2.5 与 3+ 默认开启思考。 |
| **`coalesce_system`** | 布尔值 | **系统提示词合并开关**：<br>• `false`（默认）：向后端保留多条独立 `role: "system"` 消息，便于命中模型前缀 KV 缓存；<br>• `true`：出站前将多段合并为单条 system 消息，仅在接入不支持多 System 消息的老旧网关时使用。 |
| **`image_input`** | 布尔值 | 别名 `supports_vision`。设为 `true` 允许模型直接输入图片。纯文本模型若设为 `false`，可配置顶层 `vision_preprocessor_provider = "xxx"` 自动调用该视觉模型 OCR 提取文本后代答。 |
| `skip_tls_verify` | 布尔值 | 设为 `true` 在内网自建代理或自签证书网关下跳过 TLS 证书合法性检查。 |

---

## 6. 配置重载与生效方式

修改 `config.toml` 后**无需重启 JeikCode**：
1. **Agent 自动重载**：修改配置后直接调用内置工具 `jeikcode_config(action="reload")`。
2. **用户手动重载**：在 WebUI 或 TUI 输入 `/reload` 命令。
重载后，新模型与配置将在当前回合结束后生效，下一轮对话即可直接选用。
