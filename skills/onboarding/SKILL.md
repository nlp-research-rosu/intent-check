---
name: onboarding
description: 'Set up the global intent-check CLI and shared sign-in for formal proofs with K and code review. Use when the CLI is missing or not connected, or the user requests installation, an update or reconnection. Reuse completed setup.'
---

## Onboarding

Complete setup once for this machine and Intent Check service endpoint. A working CLI and
an accepted saved credential let subsequent Intent Check tasks proceed without repeating
onboarding. Use this skill when setup is missing or the user requests it.

The agent installs and connects the CLI; the user only needs to open the login
link, sign in and approve. Read
[proof-help](../proof-help/SKILL.md) when
answering questions about the components, settings or saved data.

## Detect the CLI

Intent Check requires `intent-check` on `PATH`.

On macOS or Linux, run:

```bash
command -v intent-check
intent-check --version
```

On Windows PowerShell, run:

```powershell
Get-Command intent-check
intent-check --version
```

Read the latest stable release tag from
`https://api.github.com/repos/nlp-research-rosu/intent-check/releases/latest`
and compare it with `intent-check --version`. Reuse an installed current stable
CLI. Do not select main, a pull request or a prerelease automatically.

For automatic reviews or DeepScan, run `intent-check runtime` and verify that
`capabilities` includes `hooks-v1`, `requirements-context-v1`, `reviews-v1` and
`deepscan-v1`. For requirements, also check `intent-check requirements --help`.
If the installed CLI is missing, outdated or lacks a required capability, explain
what installation/update is needed and obtain authorization unless the user already
requested it. Then use the published checksum-verifying installer below. If the latest
stable release still lacks the capability, report that limitation; do not install a
development build or repeatedly reinstall. Hooks never install or update software.

On macOS or Linux, install or update with:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-check.sh | sh
```

On Windows PowerShell:

```powershell
Invoke-WebRequest `
  https://github.com/nlp-research-rosu/intent-check/releases/latest/download/install-intent-check.ps1 `
  -OutFile install-intent-check.ps1
& ./install-intent-check.ps1
```

The installers select the platform binary, verify its checksum and configure
PATH. Start a new terminal or agent session, or run the shell command printed
by the installer, then repeat the version and required capability checks above.

## Connect to Intent Check

If a hook already showed a sign-in link, reuse it rather than starting another
login. The global CLI collects approval in the background; a later prompt
confirms the connection. Check it with `intent-check health`.

For first-time setup, run `intent-check login` and show the user its
`verification_url`. The user signs in and approves. Keep the command running
until it saves the key and exits with `connected`.

Once connected, run normal Intent Check commands with the saved key. If a command
returns an authentication or permission error, use that response to resolve
the connection; follow `intent-check login --help` when reconnection is
needed. Never ask for a key in chat or read credential files into context.
If login is denied, stop setup.

## Finish setup

For a formal proof task, run `intent-check config` and briefly explain the effective proof, validation
and concrete-run attempt limits and the configuration path. The Intent Check service owns
execution timeouts. Use `intent-check config --help` for default values.
Distinguish built-in defaults from configured overrides. Each session tracks
its own attempt counts; configuration changes apply to sessions using that
configuration. One accepted proof submission can contain several claims.

Confirm that Intent Check is ready and return to the user's task. Do not repeat this
introduction on subsequent tasks unless settings change or the user asks.
