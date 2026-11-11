# Release channels

The existing client repository builds two variants from one implementation.
`release/channels.json` defines their identities and default URLs. The checked-in
`release/channel` selects production; packaging selects staging only in the
temporary release checkout. The native executable embeds both files, so moving or
renaming a binary does not change its channel. Node commands read the same files
from the installed plugin package.

| | Production | Staging |
|---|---|---|
| Plugin | `intent` | `intent-staging` |
| Marketplace | `intentcomputing` | `intentcomputing-staging` |
| CLI and skill | `intent-prover` | `intent-prover-staging` |
| Config/credentials directory | `intent-prover` | `intent-prover-staging` |
| API | `https://api.prover.intentcomputing.org` | `https://api.staging-prover.intentcomputing.org` |
| Login/results console | `https://prover-console.intentcomputing.org` | `https://staging-prover-console.intentcomputing.org` |

Configuration uses the existing XDG, Windows APPDATA or home-directory base.
Staging accepts `INTENT_STAGING_API_URL`, `INTENT_STAGING_CONSOLE_URL` and
`INTENT_STAGING_API_KEY` overrides, rather than the production variables.
URLs are configurable defaults, not restrictions. Sign in separately to staging;
do not copy production credentials.

## Publish a candidate

1. Select the tested source branch in GitHub Actions' **release** workflow.
   Use `staging` as the integration branch when preparing a candidate; keep
   deferred feature branches separate until their changes are ready to test.
2. Select channel `staging` and enter an unused version, such as
   `1.3.0-staging.1`. The workflow does not choose or increment versions.
3. Existing unit/host integration checks run. The workflow generates the package
   in its own checkout and tags it `v1.3.0-staging.1`. Plugin manifests, package and
   native CLI share that version. The generated commit's parent identifies the
   source revision; generated staging identities are not committed back to the
   development branch.
4. All six native platform builds and checksums must upload before publication.
   Installers download from this exact tag, and the packaged onboarding skill
   points at the matching installer, never production's `releases/latest`.
5. Only after publication, the workflow creates or advances the catalog-only
   `catalog-staging` branch. Its plugin entry pins the generated tag and full SHA.
   Existing catalog history is retained and pushes are fast-forward only.

Staging is an unlisted **public** channel: its branch, tags and assets can be read
by anyone. It is absent from the production catalog and website install picker;
it is not private or access-controlled. Prereleases never become GitHub's latest
production release.

The workflow can resume a partial publication using the same version/tag. Once
published, do not replace that tag or its assets; publish a new candidate version
for changes. No automatic updater runs during ordinary plugin tasks.

## Install for staging testing

These commands work after the first staging candidate has been published.
For Claude Code:

```sh
claude plugin marketplace add 'nlp-research-rosu/intent-prover#catalog-staging'
claude plugin install intent-staging@intentcomputing-staging
```

For Codex:

```sh
codex plugin marketplace add nlp-research-rosu/intent-prover --ref catalog-staging
codex plugin add intent-staging@intentcomputing-staging
```

Run the installed **Intent Prover Staging** skill's onboarding guide once. It
installs the matching `intent-prover-staging` CLI and runs explicit staging login.
Installation does not run hooks or silently install a binary. Unix installers use
`~/.local/bin` by default, with a separate staging filename and checksum marker;
override the directory with `INTENT_PROVER_STAGING_INSTALL_DIR`. Windows uses
`%LOCALAPPDATA%\IntentComputing\IntentProverStaging\bin` by default.

Both variants can remain installed. Disable production and enable staging in the
host's plugin controls, then start a fresh session or reload plugins where
supported. Switching back does not require reinstalling a CLI or changing URLs.
For updates, refresh `intentcomputing-staging` and `intent-staging`, then use its
onboarding guide when the matching CLI needs installing or updating.

Global config, credentials, semantics cache, native session descriptors and host
plugin data are separate. A checkout's `.intent/` evidence is still shared: use a
separate worktree for staging testing rather than changing the evidence schema.

## Promote to production

Promote tested **source changes**, not the generated staging package commit, to
`main`. Choose channel `production` and manually enter the stable version, such
as `1.3.0`. The same code is built with production identities and defaults.
The existing Unreleased changelog becomes the stable release notes.

After all assets publish, the workflow advances the production catalog on
`main`, updates its install metadata and marks that release as latest. Staging
publication does none of these. Backend changes, when required by a feature,
must be compatible before publishing the client.
