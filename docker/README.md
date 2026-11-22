# JeikCode Docker 镜像

本目录包含两种 Docker 镜像：

- **Dockerfile-Daemon** - 用于部署 JeikCode Daemon 后台服务
- **Dockerfile-TUI** - 用于在 macOS/Windows 上体验 Linux 版本的 JeikCode TUI

---

## JeikCode TUI 镜像

用于在 macOS 或 Windows 上体验 Linux 版本的 JeikCode 终端界面。

### 构建镜像

```bash
# 1. 准备 Linux x64 二进制（二选一）
#    a) 从 GitHub Release 下载 jeikcode-<tag>-linux-x64
#    b) 本地 musl 交叉编译：
#       brew install FiloSottile/musl-cross/musl-cross
rustup target add x86_64-unknown-linux-musl
cargo build --release --locked --target x86_64-unknown-linux-musl -p jeikcode
mkdir -p dist/local
cp target/x86_64-unknown-linux-musl/release/jeikcode dist/local/jeikcode-linux-x64

# 2. 构建 Docker 镜像
docker build \
  --build-arg JEIKCODE_BIN=dist/local/jeikcode-linux-x64 \
  -t jeikcode -f docker/Dockerfile-TUI .
```

### 运行容器

```bash
# 基本运行
docker run --rm -it jeikcode

# 挂载配置和项目目录
docker run --rm -it \
  -v ~/.jeikcode:/root/.jeikcode \
  -v $(pwd):/workspace \
  jeikcode

# 指定工作目录
docker run --rm -it \
  -v ~/.jeikcode:/root/.jeikcode \
  -v /path/to/project:/workspace \
  jeikcode

# 传递环境变量（API Key）
docker run --rm -it \
  -e ANTHROPIC_API_KEY=your-api-key \
  -v ~/.jeikcode:/root/.jeikcode \
  jeikcode
```

> **注意**: TUI 模式需要 `-it` 参数来启用交互式终端。

---

## JeikCode Daemon 镜像

> 目前没有 CI 预构建/预推送的镜像。发布流水线只产出 `jeikcode` 单文件，镜像请用该二进制自行构建。

## 构建镜像

先准备 Linux 二进制：从 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 下载 `jeikcode-<tag>-linux-x64`，或本地编译：

```bash
rustup target add x86_64-unknown-linux-musl
cargo build --release --locked --target x86_64-unknown-linux-musl -p jeikcode
mkdir -p dist/local
cp target/x86_64-unknown-linux-musl/release/jeikcode dist/local/jeikcode-linux-x64
```

然后构建 Docker 镜像：

```bash
docker build \
  --build-arg JEIKCODE_BIN=dist/local/jeikcode-linux-x64 \
  -t jeikcode-daemon:latest -f docker/Dockerfile-Daemon .
```

镜像入口为 `jeikcode daemon --host 0.0.0.0 --port 13456`，因此运行容器时必须提供 token：

## 运行容器

### 基本运行

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -e JEIKCODE_SERVER_TOKEN=sk-your-secret-token \
  jeikcode-daemon:latest
```

### 挂载配置文件

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -e JEIKCODE_SERVER_TOKEN=sk-your-secret-token \
  -v /path/to/config.toml:/root/.jeikcode/config.toml \
  jeikcode-daemon:latest
```

### 挂载项目目录

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -e JEIKCODE_SERVER_TOKEN=sk-your-secret-token \
  -v /path/to/config.toml:/root/.jeikcode/config.toml \
  -v /path/to/project:/workspace \
  jeikcode-daemon:latest
```

### 传递环境变量

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -e ANTHROPIC_API_KEY=your-api-key \
  -v $(pwd)/config.toml:/root/.jeikcode/config.toml \
  jeikcode-daemon:latest
```

## 验证服务

```bash
# 测试 API
curl http://localhost:13456/

# 查看日志
docker logs jeikcode-daemon
```

## 常用命令

```bash
docker start jeikcode-daemon     # 启动
docker stop jeikcode-daemon      # 停止
docker restart jeikcode-daemon   # 重启
docker rm -f jeikcode-daemon     # 删除
docker logs -f jeikcode-daemon   # 查看日志
```
