// Prepare a release checkout, never the development branch's permanent identity.
// node scripts/package-channel.mjs <production|staging> <X.Y.Z[-staging.N]>
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeVersion } from "./bump-version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY = "nlp-research-rosu/intent-prover";
const read = (root, file) => fs.readFileSync(path.join(root, file), "utf8");
const write = (root, file, text) => fs.writeFileSync(path.join(root, file), text);

export function prepareChannel(name, version, root = ROOT) {
  const channels = JSON.parse(read(root, "release/channels.json"));
  const selected = channels[name];
  if (!selected) throw new Error(`Unknown release channel: ${name}`);
  const pattern = name === "staging" ? /^\d+\.\d+\.\d+-staging\.\d+$/ : /^\d+\.\d+\.\d+$/;
  if (!pattern.test(version)) throw new Error(`Supply an explicit ${name} version, e.g. ${name === "staging" ? "1.3.0-staging.1" : "1.3.0"}`);
  if (read(root, "release/channel").trim() !== "production") throw new Error("Prepare a fresh source checkout, not an already generated package");

  writeVersion(version, root);
  write(root, "release/channel", `${name}\n`);
  for (const file of [".claude-plugin/plugin.json", ".codex-plugin/plugin.json", ".antigravity-plugin/plugin.json"]) {
    const manifest = JSON.parse(read(root, file));
    manifest.name = selected.plugin;
    if (file === ".antigravity-plugin/plugin.json") manifest.displayName = selected.display_name;
    manifest.description = `${selected.display_name}: code analysis and verification for AI coding assistants.`;
    write(root, file, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  const production = channels.production;
  // Only shipped instructions/installers are rendered. No implementation source is renamed.
  const substitutions = new Map([
    // The repository keeps its name even when it matches the production CLI.
    [REPOSITORY, REPOSITORY],
    [production.cli, selected.cli],
    [production.display_name, selected.display_name],
    [production.api_url, selected.api_url],
    [production.console_url, selected.console_url],
    [production.windows_install_dir, selected.windows_install_dir],
    ["INTENT_PROVER_INSTALL_DIR", name === "staging" ? "INTENT_PROVER_STAGING_INSTALL_DIR" : "INTENT_PROVER_INSTALL_DIR"],
    ["INTENT_API_KEY", `${selected.env_prefix}_API_KEY`],
    ["INTENT_API_URL", `${selected.env_prefix}_API_URL`],
    ["INTENT_CONSOLE_URL", `${selected.env_prefix}_CONSOLE_URL`],
    ["/intent:", `/${selected.plugin}:`],
  ]);
  const patternText = [...substitutions.keys()].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const render = (text) => text
    .replace(new RegExp(patternText, "g"), (token) => substitutions.get(token))
    .replace(/releases\/(?:latest\/download|download\/v[^/\s]+)/g, `releases/download/v${version}`);

  for (const entry of fs.readdirSync(path.join(root, "commands"))) {
    const file = `commands/${entry}`;
    write(root, file, render(read(root, file)));
  }
  const skill = `skills/${production.cli}`;
  const renderDirectory = (directory) => {
    for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`;
      if (entry.isDirectory()) renderDirectory(file);
      else if (entry.name.endsWith(".md")) write(root, file, render(read(root, file)));
    }
  };
  renderDirectory(skill);
  if (selected.cli !== production.cli) fs.renameSync(path.join(root, skill), path.join(root, `skills/${selected.cli}`));
  if (name === "staging") {
    const file = `skills/${selected.cli}/SKILL.md`;
    write(root, file, read(root, file).replace(/^description: /m, "description: Use only for explicitly requested internal staging testing. "));
  }
  for (const extension of ["sh", "ps1"]) {
    const file = `scripts/install-${production.cli}.${extension}`;
    const output = `scripts/install-${selected.cli}.${extension}`;
    write(root, output, render(read(root, file)));
    if (output !== file) fs.unlinkSync(path.join(root, file));
  }
  if (selected.cli !== production.cli) {
    const file = "cli/Cargo.toml";
    write(root, file, read(root, file).replace(`[[bin]]\nname = "${production.cli}"`, `[[bin]]\nname = "${selected.cli}"`));
  }
  const metadata = JSON.parse(read(root, "package.json"));
  metadata.name = selected.cli;
  metadata.description = `${selected.display_name}: code analysis and verification for AI coding assistants.`;
  write(root, "package.json", `${JSON.stringify(metadata, null, 2)}\n`);
  return selected;
}

export function marketplace(name, version, sha, root = ROOT) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("Marketplace pin requires a full commit SHA");
  const selected = JSON.parse(read(root, "release/channels.json"))[name];
  if (!selected) throw new Error(`Unknown release channel: ${name}`);
  return {
    name: selected.marketplace,
    owner: { name: "Intent Computing" },
    metadata: { description: `${selected.display_name}: code analysis and verification for AI coding assistants.` },
    plugins: [{
      name: selected.plugin,
      source: { source: "url", url: `https://github.com/${REPOSITORY}.git`, ref: `v${version}`, sha },
      description: `${selected.display_name}: code analysis and verification for AI coding assistants.`,
      version,
    }],
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [name, version, sha] = process.argv.slice(2);
    if (sha) process.stdout.write(`${JSON.stringify(marketplace(name, version, sha), null, 2)}\n`);
    else process.stdout.write(`${JSON.stringify(prepareChannel(name, version))}\n`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
