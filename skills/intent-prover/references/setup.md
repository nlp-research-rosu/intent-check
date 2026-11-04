# Setup and migration

Reuse a working installation and accepted saved connection. Hooks do not install
or update software. Use the published stable release, not a development branch or
prerelease, unless requested.

## Check the installation

Locate `intent-prover` (`command -v` on Unix, `Get-Command` in PowerShell), then run:

```sh
intent-prover --version
intent-prover runtime
intent-prover requirements --help
```

Compare the version with the latest stable tag at
`https://api.github.com/repos/nlp-research-rosu/intent-check/releases/latest`.
Required runtime capabilities are `hooks-v1`, `requirements-context-v1`, `reviews-v1`
and `scan-v1`. A version alone does not establish capability support. If the published
release lacks what is needed, report the limitation rather than reinstalling repeatedly.

## Install or update

Explain the installation/update needed and obtain authorization unless already
requested.

Unix installer:

```sh
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-prover.sh | sh
```

Windows PowerShell:

```powershell
Invoke-WebRequest https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-prover.ps1 -OutFile install-intent-prover.ps1
& ./install-intent-prover.ps1
```

The installers verify release checksums, install the CLI and configure PATH.
Follow their PATH instructions and repeat the installation checks above.

When replacing `intent-check`, identify the old installation and any settings,
credentials or local state that need to be retained. Let old workers finish before
moving their state; keep accepted task IDs for recovery. Migrate only what is needed,
preserving permissions and resolving conflicts with the user rather than overwriting
data. Verify the replacement before removing the identified old installation through
its original uninstall method. Keep `.intent` project data and host plugin data under
the unchanged `intent` identity, then continue the original task.

## Connect

Reuse a pending sign-in link shown by a hook. Otherwise run `intent-prover login`,
give the user its `verification_url`, and keep it running until `connected`.
The user signs in and approves; never ask for a key in chat. Stop if login is denied.
Use `intent-prover health` to check the service. On an authentication error, use the
response and `login --help` to reconnect. `INTENT_API_KEY` overrides saved credentials.

Settings and credentials share `$XDG_CONFIG_HOME/intent-prover/`, or
`%APPDATA%\intent-prover\` on Windows, otherwise `~/.config/intent-prover/`.
`INTENT_API_URL` and `INTENT_CONSOLE_URL` override endpoints. Use `config --help`
for effective limits and `doctor` for plugin status; Doctor may repair the connection
or update the enabled host plugin. Do not invoke it for a strictly read-only check.

## Host identity for Review, Scan and controls

Claude Code uses:

```sh
intent-prover <command> --plugin-root "${CLAUDE_PLUGIN_ROOT}" --data "${CLAUDE_PLUGIN_DATA}"
```

Codex has no plugin slash commands. Use:

```sh
intent-prover <command> --host codex --plugin-root "<plugin-root>"
```

Resolve `<plugin-root>` as two parents above `skills/intent-prover/SKILL.md`'s folder.
Use the installed plugin root, not the project root, so commands and hooks share
private data. Host data writes and network calls may need sandbox approval.
Relay On/Live/Off/Doctor output word for word. Prove and local requirements commands
use their own command help and do not need host identity arguments.
