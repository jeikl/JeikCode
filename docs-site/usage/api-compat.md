# API Compatibility Endpoints (OpenAI, Anthropic)

When launched with `jeikcode --host` or `jeikcode serve`, JeikCode exposes standard LLM-compatible HTTP endpoints on the same port alongside the WebUI. Third-party clients, IDE plugins, or external automated systems can connect directly using standard AI API formats.

---

## 1. Supported Endpoints

| Method | Path | Protocol & Description |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | **OpenAI Chat Completions** compatible protocol (supports SSE streaming, thinking blocks, and tool calls) |
| `POST` | `/v1/responses` | **OpenAI Responses** native streaming protocol |
| `POST` | `/v1/messages` | **Anthropic Claude Messages** protocol |
| `GET` | `/v1/models` | List all currently mounted models (IDs formatted as `account/model`) |

---

## 2. Authentication & Execution Mechanics

- **Authorization Header**: Pass the bearer token specified during service startup:
  ```http
  Authorization: Bearer <your-token>
  ```
  (Omit if launched with `--no-token`).
- **Direct Agent Execution**: These endpoints are directly backed by the local JeikCode Agent runtime rather than acting as a simple proxy. Requests automatically load repository rules (`AGENTS.md`), streaming back thinking blocks and tool call progress in real time.

---

## 3. Example Request (cURL)

```bash
curl -X POST http://127.0.0.1:13457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "messages": [
      {"role": "user", "content": "Analyze the architecture of this codebase"}
    ],
    "stream": true
  }'
```
