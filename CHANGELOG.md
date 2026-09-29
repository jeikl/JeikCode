# Changelog

<!-- 发版前在此追加 `## vX.Y.Z (YYYY-MM-DD)`。流水线不会改这个文件。 -->

## v7.1.33 (2026-09-29)

- WebUI：时间只出现在用户发出消息时和本轮最后一条助手回复上，并保留整轮「用时」。中间的思考、工具调用、分段正文不再打时刻。

## v7.1.32 (2026-09-29)

- Linux ARM64 安装包按 16K 页对齐，树莓派 5 这类 16K 页的盒子可以运行，4K 页的机器也不受影响。
- 桌面端：Windows 为 exe 安装包，macOS 为 dmg，Linux 为 deb / AppImage（x64 另有 rpm）。窗口打开本机 WebUI，并把同一个 `jeikcode` 放到 `~/.local/bin`。

## v7.1.31 (2026-09-29)

- WebUI：停止时把排队内容还回输入框；一次粘贴多张图会全部保留；排队消息可在下一步软转向。切走后，已完成的会话不再一直转圈，未完成清单不再挤进最新消息。
- 更新：SHA256 清单改为随 GitHub Release 上传，不再为发版往 `main` 追加提交。新版本从 `releases/latest/download/latest.json` 检查更新。
