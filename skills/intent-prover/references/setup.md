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

## Install or migrate

Explain the installation/update needed and obtain authorization unless already
requested. For migration, identify the exact old executable and its ownership marker
without reading credentials into context. Let running old CLI workers finish or stop
them with authorization before moving their state; do not interrupt accepted remote
tasks blindly. Keep their task IDs for recovery.

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

The installers verify release checksums and CLI entry points, install the replacement,
run `intent-prover migrate`, check configuration and configure PATH. Migration moves
configuration, credentials, sessions and cached state from the sibling `intent-check`
configuration directory to `intent-prover`, preserving file permissions. It refuses
conflicting top-level entries instead of overwriting or merging them. Legacy PATH-only
`env` files remain so existing shell profiles keep working. Host plugin data stays
under the unchanged `intent` identity; repository `.intent` data is not moved or removed.

Complete migration by removing the identified old binary after replacement verification.
When removal is authorized, rerun the Unix installer with
`INTENT_PROVER_REMOVE_LEGACY=1` in its environment, or the PowerShell installer with
`-RemoveLegacy`. Only a regular old executable matching its adjacent
`.intent-check.sha256` ownership marker is removed, together with that marker.
For an unrecognized or package-managed installation, use its original uninstall
method after identifying the exact target and obtaining any needed approval.
Do not delete config directories or create an old-command alias.

For an already installed replacement, `intent-prover migrate` performs the same
offline state migration and validation. On conflict or failure, preserve both
locations and resolve the reported entry; do not reset credentials or budgets.
Follow the installer's PATH instructions, repeat the checks above and confirm
the old command no longer resolves. Then continue the original task.

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
