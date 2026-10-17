# 02 - Models and Providers Configuration Guide (Models & Providers)

Configuration file path: `~/.jeikcode/config.toml` (or `$JEIKCODE_HOME/config.toml`).

---

## 1. Syntax Specifications & Top-Level Scalar Placement

UI language is uniformly supported across CLI/TUI, daemon, and WebUI: `en` (English), `vi-VN` (Tiếng Việt), `zh-CN` (Simplified Chinese). On first run without configured language, the system automatically detects the OS/terminal environment locale and matches intelligently; unmapped or unsupported locales fall back to English (`en`). Explicit choices are preserved; input aliases (e.g. `vi`/`vi_VN`, `zh`/`zh_CN`) are normalized upon persistence.

1. **Top-level scalars MUST be placed at the very top of the file**:
   `default_model`, `default_provider`, `language`, `auto_update`, etc., must precede any `[table]` section.
2. **Incremental editing**: When updating configuration, add or edit incrementally, preserving existing models and API keys.
3. **Encoding**: UTF-8 without BOM.

---

## 2. Recommended Decoupled Architecture (Accounts & Models Separation)

Define credentials and Base URLs in `provider_accounts`, then declare and configure specific models under `models`:

```toml
# =============================================================================
# Top-level global defaults (MUST precede all [table] sections)
# =============================================================================
default_model = "deepseek/chat"
language = "en"                             # Global language: "en" | "vi-VN" | "zh-CN" (auto-detected if unset, fallback to en)

# =============================================================================
# 1. Account Connections [provider_accounts.<account_id>]
# =============================================================================
[provider_accounts.deepseek]
provider = "deepseek"                       # Built-in preset ID
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"

[provider_accounts.custom-proxy]
provider = "openai-compatible"              # Custom OpenAI-compatible proxy protocol
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.your-proxy.com/v1"

# =============================================================================
# 2. Model Profiles [models."<account_id>/<model_alias>"]
# =============================================================================
[models."deepseek/chat"]
account = "deepseek"                        # Bound provider_accounts
model = "deepseek-chat"                     # Upstream model ID
context_window = 64000                      # Total context window tokens
max_tokens = 8192                           # Maximum output tokens

[models."deepseek/reasoner"]
account = "deepseek"
model = "deepseek-reasoner"
context_window = 64000
reasoning_model = true                      # Declared as reasoning/thinking model
reasoning_history = "exclude"               # Back-transmit thinking history in turns: "exclude" | "include"
reasoning_effort = "high"                   # Thinking effort: "low" | "medium" | "high" | "max"
reasoning_levels = ["low", "medium", "high", "max"] # Candidate list for cycling gears

[models."custom/gpt4o"]
account = "custom-proxy"
model = "gpt-4o"
context_window = 128000
image_input = true                          # Enable direct image input (multimodal vision)
```

---

## 3. Single-Table Direct Configuration (Optional Simple Mode)

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

## 4. Built-in Preset Provider IDs & Communication Protocols

### 4.1 Built-in Preset IDs (`provider` / `type`)
| Preset ID | Vendor / Platform | Protocol Type | Default Base URL | Default Env Key |
| :--- | :--- | :--- | :--- | :--- |
| `deepseek` | DeepSeek | OpenAI Compatible | `https://api.deepseek.com/v1` | `DEEPSEEK_API_KEY` |
| `zhipu` | Zhipu AI (GLM) | OpenAI Compatible | `https://open.bigmodel.cn/api/paas/v4` | `ZHIPUAI_API_KEY` |
| `aliyun` | Alibaba Bailian | OpenAI Compatible | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `DASHSCOPE_API_KEY` |
| `siliconflow` | SiliconFlow | OpenAI Compatible | `https://api.siliconflow.cn/v1` | `SILICONFLOW_API_KEY` |
| `volcengine` | Volcengine | OpenAI Compatible | `https://ark.cn-beijing.volces.com/api/v3` | `ARK_API_KEY` |
| `moonshot` | Moonshot Kimi | OpenAI Compatible | `https://api.moonshot.cn/v1` | `MOONSHOT_API_KEY` |
| `minimax` | MiniMax | OpenAI Compatible | `https://api.minimaxi.com/v1` | `MINIMAX_API_KEY` |
| `openrouter` | OpenRouter | OpenAI Compatible | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai` | OpenAI | OpenAI Compatible | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic Claude | Anthropic Messages | `https://api.anthropic.com` | `ANTHROPIC_API_KEY` |
| `gemini` | Google Gemini | Gemini generateContent | `https://generativelanguage.googleapis.com/v1beta` | `GEMINI_API_KEY` |
| `ollama` | Local Ollama | Ollama Native | `http://localhost:11434` | (No key needed) |

