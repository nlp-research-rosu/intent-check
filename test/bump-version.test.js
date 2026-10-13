import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, ROOT } from "./helpers/env.js";
import { nextVersion, readVersions, FILES, INSTALL_JSON, CHANGELOG, changelogSection, rollChangelog } from "../scripts/bump-version.mjs";

const none = () => [];

test("patch, minor, major from a plain version", () => {
  assert.equal(nextVersion("0.1.1", "patch", null, none), "0.1.2");
  assert.equal(nextVersion("0.1.1", "minor", null, none), "0.2.0");
  assert.equal(nextVersion("0.1.1", "major", null, none), "1.0.0");
});

test("bumps operate on the base of a prerelease", () => {
  assert.equal(nextVersion("0.1.1-peredit.2", "patch", null, none), "0.1.2");
  assert.equal(nextVersion("0.1.1-peredit", "minor", null, none), "0.2.0");
  assert.equal(nextVersion("0.1.1-peredit.2", "major", null, none), "1.0.0");
});

test("explicit versions pass through; junk is rejected", () => {
  assert.equal(nextVersion("0.1.1", "2.0.0", null, none), "2.0.0");
  assert.equal(nextVersion("0.1.1", "0.3.0-rc.1", null, none), "0.3.0-rc.1");
  assert.throws(() => nextVersion("0.1.1", "1.2", null, none));
  assert.throws(() => nextVersion("0.1.1", "bogus", null, none));
  assert.throws(() => nextVersion("0.1.1", "patch", "bad id", none));
});

test("--pre: bumps the base the first time, then numbers on from the highest tag", () => {
  const tags = ["v0.1.2-per-edit.1", "v0.1.2-per-edit.3", "v0.1.2-other.9"];
  const list = (pat) => tags.filter((t) => t.startsWith(pat.slice(0, -1)));
  assert.equal(nextVersion("0.1.1", "patch", "per-edit", list), "0.1.2-per-edit.4");
  assert.equal(nextVersion("0.1.2-per-edit.3", "patch", "per-edit", list), "0.1.2-per-edit.4");
  assert.equal(nextVersion("0.1.2-per-edit.3", "minor", "per-edit", list), "0.1.2-per-edit.4");
  assert.equal(nextVersion("0.1.2-other.9", "patch", "per-edit", none), "0.1.3-per-edit.1");
  assert.equal(nextVersion("0.1.1", "0.5.0", "x", none), "0.5.0-x.1");
});

function sandbox() {
  const dir = tmpdir("bump-");
  for (const f of [...FILES, INSTALL_JSON, "scripts/bump-version.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, f), path.join(dir, f));
  }
  const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("commit", "-q", "--allow-empty", "-m", "x");
  return { dir, git, run: (...a) => execFileSync("node", ["scripts/bump-version.mjs", ...a], { cwd: dir, encoding: "utf8" }) };
}

test("CLI: writes all four files consistently, keeps formatting, prints only the version", () => {
  const { dir, run } = sandbox();
  const before = FILES.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  const cur = readVersions(dir)[0][1];
  assert.equal(run("2.3.4"), "2.3.4\n");
  assert.deepEqual(readVersions(dir).map(([, v]) => v), Array(4).fill("2.3.4"));
  FILES.forEach((f, i) => assert.equal(fs.readFileSync(path.join(dir, f), "utf8"), before[i].replace(`"${cur}"`, '"2.3.4"')));
});

test("CLI: --pre numbers from git tags", () => {
  const { dir, git, run } = sandbox();
  run("1.4.0");
  git("tag", "v1.4.1-per-edit.1");
  assert.equal(run("patch", "--pre", "per-edit"), "1.4.1-per-edit.2\n");
  assert.equal(run("patch", "--pre", "per-edit"), "1.4.1-per-edit.2\n");
  assert.deepEqual(readVersions(dir).map(([, v]) => v), Array(4).fill("1.4.1-per-edit.2"));
});

test("CLI: plain release also sets docs/install.json's top-level version", () => {
  const { dir, run } = sandbox();
  const p = path.join(dir, INSTALL_JSON);
  const before = fs.readFileSync(p, "utf8");
  const cur = readVersions(dir, [INSTALL_JSON])[0][1];
  assert.equal(run("2.3.4"), "2.3.4\n");
  assert.equal(JSON.parse(fs.readFileSync(p, "utf8")).version, "2.3.4");
  assert.equal(fs.readFileSync(p, "utf8"), before.replace(`"version": "${cur}"`, '"version": "2.3.4"'));
});

test("CLI: prerelease bump leaves docs/install.json untouched", () => {
  const { dir, run } = sandbox();
  run("0.1.1"); // pin the base so the test doesn't depend on the repo's current release
  const p = path.join(dir, INSTALL_JSON);
  const before = fs.readFileSync(p, "utf8");
  assert.equal(run("patch", "--pre", "per-edit"), "0.1.2-per-edit.1\n");
  assert.equal(fs.readFileSync(p, "utf8"), before);
  assert.deepEqual(readVersions(dir).map(([, v]) => v), Array(4).fill("0.1.2-per-edit.1"));
});

test("CLI: plain release refuses when install.json lacks exactly one version field, writing nothing", () => {
  const { dir } = sandbox();
  const p = path.join(dir, INSTALL_JSON);
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/"version": "[^"]*",/, '"version": "0.1.1", "x": {"version": "1"},'));
  const before = FILES.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  assert.throws(() => execFileSync("node", ["scripts/bump-version.mjs", "patch"], { cwd: dir, stdio: "pipe" }));
  assert.deepEqual(FILES.map((f) => fs.readFileSync(path.join(dir, f), "utf8")), before);
});

