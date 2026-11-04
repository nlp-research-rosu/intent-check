# .intent

`REQUIREMENTS.md` is editable project-wide human intent. Requirements are natural-language statements; specifications are formal files, whether checked or unchecked.

Use `intent-check requirements add --input requirement.json` and `update <uuid> --input requirement.json` to manage structured requirements. Input contains a statement, nonempty targets (repository-relative path and optional function symbol), and optional reason. The CLI generates UUIDs. Updates retain their identity. Read files directly with normal coding-agent tools; no context command is required.

```text
.intent/
  README.md
  REQUIREMENTS.md
  source/
    requirements.json
    src/shop.py/
      requirements.json
      index.json
      specs/
        discount.k
  logs/
    <run-uuid>/
      request.json
      result.json
      inputs/
      artifacts/
  graph.json
```

One-file requirements live in `source/<source-path>/requirements.json`; cross-file requirements live in `source/requirements.json`. Each requirement has one owning per-file index. The first target supplies the initial owner; updates retain that owner while it is still a target. There is no global index or specification folder. Cross-file properties can reference specifications belonging to multiple source files.

An index contains `schema_version: 1` and a `properties` object keyed by requirement UUID. Each entry contains only `specs` (paths relative to `.intent`, such as `source/src/shop.py/specs/discount.k`) and `last_run` (a run UUID, or null). An empty specs list is valid. Multiple properties can share formal files and operations. Do not create competing ownership entries.

`specs/` holds actual current working formal files, not symlinks. `logs/` retains exact submitted inputs, returned artifacts, outcomes, hashes, scope and assumptions for review, scan, execution and proof operations. Proof reports, scope records and reproducible commands belong in the operation's `artifacts/`; frozen inputs belong in `inputs/`. Authoring scratch under `prove/sessions/` is not evidence. A run reference is not a claim that its property was proved.

Explicit proof `--requirement <uuid>` associations bind the submitted formal files to those properties. Applicable formal files are copied to their owning source's specs area after completion; failed attempts may update last_run without replacing specifications. File-level review artifacts alone do not establish a property association. Partial output never deletes an absent specification. A late operation cannot replace changed source, requirements, working specifications or a newer selection. Read freshness from the referenced operation's exact input hashes; edits can make evidence stale without deleting current files.

Agents may maintain `REQUIREMENTS.md` and read the whole folder. Use the requirements CLI for structured requirement mutations. Keep current formal files and their index links consistent; do not edit historical results or frozen inputs. Merge source, properties and current formal files together; use operation logs to resolve conflicts. Internal hook and worker entry points are host lifecycle interfaces, not supported agent-facing CLI commands.

`.queue/` is transient scheduling and `.sent.log` is an upload audit without contents. These and `.storage.lock` are ignored by Git. `.ignore` excludes generated evidence from ordinary searches. Durable requirements, current specifications and evidence may be committed. Viewer/export excludes private conversations, authoring scratch and frozen input copies. To disable automatic reviews, use the plugin's off control or `INTENT_DISABLED=1` / `DO_NOT_TRACK=1`.
