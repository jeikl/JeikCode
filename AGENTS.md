# JeikCode / JeikCode 项目全局开发约束

## 1. 架构分层与状态所有权

当前 coding agent 的唯一运行时调用链路：

```text
CLI / TUI / daemon / background / ACP / clix
                    │
                    ▼
       CodingRuntimeHandle / DriverCommand
                    │
                    ▼
          jeikcode-coding (CodingRuntime)
                    │
                    ▼
          jeikcode-kernel (Neutral Agent)
```

- **`jeikcode-kernel` (L0)**：纯净中立的 Agent 执行循环，不包含任何 coding 业务、provider 选择、session 或文件操作特化。
- **`jeikcode-capabilities` (L1)**：提供可复用的中立工具（文件读写、Bash、CodeIntel 图谱检索、JeikCode 配置指南等）与会话 Hook，严格保持无前端、无 L2 反向依赖。
- **`jeikcode-coding` (L2)**：业务生命周期的唯一所有者（CodingRuntime）。管理 Provider 组装、Prompt Persona、任务规划、子代理调度、会话压缩与终端状态机。
- **Driver / UI 层**：负责交互、输入输出、终端渲染与通信协议，禁止另建第二套 Live Agent 生命周期。

---

## 2. 核心机制与开发不变量

### 2.1 提示词热重载与优先级裁决 (Precedence)
- **动态生效 (Live)**：`prompts/init.yaml`（身份/环境）、`prompts/rules.yaml`（工作流/工具纪律）以及 `user-wrap.md`（提问包装模板）基于 mtime 自动热重载，修改立即生效无须重启；
- **种子说明文件 (Seed Docs)**：`root_docs_*` 仅作为开发者参考文档，严禁加载进模型上下文；
- **用户提问包装 (`user-wrap.md`)**：支持全局（`~/.jeikcode/`）与项目级（`./.jeikcode/` 或 `./`）配置，通过 `{{input}}` 动态包裹用户最后一条真实提问，项目级覆盖全局；
- **项目级规则最高裁量权**：凡是带有结构化标记的项目规范（`=== ... (*.md) ===` 或 `-----**.md------`，如 `AGENTS.md`、`JEIKCODE.md`、`rules.md`、`dbwords.md` 等），在模型决策中**严格优先于 System 默认规则**。

### 2.2 KV Cache 前缀稳定性与上下文压缩保护 (Prompt Caching & Sacred Floor)
- 会话前缀必须保持 **Append-only** 字节级不可变性；
- `SessionContextHook` 注入的项目指令与环境事实在会话首部紧凑合并；Git 状态维持会话初快照以防止缓存击穿；
- 记忆（`memory.md`）作为 `synthetic User` 注入，受 `sacred_floor` 保护，压缩时永不丢失。

### 2.3 CodeIntel 图谱探索与词林双语检索 (Thesaurus)
- 功能与链路探索优先使用 `repo_map`（全景文件树）与 `code_explore`（调用图谱+源码），禁止多轮低效的 grep-and-wander；
- 中文代码检索依赖 `~/.jeikcode/thesaurus/*.txt` 领域词林进行双语多对多对齐，新增领域术语应优先补充词林词典。

### 2.4 模型与提供商解耦 (Provider & Models)
- 采用 `[provider_accounts.*]`（账号/凭据）与 `[models.*]`（模型参数/协议）解耦架构；
- 支持 `reasoning_history`（`"include"` / `"exclude"`）、`reasoning_effort` 档位切换与 `vision_preprocessor_provider` 视觉代答。

---

## 3. ~/.jeikcode 配置与 Teaches 知识库同步规范

`crates/jeikcode-capabilities/assets/teaches/`（及宿主机 `~/.jeikcode/teaches/`）中的渐进式模块化文档是编译后成品中 **`jeikcode_config_guide` 工具的直接知识源**：