test("CLI: refuses when the four files disagree", () => {
  const { dir } = sandbox();
  const p = path.join(dir, ".codex-plugin/plugin.json");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/"version": "[^"]*"/, '"version": "9.9.9"'));
  assert.throws(() => execFileSync("node", ["scripts/bump-version.mjs", "patch"], { cwd: dir, stdio: "pipe" }));
});

// ---- changelog ----

const LOG = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n### Added\n\n- A new thing.\n\n## [0.2.4] - 2026-10-13\n\n### Fixed\n\n- An old thing.\n";

test("changelog: a section's body by name; a plain release turns Unreleased into that version's section", () => {
  assert.equal(changelogSection(LOG, "Unreleased"), "### Added\n\n- A new thing.");
  assert.equal(changelogSection(LOG, "0.2.4"), "### Fixed\n\n- An old thing.");
  assert.equal(changelogSection(LOG, "9.9.9"), "");
  assert.equal(changelogSection(LOG.replace(/\n/g, "\r\n"), "0.2.4"), "### Fixed\n\n- An old thing.");
  const rolled = rollChangelog(LOG, "0.3.0", "2026-10-20");
  assert.equal(changelogSection(rolled, "Unreleased"), "");
  assert.equal(changelogSection(rolled, "0.3.0"), "### Added\n\n- A new thing.");
  assert.equal(changelogSection(rolled, "0.2.4"), "### Fixed\n\n- An old thing.");
  assert.match(rolled, /## \[Unreleased\]\n\n## \[0\.3\.0\] - 2026-10-20\n\n### Added/);
  assert.throws(() => rollChangelog(LOG, "0.2.4", "2026-10-20"), /already has a section/);
  assert.throws(() => rollChangelog("# Changelog\n", "0.3.0", "2026-10-20"), /no "## \[Unreleased\]" section/);
});

test("CLI: a plain release rolls CHANGELOG.md and --notes prints the section; a prerelease leaves it alone", () => {
  const { dir, run } = sandbox();
  const p = path.join(dir, CHANGELOG);
  run("0.2.4"); // pin the base before there is a changelog to roll
  fs.writeFileSync(p, LOG);
  assert.equal(run("patch", "--pre", "per-edit"), "0.2.5-per-edit.1\n");
  assert.equal(fs.readFileSync(p, "utf8"), LOG, "prerelease: untouched");
  assert.equal(run("minor"), "0.3.0\n");
  assert.match(fs.readFileSync(p, "utf8"), /## \[Unreleased\]\n\n## \[0\.3\.0\] - \d{4}-\d\d-\d\d\n\n### Added\n\n- A new thing\./);
  assert.equal(run("--notes", "0.3.0"), "### Added\n\n- A new thing.\n");
  assert.equal(run("--notes", "9.9.9"), "", "no section: empty, so the workflow falls back to generated notes");
});

test("changelog: a plain release refuses an empty Unreleased section, writing nothing", () => {
  const empty = "# Changelog\n\n## [Unreleased]\n\n## [0.2.4] - 2026-10-13\n\n### Fixed\n\n- An old thing.\n";
  assert.throws(() => rollChangelog(empty, "0.3.0", "2026-10-20"), /nothing under \[Unreleased\]; add the release notes first/);
  const { dir } = sandbox();
  fs.writeFileSync(path.join(dir, CHANGELOG), empty);
  const files = [...FILES, INSTALL_JSON];
  const before = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  assert.throws(() => execFileSync("node", ["scripts/bump-version.mjs", "patch"], { cwd: dir, stdio: "pipe" }), /nothing under/);
  assert.deepEqual(files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")), before);
  assert.equal(fs.readFileSync(path.join(dir, CHANGELOG), "utf8"), empty);
});

test("CLI: a release refuses when CHANGELOG.md has no Unreleased section, writing nothing", () => {
  const { dir } = sandbox();
  fs.writeFileSync(path.join(dir, CHANGELOG), "# Changelog\n");
  const before = FILES.map((f) => fs.readFileSync(path.join(dir, f), "utf8"));
  assert.throws(() => execFileSync("node", ["scripts/bump-version.mjs", "patch"], { cwd: dir, stdio: "pipe" }));
  assert.deepEqual(FILES.map((f) => fs.readFileSync(path.join(dir, f), "utf8")), before);
});

test("CHANGELOG.md: has an Unreleased section and an entry for the current release; the release workflow uses it", () => {
  const log = fs.readFileSync(path.join(ROOT, CHANGELOG), "utf8");
  assert.match(log, /^## \[Unreleased\]$/m);
  const cur = readVersions()[0][1];
  if (/^\d+\.\d+\.\d+$/.test(cur)) assert.notEqual(changelogSection(log, cur), "", `CHANGELOG.md has no entry for ${cur}`);
  assert.match(fs.readFileSync(path.join(ROOT, ".github/workflows/release.yml"), "utf8"), /bump-version\.mjs --notes "\$V"/);
  assert.match(fs.readFileSync(path.join(ROOT, "README.md"), "utf8"), /\]\(CHANGELOG\.md\)/);
});
