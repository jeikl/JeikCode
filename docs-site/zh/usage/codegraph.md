# 代码图谱

代码图谱是 JeikCode 区别于传统 AI 编码助手的一大核心利器。JeikCode 内置了一套极低资源开销、自动感知文件变化、深度支持中英文自然语言与业务语义检索的加权代码图谱引擎。

无论是跨文件的函数调用、类型定义追溯，还是结合中英文日常提问与业务黑话的模糊需求探索，代码图谱都能精准指引 Agent 定位核心实现。

---

## 语言与生态支持

JeikCode 原生支持主流编程语言的语法分析与拓扑提取：

| 编程语言 / 框架 | 语法解析器 | 支持特性 |
| :--- | :--- | :--- |
| **Rust** | Tree-Sitter Rust | 结构体、枚举、Trait 实现、宏展开上下文、模块树 |
| **TypeScript / JavaScript** | Tree-Sitter TS/JS | 类、函数、箭头函数、接口、JSX/TSX 导出与导入 |
| **Python** | Tree-Sitter Python | 类、函数、装饰器、模块与动态引用追踪 |
| **Go** | Tree-Sitter Go | Struct、Interface、函数、包方法与接收器 |
| **Java** | Tree-Sitter Java | 类、方法、注解、多层继承与接口实现 |
| **C / C++** | Tree-Sitter C/CPP | 函数原型、头文件引用、类与命名空间 |
| **C#** | Tree-Sitter C# | 类、命名空间、属性、异步方法与模式匹配 |
| **Vue** | Tree-Sitter Vue | `<script setup>` 组合式 API、模板绑定与组件依赖 |
| **PHP / Ruby** | Tree-Sitter PHP/Ruby | 面向对象结构、函数与类继承网络 |

---

## 索引构建与配置教程

### 1. 自动构建与无感增量监听
通常情况下，如果你处于普通项目文件夹中进行开发，**无需手动建立索引**。Agent 会在任务执行时自动按需建立索引；在日常保存文件时，引擎会自动感知文件变动并触发单文件增量 Patch（1~3ms 极速差量更新），全程自动同步，无需反复重建。

### 2. 多仓库（Multi-Repo）场景建议
如果你在一个包含多个独立仓库的上级目录中启动 JeikCode，且这些仓库并不属于同一个紧密相关的项目：
- **强烈建议进入每个独立的子项目仓库目录下分别启动或建立索引**；
- 这样可以避免跨项目全局索引产生巨大的符号检索噪音与混淆；
- *例外情况*：如果该多仓目录本身就是一个项目的前后端分离架构（例如同一工程下的 `web/` 与 `server/`），联合建索引才是有意义且高效的。

### 3. 手动构建命令
在目标项目根目录下执行以下命令，秒级完成全仓语法分析并生成图谱缓存：

```bash
# 首次或增量构建索引
jeikcode init

# 强制全量重新扫描整个仓库（清除旧缓存重建）
jeikcode init --force
```

### 4. 配合 `code_explore` 工具使用
在 Agent 执行任务期间，模型会通过内置的 `code_explore` 工具调用代码图谱能力：

```text
用户：“解释一下当前项目中用户登录是如何进行 JWT 校验与拦截的？”
↓
Agent 调用：code_explore(path="src", query="用户登录 JWT 校验拦截")
↓
代码图谱：
1. 词林扩展匹配 TokenValidator、verify_token、AuthMiddleware 等符号
2. 提取调用拓扑与上下文代码块
3. 汇总下游路由注入与上游拦截器链
↓
Agent 精准回复完整的架构时序与涉及的文件行号
```

你可以随时在与 Agent 的对话中直接提出针对业务或架构的宏观问题，无需提前查找具体的文件名或函数符号。

---

## 代码图谱忽略体系：.gitignore 与 .codegraphignore

为了保证代码图谱索引具备高信噪比与极速检索体验，图谱引擎在扫描文件时拥有严格的忽略过滤逻辑，支持 **默认绑定 Git 忽略**、**自定义独立解耦控制** 以及 **开箱即用内置规则**。

### 1. 默认与 `.gitignore` 强绑定
在标准的 Git 仓库中，代码图谱在初始化扫描时（通过 `git ls-files` 高性能管道）**默认严格遵循当前工作区的 `.gitignore` 规则**。所有已被 Git 排除的依赖库（如 `node_modules/`、`target/`）、构建输出、临时缓存与本地密钥，默认都不会进入图谱索引。