1. **同变同更硬性约束**：凡修改了 `~/.jeikcode` 相关配置项、解析逻辑、参数默认值、超时机制、模型协议或目录结构，**必须同步修改对应的 `teaches/` 分类文档**（`01_prompts_and_context.md` 至 `08_updates_and_releases.md`）；
2. **构建打包自动同步**：`crates/jeikcode-cli/build.rs` 会在编译时自动抓取宿主机 `~/.jeikcode` 最新资产注入成品，并保持配置更新的交互式勾选与用户模型保护机制。

---

## 4. 验证与交付

- 修改过程中优先运行单元测试；涉及多 crate 或公共协议变更时运行 `cargo check --workspace`；
- 修改提示词、配置项或文档时，必须核对 `teaches/` 与实现代码的一致性。

---

## 5. Git 提交与共同署名规范 (Commit & Co-Authorship)

- **强制附带共同署名**：任何由 Agent 生成或辅助生成的 Git 提交，提交信息（commit message）末尾必须严格包含 JeikCode 官方共同署名 Trailer：
  ```text
  Co-Authored-By: JeikCode <331041501+JeikCode@users.noreply.github.com>
  ```
- **格式规范**：
  - 遵循 Conventional Commits 规范（例如 `feat(...)`, `fix(...)`, `refactor(...)`, `docs(...)` 等）；
  - 提交正文（commit body）与 Trailer 之间必须保留一个空行；
  - 严禁遗漏该署名，严禁混用已废弃的历史旧品牌（如 AtomCode 等）署名。

---

## 6. 安装与自动化发版规范 (Installation & Release Pipeline)

为了保证所有 Agent 与维护者在发版与部署时有唯一权威路径，严禁使用任何废弃的历史手动流程：

### 6.1 组织、主干与兼容分支定位
- **官方代码仓**：`https://github.com/jeikl/JeikCode`；
- **主干与发版基准 (`main`)**：所有正式发布、Tag 标签、在线安装脚本默认抓取与 `latest.json` 均严格以 `main` 分支为准；
- **历史兼容分支 (`local-dev`)**：仅用于阶段性功能研发与向下兼容历史遗留脚本，不作为正式制品的发布依据。

### 6.2 官方统一安装方式
- **Linux / macOS / HarmonyOS PC**：
  ```bash
  curl -fsSL https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.sh | bash
  ```
- **Windows (PowerShell)**：
  ```powershell
  irm https://raw.githubusercontent.com/jeikl/JeikCode/main/scripts/install.ps1 | iex
  ```
- **源码编译安装**：
  ```bash
  cd webui && npm run build && cd ..
  cargo install --path crates/jeikcode-cli --bin jeikcode --locked
  ```
- **桌面端**：Release 里的安装包（Windows NSIS、macOS dmg、Linux deb / AppImage）。窗口打开本机 WebUI，并把同一个 `jeikcode` 放到 `~/.local/bin`。
- 详见权威指南：[`docs/release-tutorial.md`](./docs/release-tutorial.md)。

### 6.3 发版

稳定版只从 `main` 打纯数字 Tag。不要手改版本号，不要把 `latest.json` 提交进仓库。

1. 对照上一 Tag 至今的提交，在 `CHANGELOG.md` 顶部追加 `## vX.Y.Z (YYYY-MM-DD)`，只写本版用户可见变更。标题与 Tag 逐字一致。
2. 稳定版把同一段摘要写进 `README.zh-CN.md`、`README.md`、`README.en.md`，放在 License 之前的「更新日志 / Changelog」。没有这一节就加上。带 `-` 的预发布只改 `CHANGELOG.md`，不改 README。
3. 提交并推到 `origin/main`。工作区必须干净。
4. 打比上一版更高的 Tag 并推送：`git tag vX.Y.Z && git push origin vX.Y.Z`
5. 流水线编译六个架构并创建一次 Release。SHA256 清单随 Release 上传，客户端读 `releases/latest/download/latest.json`。
6. 带 `-` 的 Tag（如 `vX.Y.Z-beta.1`）只作 prerelease，不占 `releases/latest`。

发版流水线不再往 `main` 追加提交。细则见 [`docs/release-tutorial.md`](./docs/release-tutorial.md)。

