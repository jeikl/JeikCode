# 模型配置

JeikCode 采用「**提供商账号 (`provider_accounts`)**」与「**模型档案 (`models`)**」完全解耦的架构，支持接入各大主流大模型（LLM）厂商官方 API、中转代理网关以及本地部署端点（如 Ollama、vLLM、LM Studio）。

---

## 1. 支持的 Provider 协议

JeikCode 底层支持对接以下主流模型通信协议：

- `openai-compatible`：OpenAI Chat Completions 兼容协议与中转代理网关
- `responses`：OpenAI Responses 原生协议
- `anthropic`：Anthropic Claude 原生 Messages 协议
- `gemini`：Google Gemini 原生协议
- `ollama`：本地 Ollama 原生协议

---

## 2. 核心 TOML 模型配置模板

在 `~/.jeikcode/config.toml` 中配置你的供应商账号和模型：

```toml
# =============================================================================
# 1. 提供商定义 [provider_accounts.<account_id>]
# =============================================================================
[provider_accounts.deepseek]
provider = "deepseek"                       # 内置预设类型：deepseek, openai, anthropic, zhipu 等
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
# base_url = "https://api.deepseek.com/v1" # 内置预设包含默认端点，也可在此显式覆盖

[provider_accounts.custom-proxy]
provider = "openai-compatible"              # OpenAI Chat Completions 协议
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.your-proxy.com/v1"

# =============================================================================
# 2. 模型定义 [models."<account_id>/<model_alias>"]
# =============================================================================
[models."deepseek-v4.1-flash"]
account = "deepseek"
model = "deepseek-v4.1-flash"              # 上游实际调用的真实模型 ID
context_window = 1024000                   # 上下文窗口 Token 数
max_tokens = 131200                        # 模型最大输出 Token 数
reasoning_model = true                     # 声明为推理/思考模型
reasoning_history = "exclude"              # 是否回传思考过程："include" | "exclude"
reasoning_effort = "high"                  # 默认选择思考强度档位："low" | "medium" | "high" | "max"
reasoning_levels = ["low", "medium", "high", "max"] # 终端 Ctrl+T 快速循环切换的档位
image_input = true                         # 支持图片多模态输入
```

---

## 3. 终端交互命令管理

在交互终端中，你无需每次手动编辑文件，可通过斜杠命令完成模型与账号的管理：

### 切换模型 (`/model`)

```text
/model
```

系统会展示当前已配置的模型列表及当前生效的主模型。使用方向键上下移动即可快速切换当前会话所使用的模型。

### 配置提供商与 API Key (`/provider`)

```text
/provider
```

在交互菜单中选择添加或编辑提供商（DeepSeek, Anthropic Claude, OpenAI, Google Gemini, SiliconFlow, 智谱 AI, 月之暗面, OpenRouter, Ollama 等），输入 API Key 即可自动写入配置文件。

---

## 4. 环境变量配置

你也可以直接通过系统环境变量注入对应厂商的 API Key，JeikCode 会在启动时自动读取并建立默认映射：

::: code-group

```bash [Linux / macOS]
# DeepSeek 官方
export DEEPSEEK_API_KEY="sk-..."

# Anthropic Claude
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI 官方或兼容网关
export OPENAI_API_KEY="sk-..."

# Google Gemini
export GEMINI_API_KEY="AIza..."
```

```powershell [Windows (PowerShell)]
# 当前会话临时生效
$env:DEEPSEEK_API_KEY="sk-..."
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:OPENAI_API_KEY="sk-..."

# 永久写入用户系统环境变量
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")
```

:::

---

## 5. 视觉代答配置 (`vision_preprocessor_provider`)

若当前主力模型为纯文本代码模型（无法直接处理图像），但你需要在对话中粘贴报错截图或设计图，可配置视觉代答：

```toml
# 指定用于解析图像的视觉专长模型档案
vision_preprocessor_provider = "custom/claude-sonnet"
```

Agent 在接收到图片时，会自动调用该视觉模型将图片中的 UI 布局、错误堆栈解析提取为语义文本，无缝传递给主力代码模型。