### 4.2 Custom Protocol Types (`provider`)
- `openai-compatible` / `openai`: Standard OpenAI Chat endpoints; `base_url` requires `/v1`.
- `responses-compatible` / `responses`: Modern OpenAI Responses endpoint (`POST /v1/responses`).
- `anthropic-compatible` / `anthropic`: Anthropic Messages endpoints.
- `gemini-compatible` / `gemini`: Google Gemini native streaming endpoints.
- `ollama`: Ollama local endpoints.

---

## 5. Core Parameters & Behavioral Differences

| Parameter | Type / Values | Detailed Behavior & Semantics |
| :--- | :--- | :--- |
| `context_window` | Integer | Total context window token budget (e.g. 64000, 128000). Compaction watermark = window − 20K fixed buffer (**output max does not participate in computation**); automatic compaction triggers at **90% of the watermark** (at task boundaries, measured against provider usage) — context grows dynamically within the window. |
| `max_tokens` | Integer | **Model output capacity declaration** (UI presets: 32K / 64K / 128K / 256K / 384K / custom; default 64K if unset), dispatched as protocol max budget to upstream models; actual output depends on generation. **Does not participate in context accounting or compaction watermark calculations**. |
| `reasoning_model` | Boolean | Declares whether the model is a deep reasoning/thinking model (such as DeepSeek R1, o1, GLM-Zero). |
| **`reasoning_history`** | `"exclude"` \| `"include"` | **Thinking history transmission across turns**:<br>• `"exclude"` (default): Prior `<think>` blocks are stripped in subsequent turns, drastically saving tokens and avoiding API errors on most vendors.<br>• `"include"`: Preserves and sends back reasoning history across turns. Mandatory for Gemini 2.5/3, official DeepSeek endpoints, or proxy gateways validating `thoughtSignature`. |
| **`reasoning_effort`** | `"low"` \| `"medium"` \| `"high"` \| `"max"` | **Reasoning depth gear**. Supported by OpenAI, DeepSeek, and Gemini 3+ (automatically mapped to `thinkingLevel: LOW/MEDIUM/HIGH`). |
| `reasoning_levels` | Array of strings | Candidate list for cycling thinking effort via `Ctrl+T` shortcut in the TUI (e.g. `["low", "medium", "high", "max"]`). |
| **`thinking_budget`** | Integer | **Numeric thinking token budget**. Configures `thinking.budget_tokens` for Claude; maps to `thinkingBudget` for Gemini 2.5 (set to 0 to disable thinking); automatically validated on OpenAI-compatible protocols (`max_tokens > budget`) to prevent errors. |
| `thinking_enabled` | Boolean | Explicit thinking switch. Claude follows budget when unspecified; Gemini 2.5 and 3+ enable thinking by default. |
| **`coalesce_system`** | Boolean | **System prompt merging switch**:<br>• `false` (default): Preserves multiple separate `role: "system"` messages to upstream APIs, facilitating model KV prefix cache hits;<br>• `true` : Merges multiple segments into a single system message before outbound delivery, used only when connecting to legacy gateways that reject multiple system messages. |
| **`image_input`** | Boolean | Alias `supports_vision`. When `true`, passes images directly to the model. For text-only models (`false`), set top-level `vision_preprocessor_provider = "xxx"` to automatically invoke a visual OCR model for text extraction. |
| `skip_tls_verify` | Boolean | When `true`, skips TLS certificate validation for self-hosted proxies or internal private gateways with self-signed certs. |

---

## 6. Reload & Effective Semantics

Modifying `config.toml` **never requires restarting JeikCode**:
1. **Agent Auto-Reload**: Invoke the built-in tool `jeikcode_config(action="reload")` after saving edits.
2. **User Manual Reload**: Enter the `/reload` command in WebUI or TUI.
Reloaded models and configurations take effect immediately after the current turn completes and can be selected on the next turn.
