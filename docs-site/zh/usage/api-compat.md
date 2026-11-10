# API 兼容端点（OpenAI、Anthropic）

通过 `jeikcode --host` 或 `jeikcode serve` 启动后，JeikCode 会在 WebUI 同一端口上暴露标准的大模型兼容 HTTP API。第三方客户端、IDE 插件、翻译工具与自动化 Agent 可以直接使用现有 SDK 接入。

这些端点**不是无状态转发代理**。JeikCode 是有状态的 Agent 后端：提问、历史、工具、待办、压缩与大纲全部由服务端管理。一次请求等价于用户在 WebUI 输入框里输入一条消息并点击“发送”；服务端只接收最新的 user 消息，其余全部由后端接管。

---

## 1. 支持的端点

| 请求方法 | 路由地址 | 协议与说明 |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | **OpenAI Chat Completions** 兼容协议（SSE 流式、思考过程、工具调用） |
| `POST` | `/v1/responses` | **OpenAI Responses** 兼容协议 |
| `POST` | `/v1/messages` | **Anthropic Claude Messages** 协议 |
| `GET` | `/v1/models` | 获取所有已挂载模型（ID 形如 `account/model`） |
| `GET` | `/v1/anthropic/models` | Anthropic 形状的模型列表（同样是 `account/model` ID） |
| `GET` | `/v1/models/{id}` | 获取单个模型（兼容斜杠 ID） |
| `GET` | `/v1/sessions` | 列出 JeikCode 会话，可用 `?user=<会话键>` 过滤 |
| `GET` | `/v1/sessions/{id}` | 按 UUID、前缀或精确 `user` 键读取单个会话 |

三个对话端点分别接受各自的 wire 格式，并返回各自的原生响应/SSE 结构。JeikCode 自己的元数据以附加字段形式放在 `jeikcode` 对象里，标准 SDK 解析器可以忽略。

---

## 2. 鉴权

携带启动时配置的 Bearer Token：

```http
Authorization: Bearer <your-token>
```

只有以 `--no-token` 启动时才可省略该请求头。

---

## 3. 会话语义

### 3.1 只准入最新的一条 user 消息

后端是会话历史的唯一管理者。每次请求：

- 只使用**最后一条 `role=user` 消息**作为本轮新提问；
- 更早的 `user` / `assistant` / `tool` 消息，包括尾部的 assistant prefill，全部忽略；
- 建议把新 user 消息放在最后一条；即使尾部有 assistant/tool，也只会被忽略，不会重放旧提问；
- 客户端的 `system` / `developer` 消息以及 OpenAI Responses 的 `instructions` 全部忽略；后端系统提示词、项目规则（`AGENTS.md`）、记忆、技能、MCP 工具与词林才是唯一的指令来源；
- 请把新提问作为请求的最后一条消息发送，不要重放整段历史。

这是有意设计的“纯前端”契约：等价于 WebUI 只向服务端发送一条新消息。也意味着客户端历史无法补救服务端会话——如果不传 `user`，每次请求都会创建新会话。

### 3.2 `user` 是会话键

`user` 是持久会话键，不只是滥用追踪标识：

```json
{
  "model": "account/model",
  "user": "alice_chat_1",
  "messages": [{ "role": "user", "content": "请分析当前项目的架构" }]
}
```

- 相同的 `user`：恢复同一个 JeikCode 会话；
- 不同的 `user`：创建不同会话；
- 省略或留空 `user`：本次请求生成临时 `api-<uuid>` 键。匿名请求不会共享任何全局会话。

服务端会把该键作为不可变的 `protocol_key` 与 session 一起保存，因此在 WebUI 里重命名会话不会破坏 API 恢复。响应始终带回解析后的身份：

```json
{
  "jeikcode": {
    "session_id": "6fe6640f-d69d-49cc-b581-d3e559d03753",
    "user": "alice_chat_1"
  }
}
```

无法设置 `user` 的客户端可以用 `jeikcode.session_id` 做诊断，但受支持的恢复契约仍然是 `user` 键。不需要额外请求头或新增字段。

### 3.3 Auto 模式，不弹审核窗

每个 `/v1/*` 回合都强制使用 **Auto** 审批模式：

- 不会产生 `permission_request`，不会弹出审批窗；
- 不会产生 `user_input_request`，不会弹出交互式提问窗；
- WebUI 的全局 Plan / Build / Accept Edits 开关不会影响 API 回合；
- 模型调用 `request_user_input` 时，问题会作为 assistant 的最终文本返回，工具调用以 declined 结束，模型等待用户的下一条消息。API 客户端通过发送下一条 user 消息来回答。

这就是“模型以文本询问”的模式。请求永远不会因为等待浏览器交互而阻塞。

### 3.4 回合运行中收到第二条请求会抢占

这些端点采用 latest-wins 语义：

