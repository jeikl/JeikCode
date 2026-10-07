# 04 - 词林配置教程 (Thesaurus)

---

## 1. 配置文件路径

- **工作区项目级**：`<workspace>/.jeikcode/thesaurus/*.txt`（优先加载）
- **用户全局级**：`~/.jeikcode/thesaurus/*.txt`

---

## 2. 配置格式与语法

在文件中按行配置中英文词条映射：

```text
# 注释以 # 开头
中文词1, 中文词2 = en_word1, en_word2
```

- **分隔符**：`=` 或 `<=>` 分隔中英文。
- **近义词分隔**：`,`、`，`、`|`、`/`。
- 支持 1:1、1:N、N:M 映射。

### 配置示例
新建 `.jeikcode/thesaurus/biz.txt`：
```text
风控, 反欺诈, 黑名单 = risk_control, anti_fraud, blacklist
积分商城, 积分兑换 = points_mall, point_exchange
```

### 内置词林对照表
| 文件名 | 适用领域 | 示例 |
| :--- | :--- | :--- |
| `admin_system.txt` | 管理后台 / RBAC 权限 | 权限, 鉴权 = permission, auth, rbac |
| `agent_core.txt` | Agent 核心概念 | 提示词, 工具调用 = prompt, tool_call |
| `ai_agent.txt` | 大模型交互与运行流 | 流式输出, 记忆 = stream, memory |
| `computer_science.txt` | 计算机体系与基础算法 | 事务, 锁, 队列 = transaction, lock, queue |
| `ailaierp.txt` | ERP 与零售业务 | 订单, 提成 = order, commission |
| `fullstack_dev.txt` | 全栈 Web 架构 | 控制器, 路由, 拦截器 = controller, route, interceptor |
| `medical.txt` | 医疗健康 | 患者, 病历, 处方 = patient, emr, prescription |
| `robotics.txt` | 机器人 | 位姿, 机械臂 = pose, manipulator |
| `web_http.txt` | HTTP 协议与通信 | 鉴权头, 状态码 = authorization, status_code |

---

## 3. 热生效说明

- **自动热生效**：编辑或新增 `*.txt` 词林文件保存后，系统根据 mtime 自动热重载。
- 无需执行重启或重载命令，下次执行检索或 `code_explore` 时直接生效。
