# 更新与卸载

详细教程：https://jeikcode.top/zh/guide/updates.html

桌面版、浏览器异地环境和命令行无头环境都支持多版本更新与回退。Windows、macOS、Linux 使用同一套命令。提示语言跟随 JeikCode 的界面语言（简体中文、英文、越南文）。

更新只会解析发布清单中实际存在的目标。不支持的 32 位用户态（ARM/x86）与 MIPS 会以明确错误 fail-closed，不会下载错误架构的二进制。

---

## 1. 桌面版与 WebUI

在桌面版或浏览器里，点击右上角的更新。可以选择正式版或测试版，查看该版本的更新说明，安装较新版本，或改装到列表中的其他版本。

更新完成后页面会自动刷新，并进入新版本。用手机、另一台电脑或其他网络里的浏览器打开同一服务时，更新和回退方式相同。

---

## 2. 命令行

无头服务器上直接执行下面的命令即可，不需要桌面窗口。需要跳过配置确认时加上 `-y`。

### 查看已发布的版本

```bash
jeikcode list
jeikcode list main
jeikcode list beta
```

`list` 与 `list main` 列出正式版。`list beta` 列出测试版。最新一条标为 latest，当前正在运行的版本标为 current。

### 更新到较新版本

```bash
jeikcode up
jeikcode up main
jeikcode up main v7.2.4
jeikcode up beta
jeikcode up beta v7.2.4-beta.12
jeikcode upgrade --beta -y
```

`up`、`update`、`upgrade` 是同一命令。不写通道时安装最新正式版。`up main` 安装最新正式版；后面写版本号则安装该正式版。`up beta` 安装最新测试版；后面写版本号则安装该测试版。`--main` 与 `--beta` 也可以放在 `upgrade` 后面。

目标版本不比当前版本新时，命令会提示改用 `down`。

### 安装指定版本或更旧的版本

```bash
jeikcode down main v7.2.3
jeikcode down beta v7.2.4-beta.8
```

`down` 与 `downgrade` 是同一命令。必须写明通道和版本号。

### 回到磁盘上的上一版

```bash
jeikcode rollback
```

与本机保留的上一版备份对调，不需要重新下载。`jeikcode up rollback` 作用相同。

---

## 3. 卸载

```bash
jeikcode uninstall
jeikcode uninstall simple
jeikcode uninstall all
```

- `jeikcode uninstall`：交互引导。程序和 PATH 项一定会移除，并询问是否保留用户配置。
- `jeikcode uninstall simple`：只删除程序和 PATH 项，保留用户配置。没有提问，适合脚本和 AI。
- `jeikcode uninstall all`：删除程序、PATH 项和全部用户配置。没有提问，适合脚本和 AI。

用户配置位于用户主目录下的 `.jeikcode`（Unix 上即 `~/.jeikcode`）。设置了 `JEIKCODE_HOME` 时，以该目录为准。`simple` 和 `all` 会先结束其他正在运行的 JeikCode 进程，再删除程序。
