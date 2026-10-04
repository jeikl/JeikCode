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

### 6.3 发版与更新日志规范

稳定版从 `main` 分支发布，Tag 格式为 `vX.Y.Z`。发版时需按顺序完成以下文件更新与操作：

1. **更新 `CHANGELOG.md`**：在文件顶部追加 `## vX.Y.Z (YYYY-MM-DD)`。发版说明采用**双语分段标准模板**（英文讲完一整段，再来个分割线 `---`，讲中文；安装路由由流水线统一自动生成纯英文直链，禁止中英混排）：
   - **英文段落 (English Section)**：以 `- **[Module/Category] English summary**: ` 为主条目，展开二级子项详述 Root Cause、Implementation Mechanism 与 Verification；
   - **分割线**：段落之间严格使用单独一行的 `---` 分隔；
   - **中文段落 (Chinese Section)**：以 `- **[模块分类] 中文概述**: ` 为主条目，按技术机理、实现防线与验证层次展开二级子项；
   - **模型填写模板**：
     ```markdown
     ## vX.Y.Z (YYYY-MM-DD)

     - **[Category/Module in English] Main summary sentence in English**:
       - **Technical Root Cause / Detail**: Detailed technical explanation...
       - **Implementation Mechanism**: Affected files, functions, and defensive logic...
       - **Verification & Testing**: Tests executed and coverage details...

     ---

     - **[模块分类中文] 中文概述主标题**:
       - **技术机理 / 现象溯源**: 详细原理解释...
       - **实现防线 / 核心改动**: 受影响文件、核心函数与端到端防线建设...
       - **验证与交付**: 运行的单元测试与端到端验证...
     ```
2. **同步更新文档日志**：将上述更新内容同步更新至以下三份文档的「更新日志 / Changelog」章节（位于 License 之前），仅保留最近 2 个版本的更新记录，并附带 CHANGELOG.md 与 GitHub Releases 链接：
   - `README.zh-CN.md`（同步中文段落）
   - `README.md`（同步英文段落）
   - `README.en.md`（同步英文段落）
   （注：预发布版本带 `-` 如 `vX.Y.Z-beta.1` 仅更新 `CHANGELOG.md`）。完整更新历史由 [CHANGELOG.md](./CHANGELOG.md) 和 [GitHub Releases](https://github.com/jeikl/JeikCode/releases) 追溯。
3. **提交与推送**：提交代码并推送到 `origin/main`，保持工作区干净。
4. **打 Tag 并触发发布流水线**：
   ```bash
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```
   GitHub Actions 流水线将自动读取 `CHANGELOG.md` 中对应章节生成详尽的 GitHub Release Notes（顶部为全英文桌面与终端安装路由，中英文日志以分割线清晰分段），编译六大架构二进制与安装包并发布。
5. **预发布说明**：带 `-` 的 Tag（如 `vX.Y.Z-beta.1`）作为 prerelease，不占 `releases/latest`。

发版细则详见 [`docs/release-tutorial.md`](./docs/release-tutorial.md)。

