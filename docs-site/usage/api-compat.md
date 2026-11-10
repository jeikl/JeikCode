# API Compatibility Endpoints (OpenAI, Anthropic)

When launched with `jeikcode --host` or `jeikcode serve`, JeikCode exposes standard LLM-compatible HTTP endpoints on the same port as the WebUI. Third-party clients, IDE plugins, translation tools, and automation agents can connect with their existing SDKs.

These endpoints are **not a stateless proxy**. JeikCode is a stateful agent backend: the prompt, history, tools, checklist, compaction, and outline all live on the server. A request is treated like a user typing into the WebUI composer and pressing Send. Only the newest user message is admitted; the backend manages everything that follows.

---

## 1. Supported Endpoints

| Method | Path | Protocol & Description |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | **OpenAI Chat Completions** compatible protocol (SSE streaming, thinking blocks, tool calls) |
| `POST` | `/v1/responses` | **OpenAI Responses** compatible protocol |
| `POST` | `/v1/messages` | **Anthropic Claude Messages** protocol |
| `GET` | `/v1/models` | List all mounted models (IDs formatted as `account/model`) |
| `GET` | `/v1/anthropic/models` | Anthropic-shaped model list (same `account/model` IDs) |
| `GET` | `/v1/models/{id}` | Retrieve one model (slash-safe) |
| `GET` | `/v1/sessions` | List JeikCode sessions; filter by `?user=<session-key>` |
| `GET` | `/v1/sessions/{id}` | Read one session by UUID, prefix, or exact `user` key |

The three chat endpoints accept their native wire formats and return their native response/SSE shapes. JeikCode-specific metadata is additive and lives under the `jeikcode` object, so standard SDK parsers can ignore it.

---

## 2. Authentication

Pass the bearer token configured at startup:

```http
Authorization: Bearer <your-token>
```

Omit the header only when the daemon was started with `--no-token`.

---

## 3. Conversation Semantics

### 3.1 Only the newest user message is admitted

The backend owns conversation history. For every request:

- Only the **last `role=user` message** is used as the new turn.
- Earlier `user` / `assistant` / `tool` messages, including a trailing assistant prefill, are ignored.
- Send the new user message as the final message when possible; a trailing assistant/tool row is ignored rather than replayed.
- Client `system` / `developer` messages and OpenAI Responses `instructions` are ignored. The backend system prompt, project rules (`AGENTS.md`), memory, skills, MCP tools, and glossary are the only instruction sources.
- Send the new user message as the final message of the request. Do not replay the whole conversation.

This is intentional: it is the same contract as a thin frontend sending one message to the WebUI. It also means a client-side history cannot compensate for a missing server-side session—if you omit `user`, every request is a new session.

### 3.2 `user` is the session key

`user` is a durable session key, not just an abuse-tracking identifier:

```json
{
  "model": "account/model",
  "user": "alice_chat_1",
  "messages": [{ "role": "user", "content": "Analyze this repository" }]
}
```

- Same `user` value: resume the same JeikCode session.
- Different `user` value: create a different session.
- Omitted or blank `user`: an ephemeral `api-<uuid>` key is generated for that request. Anonymous requests never share a global session.

The server stores the key as an immutable `protocol_key` alongside the session, so renaming the session in the WebUI does not break API resume. The response always includes the resolved identity:

```json
{
  "jeikcode": {
    "session_id": "6fe6640f-d69d-49cc-b581-d3e559d03753",
    "user": "alice_chat_1"
  }
}
```

Clients that cannot set `user` may read `jeikcode.session_id` for diagnostics, but the supported resume contract is the `user` key. No custom header or extra field is required.

### 3.3 Auto mode, no approval modals

Every `/v1/*` turn is forced to **Auto** approval:

- No `permission_request` and no interactive approval modal.
- No `user_input_request` modal.
- The WebUI global mode switch (Plan / Build / Accept Edits) does not affect API turns.
- When the model calls `request_user_input`, the question is returned as the assistant's final text and the tool call is declined so the model waits for the next user message. The API client answers by sending the next user message.

This is the "model asks in plain text" mode. A request never blocks on a browser interaction.

### 3.4 A second request while a turn is running preempts

These endpoints use latest-wins semantics:

- A second request with the same `user` while the first turn is running stops the first turn.
- The server waits for the first turn's snapshot/display flush, then starts the new turn.
- This is equivalent to the WebUI **Stop + Send** path (the `promote` branch of "Send now" on an already-queued steer card), not `/chat/steer`.
- The wait is bounded to 60 seconds. If the old turn cannot release in time, the request returns HTTP 409 `session_busy`.

