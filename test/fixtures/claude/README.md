# Claude Code hook payloads

`session-start`, `prompt`, `prompt-task-notification`, `post-tool-edit`, `stop` and
`stop-rewake-turn` are real payloads captured from Claude Code 2.1.283 in the hooks spike
(research/02), with paths rewritten to `/work/proj`. `post-tool-write`, `post-tool-notebook-edit`,
`post-tool-exit-plan-mode` and `post-tool-todo-write` follow the documented shapes for tools the
spike did not exercise.
