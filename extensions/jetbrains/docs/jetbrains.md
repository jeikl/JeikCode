# JeikCode for JetBrains

JeikCode for JetBrains brings the local JeikCode coding agent into IntelliJ-based IDEs. It provides a native tool window, editor actions, and intentions for chat-based coding workflows.

## Requirements

- A JetBrains IDE compatible with the plugin version shown on JetBrains Marketplace.
- The JeikCode plugin installed from JetBrains Marketplace or from a signed plugin ZIP.
- A local JeikCode daemon. Marketplace builds may include a bundled daemon for supported platforms, and you can also configure a custom daemon binary path.

## Installation

### From JetBrains Marketplace

1. Open `Settings | Plugins`.
2. Search for `JeikCode`.
3. Install the plugin and restart the IDE if prompted.

### From a signed ZIP

1. Open `Settings | Plugins`.
2. Choose the gear menu.
3. Select `Install Plugin from Disk...`.
4. Select the signed `jeikcode-jetbrains-<version>-signed.zip` file.
5. Restart the IDE if prompted.

## Open JeikCode

Use any of these entry points:

- `Tools | JeikCode: Open Chat`
- Search Everywhere and run `JeikCode: Open Chat`
- The `JeikCode` tool window
- Editor context menu actions such as `JeikCode: Explain Selection`
- Alt+Enter intentions for selected code

## Configure the daemon

Open `Settings | Tools | JeikCode` or run `JeikCode: Open Settings`.

Available settings include:

- Daemon binary path
- Host and port, defaulting to `127.0.0.1:13456`
- Request timeout
- Chat font size
- Context level
- Selected text context
- Relative path sharing
- Auto-save before JeikCode reads files
- Chat send shortcut behavior

By default, the plugin communicates with a local daemon on `127.0.0.1`. If you configure a different host, review the privacy and security implications before sending project context.

## Configure providers

Open the JeikCode tool window and use the provider controls to add or edit a provider.

Supported provider types include:

- OpenAI-compatible providers
- Claude
- Ollama
- Custom compatible endpoints through provider base URLs

Provider settings may include a provider name, model name, base URL, and API key. API keys entered in the JetBrains plugin are sent to the local JeikCode daemon so it can store or use them for provider requests.

## Context and privacy controls

JeikCode can use editor selection, attached files, current file context, and project metadata as coding context. You control this through the JeikCode settings and through explicit editor actions.

Important controls:

- Disable selected text context if you do not want selection-based code context to be sent to the daemon.
- Use minimal context when you want prompts to include less project information.
- Review attached files and selected code before sending prompts to external model providers.
- Sensitive paths such as private keys, `.env` files, credentials, SSH configuration, AWS configuration, GnuPG data, and Terraform state receive stronger handling or blocking.

Read the privacy policy before configuring external model providers:

`../PRIVACY.md`

Telemetry details are documented here:

`../../../docs/telemetry.md`

## Common workflows

### Explain selected code

1. Select code in the editor.
2. Run `JeikCode: Explain Selection` from the editor context menu or Search Everywhere.
3. Review the generated explanation in the JeikCode tool window.

### Fix or optimize selected code

1. Select code in the editor.
2. Run `JeikCode: Fix Selection` or `JeikCode: Optimize Selection`.
3. Review JeikCode's response and apply changes only after checking the diff.

### Attach a file as context

1. Open the JeikCode tool window.
2. Use the attach-file control or `JeikCode: Add Selection/File as Context`.
3. Send a prompt that refers to the attached context.

### Review local changes

Use `JeikCode: Open Changes` to inspect project changes that JeikCode can use during review workflows.

## Troubleshooting

- If JeikCode cannot connect, check the daemon host and port in settings.
- If the daemon fails to start, configure a daemon binary path or install JeikCode separately.
- If provider requests fail, verify the provider type, model, base URL, and API key.
- If context is missing, check the context level and selected-text context settings.
- If telemetry should be disabled, set `JEIKCODE_TELEMETRY=0`, `DO_NOT_TRACK=1`, or run `jeikcode telemetry disable`.

## Support

Report issues at:

`https://github.com/JeikCode/JeikCode/issues`

Source code:

`https://github.com/JeikCode/JeikCode`