### 2. 深度解耦：`.codegraphignore` 独立配置
在实际工程开发中，常常存在一类特殊场景：**某些文件需要被 Git 正常版本追踪提交，但绝不应该被代码图谱解析建索引**。例如：
- 庞大的测试用例固定数据（Mock JSON、Fixture、海量 SQL 导入脚本）；
- 必须签入仓库的内嵌第三方库（Vendored 依赖包、单文件 UMD 组件库）；
- 自动生成的巨大协议桩代码（Protobuf 生成物、大型 ORM 实体映射代码）；
- 项目附带的巨型静态资产或模板文件。

若为了图谱去修改 `.gitignore`，会导致 Git 无法提交这些必要资产。**JeikCode 支持通过 `.codegraphignore` 将图谱索引与 Git 忽略完全解耦**：
- **核心机制**：**在 `.codegraphignore` 中声明的文件，即使 Git 已经追踪并提交，代码图谱在构建索引时也会直接将其精准忽略**！
- **语法标准**：完全兼容标准 Glob 与 GitIgnore 模式（支持通配符 `*`、目录级规则 `/` 与取反 `!`）。

#### 配置文件存放位置
你可以根据需要将 `.codegraphignore` 放置在以下位置（优先级从项目到全局自动叠加）：
1. **项目根目录（推荐）**：`<workspace>/.codegraphignore`（直接对当前项目生效）
2. **项目级隐藏目录**：`<workspace>/.jeikcode/.codegraphignore`
3. **全局用户配置**：`~/.jeikcode/.codegraphignore`（跨所有本地项目全局生效）

#### 完整示例模板
新建或修改 `.codegraphignore`，将需要从图谱中排除的文件或模式逐行填入：

```sh
# ==============================================================================
# .codegraphignore — 代码图谱与符号索引忽略规则
# ==============================================================================
# 无论文件是否在 Git 中被追踪，只要匹配以下规则，均会被代码图谱精准忽略。

# 1. 自动生成物与压缩产物 (Generated & Minified Assets)
*.generated.*
*.g.cs
*.designer.cs
*.min.js
*.min.css
*.bundle.js
*.map
element-ui/
element-plus/

# 2. 前端生态依赖与缓存
node_modules/
dist/
.output/
.next/
.nuxt/
.turbo/
.cache/
coverage/
*.tsbuildinfo

# 3. Python 虚拟环境与字节码
__pycache__/
*.py[cod]
.venv/
venv/
.pytest_cache/

# 4. Java / JVM 生态产物
.gradle/
*.class
*.jar
*.war

# 5. Rust 编译产物
target/
*.rlib

# 6. C / C++ / Native 二进制与符号表
cmake-build-*/
*.o
*.obj
*.so
*.dll
*.exe
*.pdb

# 7. C# / .NET 输出
bin/
obj/
TestResults/

# 8. Go / PHP 内嵌依赖
vendor/

# 9. IDE 配置与操作系统临时文件
.git/
.idea/
.vscode/
.DS_Store
Thumbs.db
*.log
```

> **生效说明**：修改并保存 `.codegraphignore` 后，下次自动构建索引（或保存文件触发增量监听、执行 `jeikcode init --force`）时将立即生效。

### 3. 底层硬编码的默认内置忽略
即使当前项目没有任何 `.gitignore` 或 `.codegraphignore`，JeikCode 引擎底层也内置了以下坚固的防护防线：
- **目录级硬过滤 (`SKIP_DIR_NAMES`)**：自动跳过 `node_modules`、`target`、`bin`、`obj`、`dist`、`build`、`.venv`、`vendor`、`coverage` 等 30+ 常见依赖和构建目录；
- **自动生成代码识别 (`is_generated_source`)**：自动跳过 `*.designer.cs`、`*.g.cs`、`AssemblyInfo.cs`、`*.min.js`、`*.bundle.js`、`*.map` 等常见自动生成或压缩文件；
- **单行巨型 Web 包拦截 (`is_minified_web_bundle`)**：当 JS/CSS 文件体积超过 32KB 且前 4KB 换行少于 4 次时，判定为单行打包产物自动阻断，防止 Tree-Sitter 语法解析爆炸；
- **单文件体积安全上限 (`max_index_file_bytes`)**：前端脚本及样式单文件上限 256KB，其他源代码上限 768KB，杜绝非代码大文件撑爆内存。
