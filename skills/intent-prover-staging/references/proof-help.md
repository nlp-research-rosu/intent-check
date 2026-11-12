# Prove CLI help

## Components

The separately installed CLI submits work to the remote service and saves results.
Use [onboarding](onboarding.md) for missing setup; setup questions do not start jobs.

## CLI commands

Use `intent-prover-staging --help` and `<command> --help` for exact syntax, including
nested commands such as `intent-prover-staging session start --help`.

| Command | When it helps |
|---|---|
| `intent-prover-staging config` | Inspect the endpoint and effective resource limits |
| `intent-prover-staging health` | Check whether live verification is available |
| `intent-prover-staging semantics` | List server-supported language revisions |
| `intent-prover-staging semantics fetch` | Download shared semantics sources for inspection |
| `intent-prover-staging run` | Check the program's concrete behavior under that definition |
| `intent-prover-staging validate` | Check source and module structure without proving claims |
| `intent-prover-staging session start` | Create a session and locate its working directory |
| `intent-prover-staging session show` | Inspect a session's pin, workspace, and used counters |
| `intent-prover-staging prove` | Submit a proof attempt or inspect a stuck claim |
| `intent-prover-staging task list / show / wait / cancel` | Inspect or recover accepted tasks without resubmitting |
| `intent-prover-staging view --output <new-report.html>` | Export the local HTML handoff with saved remote job links; no network or sign-in |

## Connection

Reuse saved login or `INTENT_STAGING_API_KEY`. For authentication/permission errors, run
`intent-prover-staging login`, show `verification_url` and wait for saved approval. Never
read credential files into context.

If polling fails after acceptance, recover by task ID with `task show/wait`;
do not resubmit. Recovery does not consume another attempt. See `task --help`.

## Settings and files

`config` shows effective settings and their path; `config --help` explains
defaults and overrides. Do not mistake defaults for user choices. Settings
changes affect all sessions sharing that configuration; attempt counts are per session.

Counters and cached semantics live beside configuration. Local working files
and results live in `.intent/prove/sessions/<id>/`; do not commit that directory.
Use `session show <ID>` for actual paths, pin and counts.

## Attempt limits

Read effective limits before submission. On `exhausted`, stop live work and
report the operation, used/max counts and unfinished scope; it says nothing
about the claim's truth.

Raising a limit needs user approval of the proposed value and shared-config
effect. Then edit `config.toml`, confirm with `config`, and resume the same
session with counters intact. Never bypass limits through new sessions,
directories, deleted state or other agents. Without approval, the result is the
last proved version or an explicitly unproved draft, with remaining work stated.

## Task timeouts

The service sets execution limits, including for depth-bounded runs. The CLI
has no task/queue-wait deadline or timeout override; `request_timeout_seconds`
limits individual HTTP requests only.

Ctrl-C requests task cancellation; verify the reported confirmation. A stopped
local process does not prove the remote task stopped. Under a user deadline,
leave time for cancellation and delivery. Inspect saved [diagnostics](running-k.md#diagnostic-entry-points)
before retrying a timed-out task.
