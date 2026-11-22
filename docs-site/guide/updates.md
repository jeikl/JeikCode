# Updates and Uninstall

Tutorial: https://jeikcode.top/guide/updates.html

The desktop app, a browser opened from another machine, and a headless CLI all support multi-version updates and rollbacks. Windows, macOS and Linux use the same commands. Prompts follow the JeikCode interface language (Simplified Chinese, English, and Vietnamese).

Updates only resolve targets published in the release manifest. Unsupported userlands (32-bit ARM/x86, MIPS) fail closed with an explicit message instead of downloading a wrong-architecture binary.

---

## 1. Desktop and WebUI

In the desktop app or the browser, use the update control at the top right. You can choose the stable or beta channel, read that version's notes, install a newer build, or switch to another version in the list.

When the update finishes, the page reloads onto the new version. A phone, another computer, or any other browser connected to the same service updates and rolls back the same way.

---

## 2. Command line

Run these commands on a headless server. No desktop window is required. Add `-y` to apply configuration changes without a prompt.

### List published versions

```bash
jeikcode list
jeikcode list main
jeikcode list beta
```

`list` and `list main` show stable releases. `list beta` shows beta releases. The newest row is marked latest. The version you are running is marked current.

### Move to a newer version

```bash
jeikcode up
jeikcode up main
jeikcode up main v7.2.4
jeikcode up beta
jeikcode up beta v7.2.4-beta.12
jeikcode upgrade --beta -y
```

`up`, `update`, and `upgrade` are the same command. With no channel, it installs the latest stable release. `up main` installs the latest stable release; a version after it installs that stable release. `up beta` installs the latest beta; a version after it installs that beta. `--main` and `--beta` also work after `upgrade`.

If the target is not newer than the running version, the command tells you to use `down`.

### Install a specific or older version

```bash
jeikcode down main v7.2.3
jeikcode down beta v7.2.4-beta.8
```

`down` and `downgrade` are the same command. Both the channel and the version are required.

### Return to the previous binary on disk

```bash
jeikcode rollback
```

This swaps the running program with the previous backup kept on disk. It does not download again. `jeikcode up rollback` does the same thing.

---

## 3. Uninstall

```bash
jeikcode uninstall
jeikcode uninstall simple
jeikcode uninstall all
```

- `jeikcode uninstall` walks through the removal and asks whether to keep user configuration. The program and its PATH entry are always removed.
- `jeikcode uninstall simple` removes only the program and its PATH entry, and keeps user configuration. It asks nothing, so scripts and agents can run it.
- `jeikcode uninstall all` removes the program, its PATH entry, and all user configuration. It asks nothing, so scripts and agents can run it.

User configuration lives in `.jeikcode` under the home directory (`~/.jeikcode` on Unix). When `JEIKCODE_HOME` is set, that directory is used instead. `simple` and `all` stop other running JeikCode processes before removing the program.