True mid-turn steering is a stateful interactive feature and is not representable in a one-request/one-response OpenAI/Anthropic call. Clients that want two messages in the same turn should use the WebUI or a future explicit steer channel.

### 3.5 Model and tools

- `model` is resolved on every request. `account/model` IDs from `/v1/models` are accepted, as are bare wire model names and legacy catalog keys. Responses echo the canonical `account/model` ID.
- JeikCode's backend tools run on the server; tool calls are streamed back in the protocol's native shape.
- Client-supplied tool definitions and `role=tool` history are not used. If your agent expects client-side tool loops, this endpoint is not a stateless model provider—use the WebUI or a dedicated agent integration.
- Images in the newest user message are forwarded to the selected model (or the configured vision preprocessor when the model is text-only).

### 3.6 Streaming and non-streaming

- `stream: true` returns native SSE chunks (`/v1/chat/completions`, `/v1/responses`) or Anthropic SSE events.
- `stream: false` returns one JSON response. The non-stream collector delivers the final user-facing answer, with the Todo-guard fallback: if the turn ends with a todo tool after a substantial answer, the pre-tool answer is selected instead of a short closing remark.
- Closing the HTTP connection cancels the owning turn, so a client timeout does not keep burning tokens.

---

## 4. Examples

### 4.1 OpenAI Chat Completions

```bash
curl -X POST http://127.0.0.1:13457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "user": "alice_chat_1",
    "messages": [
      {"role": "user", "content": "Analyze the architecture of this codebase"}
    ],
    "stream": true
  }'
```

Continue the same conversation by sending the next message with the same `user` and only the new user message:

```bash
curl -X POST http://127.0.0.1:13457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "user": "alice_chat_1",
    "messages": [
      {"role": "user", "content": "Now focus on the daemon session admission path"}
    ],
    "stream": true
  }'
```

### 4.2 OpenAI Responses

```bash
curl -X POST http://127.0.0.1:13457/v1/responses \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "user": "alice_responses_1",
    "input": "Summarize the likely failure modes of this change",
    "stream": true
  }'
```

`input` may be a string or an array of `message` / `input_text` items; `input_image` is accepted for the newest user turn. `instructions` is accepted at the wire level but ignored, because the backend prompt is authoritative.

### 4.3 Anthropic Messages

```bash
curl -X POST http://127.0.0.1:13457/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "user": "alice_anthropic_1",
    "max_tokens": 4096,
    "messages": [
      {"role": "user", "content": "Explain the session outline pipeline"}
    ],
    "stream": true
  }'
```

The Anthropic `system` field is accepted but ignored for the same reason.

### 4.4 List models and sessions

```bash
curl http://127.0.0.1:13457/v1/models \
  -H "Authorization: Bearer your-token"

curl "http://127.0.0.1:13457/v1/sessions?user=alice_chat_1" \
  -H "Authorization: Bearer your-token"
```

---

## 5. Compatibility Notes

| Behavior | Contract |
| :--- | :--- |
| Wire formats | Native OpenAI Chat Completions, OpenAI Responses, and Anthropic Messages shapes |
| Conversation history | Server-owned; client history ignored |
| Client system prompts | Ignored |
| Client tools / tool results | Not used; JeikCode backend tools run instead |
| Session identity | `user` key; same key resumes, different key is a new session |
| Missing `user` | Ephemeral `api-<uuid>`; no shared global session |
| Approval mode | Forced Auto; no permission or user-input modals |
| Second request while running | Preempt (stop + new turn), not steer |
| Non-stream final answer | Last substantive answer, with Todo-guard fallback |
| Connection drop | Cancels the owning turn |

If a client appears to "forget" the conversation, verify that it sends the same `user` key on every request and that it does not expect its own `messages` history to be replayed. When `user` is omitted, each request is intentionally a fresh session.

---

## 6. Troubleshooting

- **The answer ignores the client's system prompt.** Expected: the backend prompt is the only authority.
- **The model does not see prior client messages.** Expected: only the newest user message is admitted. Resume by reusing `user`.
- **The WebUI shows a different session than expected.** Check `jeikcode.session_id` and `user` in the response; the session may have been created under an `api-<uuid>` key because `user` was omitted.
- **A request returns 409 `session_busy`.** The previous turn did not release within 60 seconds. Stop it from the WebUI or retry after the current turn settles.
- **A client-side tool loop hangs.** The endpoint does not accept client tool results. Use server-side tools or a dedicated agent client.
