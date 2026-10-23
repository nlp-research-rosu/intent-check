---
name: kit-help
description: 'Explain formal-proof (K) commands of the intent-check CLI: settings, evidence files, attempt limits, and task timeouts. Not for ordinary code review.'
---

## Components

KIT is the plugin bundle of agent skills and Prover Client. Prover Client is
the local CLI; Prover is the remote service that runs tasks.
The CLI comes from the `prove` command of the plugin script (`/intent:prove`). For setup or reconnection, use
[kit-onboarding](../kit-onboarding/SKILL.md). Answer setup questions without
repeating onboarding or starting a verification task.

## Prover Client commands

Read `intent-check --help` for the command tree and
`intent-check <command> --help` for arguments, examples and results.
For nested commands, use help such as `intent-check session start --help`.

| Command | When it helps |
|---|---|
| `intent-check config` | Inspect the endpoint and effective resource limits |
| `intent-check health` | Check whether live verification is available |
| `intent-check semantics` | List server-supported language revisions |
| `intent-check semantics fetch` | Download shared semantics sources for inspection |
| `intent-check run` | Check the program's concrete behavior under that definition |
| `intent-check validate` | Catch source and module errors before proving |
| `intent-check session start` | Create a session and locate its working directory |
| `intent-check session show` | Inspect a session's pin, workspace, and used counters |
| `intent-check prove` | Submit a proof attempt or inspect a stuck claim |
| `intent-check task list / show / wait / cancel` | Inspect or recover accepted tasks without resubmitting |

## Connection

The CLI sends the account saved by `intent-check login` (or
`INTENT_API_KEY`) with all Prover requests. Run the requested commands. On an
authentication or permission error, run `<cli path> login` and give the user
its `verification_url`; under the plugin the link is usually already shown.
Never read credential files into agent context.

If polling fails after acceptance, recover the existing task rather than
resubmitting. Use `intent-check task --help` for retries, reattachment and
cancellation. Recovery does not consume another attempt.

## Settings and files

`intent-check config` shows effective settings and the configuration path.
`intent-check config --help` describes defaults, overrides and file locations.
Configuration may come entirely from built-in defaults; do not attribute a
value to the user without evidence. Changes apply to all sessions using that
configuration; each session tracks its own attempt counts.

Session counters and downloaded semantics are stored beside the configuration.
Session state (working files and results) lives under the project's
`.intent/prove/sessions/<id>/`; it is not meant to be committed.
`intent-check session show <ID>` reports a session's paths and counters.

## Attempt limits

Inspect effective limits before live work. Use the CLI's structured result:
`exhausted` is terminal for the live workflow until the user approves a higher
limit. Stop further submissions and tell the user which operation reached its
limit, the used count and maximum, and what remains unfinished. This limit
does not establish that a claim is false or a proof is stuck.

Ask whether to raise the limit, stating the current and proposed values and
that the change affects other sessions using the same configuration. After
approval, edit the corresponding limit in `config.toml` yourself, confirm it
with `intent-check config`, and continue in the same session with used
counters unchanged. Do not ask the user to edit the file. Never create a
replacement session, change directories or delete state to bypass a limit.

Do not treat exhaustion as an infrastructure failure or continue live work
through other agents while approval is pending. In a non-interactive run,
deliver the last proved sources, or the best draft marked unproved, and report
`exhausted`. For verification session handoffs, follow
[using-kit](../using-kit/SKILL.md#choose-the-work-that-advances-the-target).

## Task timeouts

Prover owns task execution limits; the CLI neither sends a timeout override
nor imposes a local task or queue-wait deadline. `request_timeout_seconds`
only limits individual HTTP requests. Ctrl-C requests cancellation of this
command's task; inspect the reported confirmation before assuming it stopped.

A server timeout does not establish that the claim is false or the prover
is stuck. Inspect the retained result and diagnostics before retrying; follow
[proving-spec](../proving-spec/SKILL.md#proof-progress).
Depth-bounded diagnostics remain subject to server execution limits. If the
overall task has a deadline, allow time for cancellation and delivery rather
than changing client timeout settings.
