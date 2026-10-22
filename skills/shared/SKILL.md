---
name: shared
description: 'Not a skill: the reference library the other kit skills load via relative links. Never invoke directly.'
---

## What this folder is

The doctrine and technique references every kit skill points at. This
file exists so skill loaders that require a `SKILL.md` in every folder
accept the tree; `shared/` is not a pipeline stage and has no artifact
or dispatch contract.
