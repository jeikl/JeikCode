# API 兼容端点（OpenAI、Anthropic）

JeikCode 服务不仅提供 WebUI 界面，还在同一端口上暴露标准的大模型兼容 HTTP API。第三方客户端、IDE 插件或外部自动化系统可以直接将 JeikCode 作为标准上游大模型端点调用。

---

## 1. 支持的端点列表

| 请求方法 | 路由地址 | 协议与说明 |
| :--- | :--- | :--- |
| `POST` | `/v1/chat/completions` | **OpenAI Chat Completions** 兼容协议（支持流式 SSE、思考过程与工具调用） |
| `POST` | `/v1/responses` | **OpenAI Responses** 原生流式协议 |
| `POST` | `/v1/messages` | **Anthropic Claude Messages** 协议 |
| `GET` | `/v1/models` | 获取当前所有已挂载的模型列表（ID 格式形如 `account/model`） |

---

## 2. 鉴权与调用规范

- **认证请求头**：携带在服务启动参数中指定的 Token：
  ```http
  Authorization: Bearer <your-token>
  ```
  （若启动时传入 `--no-token` 则无需鉴权）。
- **直接驱动本地 Agent**：这些端点并非简单的转发代理，而是直接由 JeikCode 核心运行时驱动。请求会自动结合项目上下文规范（`AGENTS.md` 等），并在流式响应中实时输出思考过程（Thinking）与工具执行进度。

---

## 3. 调用示例 (cURL)

```bash
curl -X POST http://127.0.0.1:13457/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-token" \
  -d '{
    "model": "deepseek/deepseek-v4.1-flash",
    "messages": [
      {"role": "user", "content": "请分析当前项目的架构特点"}
    ],
    "stream": true
  }'
```