- 同一个 `user` 的第二个请求会停掉正在运行的第一回合；
- 服务端等待第一回合的 snapshot / display 落盘完成，再启动新回合；
- 这等价于 WebUI 的**停止 + 发送**路径（已发出转向卡点“立即发送”的 `promote` 分支），不是 `/chat/steer`；
- 等待上限为 60 秒。旧回合无法及时释放时，请求返回 HTTP 409 `session_busy`。

真正的回合内 steer 是有状态交互能力，无法在“一问一答”的 OpenAI/Anthropic 调用里自然表达。需要两条消息进入同一回合的客户端应使用 WebUI，或等待后续独立的 steer 控制通道。

### 3.5 模型与工具

- `model` 每个请求都会重新解析。可以使用 `/v1/models` 返回的 `account/model`，也可以使用裸模型名或旧 catalog key；响应始终回显规范的 `account/model`。
- JeikCode 后端工具在服务端运行，工具调用按协议原生形状流式返回。
- 客户端带来的工具定义与 `role=tool` 历史不会使用。如果你的 Agent 依赖客户端工具循环，这个端点不是无状态模型提供商；请使用 WebUI 或独立的 Agent 集成。
- 最新 user 消息里的图片会转发给所选模型；当模型不支持视觉时，使用配置的视觉预处理器。

### 3.6 流式与非流式

- `stream: true` 返回原生 SSE 块（`/v1/chat/completions`、`/v1/responses`）或 Anthropic SSE 事件。
- `stream: false` 返回单个 JSON 响应。非流式收集器会交付最终面向用户的回答，并带 Todo 保护回锚：如果回合以 todo 工具收尾，且打勾前已有实质性正文，则返回打勾前的核心回答，而不是打勾后的短客套话。
- 关闭 HTTP 连接会取消对应回合，客户端超时不会继续消耗 token。

---

## 4. 调用示例

### 4.1 OpenAI Chat Completions

```bash
curl -X POST http://127.0.0.1:13457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "user": "alice_chat_1",
    "messages": [
      {"role": "user", "content": "请分析当前项目的架构特点"}
    ],
    "stream": true
  }'
```

继续同一个会话时，使用相同的 `user`，并且只发送新的 user 消息：

```bash
curl -X POST http://127.0.0.1:13457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "user": "alice_chat_1",
    "messages": [
      {"role": "user", "content": "现在重点看 daemon 的会话准入路径"}
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
    "input": "总结这次改动最可能的失败模式",
    "stream": true
  }'
```

`input` 可以是字符串，也可以是 `message` / `input_text` 项组成的数组；最新 user 消息中的 `input_image` 也受支持。`instructions` 在 wire 层可以传入，但会被忽略，因为后端提示词才是唯一权威。

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
      {"role": "user", "content": "解释一下会话大纲管线"}
    ],
    "stream": true
  }'
```

Anthropic 的 `system` 字段同样可以传入，但会被忽略。

### 4.4 列出模型与会话

```bash
curl http://127.0.0.1:13457/v1/models \
  -H "Authorization: Bearer your-token"

curl "http://127.0.0.1:13457/v1/sessions?user=alice_chat_1" \
  -H "Authorization: Bearer your-token"
```

---

## 5. 兼容性说明

| 行为 | 契约 |
| :--- | :--- |
| Wire 格式 | 原生 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages |
| 会话历史 | 服务端管理；客户端历史忽略 |
| 客户端 system 提示词 | 忽略 |
| 客户端工具 / 工具结果 | 不使用；运行 JeikCode 后端工具 |
| 会话身份 | `user` 键；同键恢复，不同键新会话 |
| 缺少 `user` | 临时 `api-<uuid>`；不共享全局会话 |
| 审批模式 | 强制 Auto；无审批/用户输入弹窗 |
| 运行中第二条请求 | 抢占（停止 + 新回合），不是 steer |
| 非流式最终回答 | 最后一段实质回答，带 Todo 保护回锚 |
| 连接断开 | 取消对应回合 |

如果客户端看起来“忘记”了对话，请确认它每次请求都发送相同的 `user` 键，并且没有期待服务端重放客户端的 `messages` 历史。省略 `user` 时，每次请求都会有意创建一个新会话。

---

## 6. 常见问题

- **回答忽略了客户端 system 提示词。** 预期行为：后端提示词是唯一权威。
- **模型看不到客户端之前的历史消息。** 预期行为：只准入最新 user 消息。复用 `user` 才能恢复会话。
- **WebUI 显示的会话与预期不同。** 检查响应里的 `jeikcode.session_id` 与 `user`；如果 `user` 被省略，会话会创建在 `api-<uuid>` 键下。
- **请求返回 409 `session_busy`。** 上一回合在 60 秒内没有释放。请在 WebUI 停止它，或在当前回合结束后重试。
- **客户端工具循环卡住。** 端点不接收客户端工具结果。请使用服务端工具或独立的 Agent 客户端。
