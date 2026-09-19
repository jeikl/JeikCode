# JeikCode Docker 镜像

本目录包含两种 Docker 镜像：

- **Dockerfile-Daemon** - 用于部署 JeikCode Daemon 后台服务
- **Dockerfile-TUI** - 用于在 macOS/Windows 上体验 Linux 版本的 JeikCode TUI

---

## JeikCode TUI 镜像

用于在 macOS 或 Windows 上体验 Linux 版本的 JeikCode 终端界面。

### 构建镜像

```bash
# 1. 先编译 Linux 版本（需要 musl 交叉编译工具）
brew install FiloSottile/musl-cross/musl-cross
./scripts/release.sh

# 2. 构建 Docker 镜像
docker build -t jeikcode -f docker/Dockerfile-TUI .
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

## 构建镜像

首先运行 release 脚本生成 Linux 二进制文件：

```bash
./scripts/release.sh
```

然后构建 Docker 镜像：

```bash
docker build -t jeikcode-daemon:v5.0.3 -f docker/Dockerfile-Daemon .
```

### 推送到华为云 SWR

华为云 SWR 基础版不支持 OCI 规范的镜像格式。如果你使用的是较新版本的 Docker（BuildKit），需要添加 `--provenance=false` 参数：

```bash
# 标记镜像
docker tag jeikcode-daemon:v5.0.3 swr.cn-north-4.myhuaweicloud.com/gitcode-be/jeikcode-daemon:v5.0.3

# 使用 buildx 构建并推送（推荐）
docker buildx build --provenance=false --platform linux/amd64 -t swr.cn-north-4.myhuaweicloud.com/gitcode-be/jeikcode-daemon:v5.0.3 --push -f docker/Dockerfile-Daemon .

# 或者先构建再推送
docker build --provenance=false -t swr.cn-north-4.myhuaweicloud.com/gitcode-be/jeikcode-daemon:v5.0.3 -f docker/Dockerfile-Daemon .
docker push swr.cn-north-4.myhuaweicloud.com/gitcode-be/jeikcode-daemon:v5.0.3
```

> **注意**: 如果不添加 `--provenance=false`，推送时会报错: `Invalid image, fail to parse 'manifest.json'`

## 运行容器

### 基本运行

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  jeikcode-daemon:v5.0.3
```

### 挂载配置文件

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -v /path/to/config.toml:/root/.jeikcode/config.toml \
  jeikcode-daemon:v5.0.3
```

### 挂载项目目录

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -v /path/to/config.toml:/root/.jeikcode/config.toml \
  -v /path/to/project:/workspace \
  jeikcode-daemon:v5.0.3
```

### 传递环境变量

```bash
docker run -d --name jeikcode-daemon \
  -p 13456:13456 \
  -e ANTHROPIC_API_KEY=your-api-key \
  -v $(pwd)/config.toml:/root/.jeikcode/config.toml \
  jeikcode-daemon:v5.0.3
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
