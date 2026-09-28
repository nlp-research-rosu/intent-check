# Codex hook payloads

`session-start`, `prompt`, `post-tool-bash` and `stop` are real payloads captured from Codex CLI
0.147 in the hooks spike (research/03), with paths rewritten to `/work/proj`. `post-tool-apply-patch`
follows the apply_patch shape recorded in research/03 Q3 (paths may be relative or absolute), and
`stop-active` is `stop` with `stop_hook_active: true`. `rollout.jsonl` is a trimmed transcript with a
`session_meta` and a `turn_context` line.
