---
name: kit-onboarding
description: 'Set up formal proofs with K when the intent-check CLI is missing or not connected, or when the user asks to set up, update or reconnect it. Covers getting the CLI through /intent:prove, sign-in and initial settings. Not for ordinary code review.'
---

## KIT onboarding

Complete setup once for this machine and Prover endpoint. A working CLI and
an accepted saved credential let subsequent KIT tasks proceed without repeating
onboarding. Use this skill when setup is missing or the user requests it.

The plugin provides the CLI and the user signs in through the Intent Check
sign-in link; nothing is installed by hand. Read
[KIT help](../kit-help/SKILL.md) when
answering questions about the components, settings or saved data.

## Get the CLI

Run `/intent:prove`. It downloads `intent-check` for this plugin version if
needed and prints its absolute path. Use that path for every `intent-check`
command; it is not on `PATH` and nothing edits `PATH`. Check it with
`<path> --version`.

## Connect to Prover

The CLI uses the account saved by the Intent Check sign-in link, or the
`INTENT_API_KEY` environment variable. If a command returns an authentication
or permission error, show the user the Intent Check sign-in link (run
`/intent:doctor` if none is shown) and wait for them to approve it. Never ask
for a key in chat or read credential files into context. If the user
declines, stop setup.

## Finish setup

Run `intent-check config` and briefly explain the effective proof, validation
and concrete-run attempt limits and the configuration path. Prover owns
execution timeouts. Use `intent-check config --help` for default values.
Distinguish built-in defaults from configured overrides. Each session tracks
its own attempt counts; configuration changes apply to sessions using that
configuration. One accepted proof submission can contain several claims.

Confirm that KIT is ready and return to the user's task. Do not repeat this
introduction on subsequent KIT tasks unless settings change or the user asks.
