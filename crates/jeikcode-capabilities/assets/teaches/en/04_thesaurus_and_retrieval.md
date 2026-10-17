# 04 - Thesaurus and Code Retrieval Guide (Thesaurus)

---

## 1. Configuration File Paths

- **Workspace Project-Level**: `<workspace>/.jeikcode/thesaurus/*.txt` (Loaded with highest precedence)
- **User Global-Level**: `~/.jeikcode/thesaurus/*.txt`

---

## 2. Configuration Schema & Syntax

Configure Chinese-to-English and synonym term mappings line by line:

```text
# Comments start with #
Chinese_word1, Chinese_word2 = en_word1, en_word2
```

- **Separators**: `=` or `<=>` separates bidirectional mappings.
- **Synonym Separators**: `,`, `，`, `|`, `/`.
- Supports 1:1, 1:N, and N:M term mappings.

### Configuration Example
Create `.jeikcode/thesaurus/biz.txt`:
```text
风控, 反欺诈, 黑名单 = risk_control, anti_fraud, blacklist
积分商城, 积分兑换 = points_mall, point_exchange
```

### Built-in Thesaurus Reference
| File Name | Domain | Example |
| :--- | :--- | :--- |
| `admin_system.txt` | Admin Console / RBAC Permissions | 权限, 鉴权 = permission, auth, rbac |
| `agent_core.txt` | Agent Core Concepts | 提示词, 工具调用 = prompt, tool_call |
| `ai_agent.txt` | LLM Interaction & Agent Runtime | 流式输出, 记忆 = stream, memory |
| `computer_science.txt` | Computer Systems & Core Algorithms | 事务, 锁, 队列 = transaction, lock, queue |
| `ailaierp.txt` | ERP & Retail Systems | 订单, 提成 = order, commission |
| `fullstack_dev.txt` | Fullstack Web Architecture | 控制器, 路由, 拦截器 = controller, route, interceptor |
| `medical.txt` | Healthcare & EMR | 患者, 病历, 处方 = patient, emr, prescription |
| `robotics.txt` | Robotics & Control | 位姿, 机械臂 = pose, manipulator |
| `web_http.txt` | HTTP Protocol & Networking | 鉴权头, 状态码 = authorization, status_code |

---

## 3. Hot-Reload Semantics

- **Automatic Hot-Reload**: Editing or creating `*.txt` thesaurus files triggers automatic hot-reloading based on file mtime.
- No restart or reload command is required; changes take effect immediately on the next symbol search or `code_explore` query.
