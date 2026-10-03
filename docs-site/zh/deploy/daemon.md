# 后台 Daemon 与无头运行 (Headless)

除了交互式终端 (TUI) 外，JeikCode 还提供了两种无头运行能力：
1. **Headless CLI 模式 (`-p / --prompt`)**：适用于脚本调度、CI/CD 自动化检测与命令行管道集成；
2. **后台 Daemon 服务 (`jeikcode daemon`)**：基于 HTTP + SSE 的常驻服务，供各类远程客户端、Web 前端或 IDE 插件调用。

---

## 1. Headless CLI 单次任务模式

通过给 `jeikcode` 传入 `-p / --prompt` 参数，即可单次执行一条具体指令并将最终结果直接输出到标准输出（stdout），类似 Unix 流式工具管道：

```bash
# 生成仓库快速概览
jeikcode -p "总结当前项目的技术栈与主要模块"

# 将输出直接重定向保存为文件
jeikcode -p "为当前包编写 README.md 模板" > README.draft.md

# 在 CI 流水线中进行代码格式检查与自动修复
jeikcode -p "运行单元测试并修复因空指针引发的 panic，不要修改接口定义" \
         --max-turns 20 --disable-tools web_search,web_fetch
```

### 常用 Headless 参数

| 参数 | 说明 |
| :--- | :--- |
| `-p, --prompt TEXT` | 要执行的任务或提问描述 |
| `--prompt-file PATH` | 从指定文件读取任务描述（适合超长输入，与 `-p` 互斥） |
| `-v, --verbose` | 将工具调用日志、Token 统计打到 stderr，不污染 stdout 管道 |
| `--max-turns N` | 强制限制最多执行 N 轮 LLM 交互，防止长任务死循环跑飞 |
| `--disable-tools LIST` | 禁用指定工具列表（如 `bash,web_fetch`） |
| `-C, --dir PATH` | 设定工作目录（默认为当前目录） |
| `--provider / --model` | 临时覆盖本次运行的 Provider 或模型 |
| `--no-telemetry` | 本次执行关闭任何遥测统计 |

---

## 2. 后台 Daemon 常驻服务

Daemon 服务将 JeikCode 核心能力封装为标准的 RESTful 与 Server-Sent Events (SSE) 服务，非常适合集中化部署或多租户云环境。

### 启动服务
```bash
jeikcode daemon --host 0.0.0.0 --port 8000
```

### Systemd 服务配置示例 (Linux)

在 `/etc/systemd/system/jeikcode-daemon.service` 创建配置：

```ini
[Unit]
Description=JeikCode Background Daemon Service
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu
ExecStart=/usr/local/bin/jeikcode daemon --host 127.0.0.1 --port 8000
Restart=always
RestartSec=5
Environment=JEIKCODE_CONFIG_DIR=/home/ubuntu/.jeikcode

[Install]
WantedBy=multi-user.target
```

启动并设置开机自启：
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jeikcode-daemon
```

---

## 3. Docker 容器化运行

仓库 `docker/` 目录下提供了生产级 Docker 镜像构建文件：

```bash
# 构建 Daemon 镜像
docker build -t jeikcode-daemon -f docker/Dockerfile-Daemon .

# 启动容器并挂载本地项目和配置
docker run -d \
  --name jeikcode \
  -p 8000:8000 \
  -v ~/.jeikcode:/root/.jeikcode \
  -v $(pwd):/workspace \
  jeikcode-daemon
```
