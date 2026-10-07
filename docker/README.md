# JeikCode Docker 镜像

本目录包含 Docker 消费端配置：

- **Dockerfile-TUI** - 将官方 Linux x64 CLI 制品本地打包后用于终端体验。
- **Dockerfile-Daemon / Dockerfile-Daemon-Tosslib** - 旧的独立 daemon 消费端；官方 Release 不提供其所需二进制。

**发布权威指南**：[main / Tag / GitHub Actions 流程](../docs/release-tutorial.md)。
`.github/workflows/build.yml` 的 Linux prepare 步骤生成 `dist/jeikcode-${TAG_NAME}-linux-x64` 与 `...-linux-arm64` 原始可执行文件；`publish` 上传 `dist/jeikcode-*` 和 `dist/latest.json`，没有 CLI tar 包或 `jeikcode-daemon-*` 资产。`scripts/publish-release.js` 的 `assetName` 也使用 `jeikcode-<tag>-<target>`（Windows 加 `.exe`）。

下载或解包 Actions artifact、重命名和本地 staging 只是 Docker 构建准备。手动构建/推送镜像不等于官方 publish，不生成更新清单；不要调用已退役的 `release.sh` 或 `release-self-update.sh`。

---

## JeikCode TUI 镜像

用于在 macOS 或 Windows 上体验 Linux 版本的 JeikCode 终端界面。

### 构建镜像

从仓库根目录在 Bash 中执行；需要 `curl`、Node.js、`tar` 和 Docker。以下从官方最新稳定 Release 的 `latest.json` 读取实际 tag 并校验 SHA256/大小，不进行本地交叉编译：

```bash
set -euo pipefail
stage=$(mktemp -d)
curl -fL https://github.com/jeikl/JeikCode/releases/latest/download/latest.json -o "$stage/latest.json"
tag=$(node -e 'const m=require(process.argv[1]); console.log("v" + m.version.replace(/^v/, ""))' "$stage/latest.json")
asset="jeikcode-${tag}-linux-x64"
curl -fL "https://github.com/jeikl/JeikCode/releases/download/${tag}/${asset}" -o "$stage/$asset"
node -e 'const fs=require("fs"), c=require("crypto"); const m=JSON.parse(fs.readFileSync(process.argv[1])); const b=fs.readFileSync(process.argv[2]); const e=m.binaries["linux-x64"]; if (!e || b.length!==e.size || c.createHash("sha256").update(b).digest("hex")!==e.sha256) throw Error("Release checksum/size mismatch");' "$stage/latest.json" "$stage/$asset"

# 保持现有 Dockerfile 的 COPY 和解包后 mv 文件名契约。
chmod +x "$stage/$asset"
mv "$stage/$asset" "$stage/jeikcode-jeikcode-${tag}-linux-x64"
mkdir -p "dist/jeikcode-${tag}"
tar -czf "dist/jeikcode-${tag}/${asset}.tar.gz" -C "$stage" "jeikcode-jeikcode-${tag}-linux-x64"
docker build --platform linux/amd64 -t jeikcode -f docker/Dockerfile-TUI .
rm -rf "$stage"
```

`COPY` 匹配 `dist/jeikcode-v*/jeikcode-*-linux-x64.tar.gz`，解包后 `mv` 匹配 `/tmp/jeikcode-jeikcode-v*-linux-x64`。官方资产本身**不是 tar.gz**；上面的归档是本地兼容包装，不上传到 Release。如改用下载的 `cli-linux` Actions artifact，先解包取出同名原始 CLI，再校验并按同一契约 staging。构建上下文中只保留一个匹配归档，避免通配符匹配多版本；此 Dockerfile 固定 x64，因此使用 `linux/amd64`（ARM 主机需仿真）。

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

### 制品契约与限制

两个 daemon Dockerfile 都要求 `dist/v*/jeikcode-daemon-*-linux-x64`，并以 `jeikcode-daemon` 为入口。官方 main/tag 流水线只发布 CLI，不能把 `jeikcode-<tag>-linux-x64` 重命名成 daemon 来满足该契约，也不能从官方 Release 下载不存在的 daemon 资产。

这些是旧部署配置，不是当前官方发布教程。只有已经持有经过验证的独立 Linux x64 daemon 制品、按上述路径手动 staging 且确保仅一个文件匹配的维护者，才能继续使用下述旧部署示例；其中 `v5.0.3` 是历史本地镜像标签，不是官方 daemon 下载承诺。本文不提供恢复旧交叉编译脚本的步骤；IDE 专用 `release-daemon.sh` 也不构成官方 Docker 发布流程。没有独立 daemon 制品时应停止，不执行下面的构建/推送命令。

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
