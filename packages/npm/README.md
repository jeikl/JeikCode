# @github.com/jeikcode

[![npm version](https://img.shields.io/npm/v/@github.com/jeikcode)](https://www.npmjs.com/package/@github.com/jeikcode)
[![license](https://img.shields.io/npm/l/@github.com/jeikcode)](https://github.com/JeikCode/JeikCode)

**JeikCode** — 开源终端 AI 编码助手。用自然语言描述任务，自动阅读代码、编辑文件、执行命令、验证结果。

## 安装

```bash
npm install -g @github.com/jeikcode
```

安装完成后即可使用：

```bash
jeikcode
```

> 安装时 npm 会自动下载匹配当前平台的预编译二进制（darwin/linux arm64+x64, windows x64, ohos arm64）。

## 使用

```bash
# 交互模式（TUI）
jeikcode

# 指定项目目录
jeikcode -C /path/to/project

# 指定模型
jeikcode --model gpt-4o

# 非交互模式（headless）
jeikcode -p "解释这个仓库的架构"

# 继续上次对话
jeikcode --continue
```

## 卸载

```bash
npm uninstall -g @github.com/jeikcode

# 或使用内置卸载命令（会保留配置文件）
jeikcode uninstall
```

## 版本对应

npm 版本号与 JeikCode 发布版本一致。详见 [Releases](https://github.com/JeikCode/JeikCode/releases)。

## 链接

- [源码仓库](https://github.com/JeikCode/JeikCode)
- [Issues](https://github.com/JeikCode/JeikCode/issues)
- [许可证](https://github.com/JeikCode/JeikCode/blob/main/LICENSE)

---

Built with Rust, ratatui, and a lot of late nights.
