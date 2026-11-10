# Scan

Use the plugin launcher in [Intent Check](../SKILL.md#commands), not the global
Prove CLI. Before submitting, explain that the requested code will be uploaded
to the configured service, with obvious secrets masked. A generic local-review
request is not permission to upload code; ask if remote analysis was not requested.

## Submit

- One file: `scan <file>`.
- Folder: `scan <folder>`.
- Repository: `scan`.
- Depth: `fast` (default, about 15–20 minutes), `balanced` (30–35), or `full` (40–45).

Run inside a Git repository. The snapshot includes tracked and non-ignored
untracked text files within the requested path. It excludes secrets, binary,
generated and vendored files, lockfiles and `.intent/` evidence except `NOTES.md`.
All submissions use `/deepscans`. No command reads chat transcripts, prompts,
plans or edit history. Upload metadata is recorded in `.intent/.sent.log`.

The command prints the report link and task ID, polls until completion, saves
evidence and returns findings. Keep it running using the host's long-running
command support. Do not submit a second Scan or implement a separate polling loop.

## Collect and report

If waiting is interrupted or a request fails, the task may still be running.
Use `scan collect <task-id>` to resume polling and save evidence without
resubmitting source. `scan collect` handles outstanding scans in this project.
Ordinary messages do not resume scans or deliver results.

Reports live in `.intent/deepscan/<task-id>/` at the repository root. Preserve
existing evidence. Commit project knowledge with source; do not blanket-ignore
`.intent/`.

Show the main findings and report link, checking findings against the submitted
version. Offer to reproduce or fix; findings do not authorize edits. After a
fix, another remote Scan requires an explicit request. When the user confirms
intended behaviour, append a concise bullet to `.intent/NOTES.md` for later scans.
