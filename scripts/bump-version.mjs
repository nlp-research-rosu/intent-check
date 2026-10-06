// node scripts/bump-version.mjs <patch|minor|major|X.Y.Z[-pre]> [--pre <id>]
// patch/minor/major bump the base (prerelease stripped). With --pre <id> the result is <base>-<id>.<N>, N = 1 + the highest
// tag v<base>-<id>.*; base = the current base if the current version is already a prerelease with that id, else the bumped base.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FILES = ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json", ".codex-plugin/plugin.json"];
// The install picker shows this version and test/install-json.test.js pins it to package.json, so plain releases bump it too.
// Prerelease bumps leave it alone: the per-edit branch requires install.json to stay plain semver.
export const INSTALL_JSON = "docs/install.json";
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const VERSION_FIELD = /("version":\s*")([^"]*)(")/g;

const parse = (v) => {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`not a valid version: ${v}`);
  return { base: m.slice(1, 4).map(Number), pre: m[4] || null };
};
const bumpBase = (b, kind) => (kind === "major" ? [b[0] + 1, 0, 0] : kind === "minor" ? [b[0], b[1] + 1, 0] : [b[0], b[1], b[2] + 1]);

export const gitTags = (pattern, cwd = ROOT) => execFileSync("git", ["tag", "-l", pattern], { cwd, encoding: "utf8" }).split("\n").filter(Boolean);

export function nextVersion(current, arg, pre, listTags = gitTags) {
  const cur = parse(current);
  const explicit = SEMVER.test(arg);
  if (!explicit && !["patch", "minor", "major"].includes(arg)) throw new Error(`unknown bump: ${arg}`);
  if (explicit && !pre) return arg;
  if (pre && !/^[0-9A-Za-z-]+$/.test(pre)) throw new Error(`invalid prerelease id: ${pre}`);
  const base = explicit ? parse(arg).base : pre && cur.pre && cur.pre.replace(/\.\d+$/, "") === pre ? cur.base : bumpBase(cur.base, arg);
  if (!pre) return base.join(".");
  const prefix = `v${base.join(".")}-${pre}.`;
  const used = listTags(`${prefix}*`).map((t) => (/^\d+$/.test(t.slice(prefix.length)) ? Number(t.slice(prefix.length)) : 0));
  return `${base.join(".")}-${pre}.${Math.max(0, ...used) + 1}`;
}

export function readVersions(root = ROOT, files = FILES) {
  return files.map((f) => {
    const found = [...fs.readFileSync(path.join(root, f), "utf8").matchAll(VERSION_FIELD)];
    if (found.length !== 1) throw new Error(`${f}: expected exactly one version field`);
    return [f, found[0][2]];
  });
}

export function writeVersion(v, root = ROOT) {
  const vs = readVersions(root);
  for (const [f, cur] of vs) if (cur !== vs[0][1]) throw new Error(`versions disagree: ${f} has ${cur}, ${vs[0][0]} has ${vs[0][1]}`);
  const plain = !parse(v).pre;
  const targets = plain ? [...FILES, INSTALL_JSON] : FILES;
  if (plain) readVersions(root, [INSTALL_JSON]); // throws unless exactly one version field, before anything is written
  for (const f of targets) {
    const p = path.join(root, f);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(VERSION_FIELD, `$1${v}$3`));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const i = args.indexOf("--pre");
    const pre = i >= 0 ? args.splice(i, 2)[1] : null;
    if (args.length !== 1 || (i >= 0 && !pre)) throw new Error("usage: bump-version.mjs <patch|minor|major|X.Y.Z[-pre]> [--pre <id>]");
    const [[, current]] = readVersions();
    const v = nextVersion(current, args[0], pre);
    writeVersion(v);
    console.log(v);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
