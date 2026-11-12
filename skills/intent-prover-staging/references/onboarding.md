# Onboarding

Complete setup once for this machine and Intent Prover Staging service endpoint. A working CLI and
an accepted saved credential let subsequent Intent Prover Staging tasks proceed without repeating
onboarding. Run the CLI update check when starting requested Scan or Prove work;
complete the rest only when setup is missing or the user requests it.

Install and connect the CLI; the user only needs to open the login
link, sign in and approve. Read
[CLI help](proof-help.md) when
answering questions about the components, settings or saved data.

## Detect the CLI

Intent Prover Staging requires `intent-prover-staging` on `PATH`.

On macOS or Linux, run:

```bash
command -v intent-prover-staging
intent-prover-staging --version
```

On Windows PowerShell, run:

```powershell
Get-Command intent-prover-staging
intent-prover-staging --version
```

## Check CLI updates

At the start of each requested Scan or Prove workflow, compare the installed
CLI version with `tag_name` from
https://api.github.com/repos/nlp-research-rosu/intent-prover/releases/latest.
If the CLI is missing or older, install or update it using the released
installer below. Keep an equal or newer version. Check once per workflow,
not before each command or poll; preserve configuration and saved sign-in.

On macOS or Linux, install or update with:

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/nlp-research-rosu/intent-prover/releases/download/v1.3.0-staging.2/install-intent-prover-staging.sh | sh
```

On Windows PowerShell:

```powershell
Invoke-WebRequest `
  https://github.com/nlp-research-rosu/intent-prover/releases/download/v1.3.0-staging.2/install-intent-prover-staging.ps1 `
  -OutFile install-intent-prover-staging.ps1
& ./install-intent-prover-staging.ps1
```

The installers select the platform binary, verify its checksum and configure
PATH. Start a new terminal or agent session, or run the shell command printed
by the installer, then repeat the detection commands above.

## Connect to Intent Prover Staging

Sign-in runs only when explicitly requested for setup. Reuse an already-running
login rather than starting another. Check the connection with `intent-prover-staging health`.

For first-time setup, run `intent-prover-staging login` and show the user its
`verification_url`. The user signs in and approves. Keep the command running
until it saves the key and exits with `connected`.

Once connected, run normal Intent Prover Staging commands with the saved key. If a command
returns an authentication or permission error, use that response to resolve
the connection; follow `intent-prover-staging login --help` when reconnection is
needed. Never ask for a key in chat or read credential files into context.
If login is denied, stop setup.

## Finish setup

For a formal proof task, run `intent-prover-staging config` and briefly explain the effective proof, validation
and concrete-run attempt limits and the configuration path. The Intent Prover Staging service owns
execution timeouts. Use `intent-prover-staging config --help` for default values.
Distinguish built-in defaults from configured overrides. Each session tracks
its own attempt counts; configuration changes apply to sessions using that
configuration. One accepted proof submission can contain several claims.

Confirm that Intent Prover Staging is ready and return to the user's task. Do not repeat this
introduction on subsequent tasks unless settings change or the user asks.
