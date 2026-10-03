# Model Configuration

JeikCode decouples **Provider Accounts (`provider_accounts`)** from **Model Profiles (`models`)**, supporting official APIs from major LLM vendors, proxy gateways, and local offline inference runtimes (such as Ollama, vLLM, and LM Studio).

---

## 1. Supported Provider Protocols

JeikCode natively supports the following upstream LLM communication protocols:

- `openai-compatible`: OpenAI Chat Completions compatible API and proxy gateways
- `responses`: OpenAI Responses native streaming protocol
- `anthropic`: Anthropic Claude native Messages protocol
- `gemini`: Google Gemini native protocol
- `ollama`: Local Ollama native protocol

---

## 2. Core TOML Model Configuration Template

Configure your provider accounts and models in `~/.jeikcode/config.toml`:

```toml
# =============================================================================
# 1. Provider Accounts [provider_accounts.<account_id>]
# =============================================================================
[provider_accounts.deepseek]
provider = "deepseek"                       # Built-in presets: deepseek, openai, anthropic, zhipu, etc.
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
# base_url = "https://api.deepseek.com/v1" # Preset endpoints are built-in; override here if needed

[provider_accounts.custom-proxy]
provider = "openai-compatible"              # OpenAI Chat Completions protocol
api_key = "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
base_url = "https://api.your-proxy.com/v1"

# =============================================================================
# 2. Model Profiles [models."<account_id>/<model_alias>"]
# =============================================================================
[models."deepseek-v4.1-flash"]
account = "deepseek"
model = "deepseek-v4.1-flash"              # Upstream actual model ID
context_window = 1024000                   # Context window token limit
max_tokens = 131200                        # Maximum completion tokens
reasoning_model = true                     # Declare as reasoning/thinking model
reasoning_history = "exclude"              # Thinking replay strategy: "include" | "exclude"
reasoning_effort = "high"                  # Default thinking budget: "low" | "medium" | "high" | "max"
reasoning_levels = ["low", "medium", "high", "max"] # Quick-cycle levels via Ctrl+T in terminal
image_input = true                         # Enable direct multimodal image input
```

---

## 3. Interactive Terminal Command Management

In the interactive terminal, you do not need to manually edit files every time; manage models and credentials via slash commands:

### Switch Active Model (`/model`)

```text
/model
```

Opens an interactive menu displaying configured models and your currently active primary model. Use arrow keys to quickly switch between models.

### Configure Providers & API Keys (`/provider`)

```text
/provider
```

Interactively add or edit provider accounts (DeepSeek, Anthropic Claude, OpenAI, Google Gemini, SiliconFlow, Zhipu AI, Moonshot, OpenRouter, Ollama, etc.) and enter your API key to write it to your configuration.

---

## 4. Environment Variables

You can also export API keys via environment variables. JeikCode reads them on startup:

::: code-group

```bash [Linux / macOS]
# DeepSeek
export DEEPSEEK_API_KEY="sk-..."

# Anthropic Claude
export ANTHROPIC_API_KEY="sk-ant-..."

# OpenAI or Compatible Gateway
export OPENAI_API_KEY="sk-..."

# Google Gemini
export GEMINI_API_KEY="AIza..."
```

```powershell [Windows (PowerShell)]
# Current terminal session
$env:DEEPSEEK_API_KEY="sk-..."
$env:ANTHROPIC_API_KEY="sk-ant-..."
$env:OPENAI_API_KEY="sk-..."

# Permanent user environment variable
[Environment]::SetEnvironmentVariable("DEEPSEEK_API_KEY", "sk-...", "User")
```

:::

---

## 5. Vision Preprocessor Fallback (`vision_preprocessor_provider`)

If your active primary model is a text-only coding model but you need to attach screenshots or design assets:

```toml
# Model profile used to preprocess and analyze image attachments
vision_preprocessor_provider = "custom/claude-sonnet"
```

The agent automatically routes attached images to this vision-capable model first, transcribing UI layouts and stack traces into structured descriptions before prompting the primary model.
