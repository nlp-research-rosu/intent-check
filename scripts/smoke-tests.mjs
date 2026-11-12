// Pi constructs the proof; Scan invokes the existing Node launcher directly.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = "intent-prover-staging";
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled", "data_expired"]);
const SCAN = {
  remote: "https://github.com/openai/mle-bench",
  commit: "507f92e1138bb6e40dac5c6ee7a6758e6424bf97",
  scope: "mlebench/competitions/jigsaw-unintended-bias-in-toxicity-classification",
};
const hash = (value) => createHash("sha256").update(value).digest("hex");

function requireValue(value, message) {
  if (!value) throw new Error(message);
  return value;
}

// Use only authoritative message completions, not duplicate turn/agent snapshots.
export function addUsage(total, event) {
  const usage = event.type === "message_end" && event.message?.role === "assistant"
    ? event.message.usage
    : event.type === "compaction_end" ? event.result?.usage : undefined;
  if (!usage) return;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) total[key] += usage[key] ?? 0;
  total.estimatedUsd += usage.cost?.total ?? 0;
}

export function checkProof(task, saved, semantics) {
  requireValue(task.id === saved.id, "Service task ID differs from saved evidence");
  requireValue(task.status === "completed" && task.result === "proved" && !task.error, "Final proof did not complete as proved");
  requireValue(task.semantics?.id === semantics.id && task.semantics?.commit === semantics.commit, "Proof semantics differ from the session pin");
  requireValue(Array.isArray(task.toolRuns), "Proof has no tool-run evidence");
  if (task.toolRuns.length) requireValue(task.toolRuns.at(-1).exitCode === 0, "Final proof tool did not exit successfully");
  return { taskId: task.id, semantics, reused: task.toolRuns.length === 0 };
}

export function isPinnedSource(original, current, sourceHash) {
  const lfs = original.toString("utf8").match(/^version https:\/\/git-lfs\.github\.com\/spec\/v1\noid sha256:([a-f0-9]{64})\nsize (\d+)\n$/);
  const pinned = lfs ? lfs[1] === sourceHash && current.length === Number(lfs[2]) : hash(original) === sourceHash;
  return pinned && hash(current) === sourceHash;
}

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

function evidence(project) {
  return files(path.join(project, ".intent/prove/sessions"))
    .filter((file) => /\/(?:proof|run|validation)-\d+\/result\.json$/.test(file))
    .map((file) => ({ file, snapshot: JSON.parse(fs.readFileSync(file, "utf8")) }));
}

function scanRecords(env) {
  return files(path.join(env.CLAUDE_PLUGIN_DATA, "scans"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}

function checkScan(task, saved, project, apiUrl) {
  requireValue(task.id === saved.job_id && task.kind === "scan", "Service Scan task differs from saved evidence");
  requireValue(task.status === "completed" && !task.error && task.result?.depth === "fast", "Scan did not complete successfully at fast depth");
  requireValue(saved.status === "done" && saved.report_status === "saved" && saved.api_url === apiUrl, "Scan report was not collected from staging");
  const source = saved.source;
  requireValue(saved.scope === SCAN.scope && saved.depth === "fast" && source?.scope === SCAN.scope, "Scan scope/depth differs from website request");
  requireValue(source.remote_url === SCAN.remote && source.head_sha === SCAN.commit, "Scan repository/revision differs from website request");
  const repo = fs.realpathSync(saved.repo_root);
  requireValue(repo.startsWith(`${fs.realpathSync(project)}${path.sep}`), "Scan repository is outside the isolated project");
  const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 30_000 });
  requireValue(git(["rev-parse", "HEAD"]).trim() === SCAN.commit, "Scan checkout moved from the pinned revision");
  requireValue(git(["remote", "get-url", "origin"]).trim().replace(/\.git$/, "") === SCAN.remote, "Scan checkout has the wrong origin");
  requireValue(!git(["diff", SCAN.commit, "--", ".", ":(exclude).intent"]).trim(), "Scan changed tracked source");
  requireValue(!git(["ls-files", "--others", "--exclude-standard", "--", ".", ":(exclude).intent"]).trim(), "Scan left untracked source files");
  requireValue(Array.isArray(source.files) && source.files.length > 0 && source.file_count === source.files.length, "Scan has no source manifest");
  for (const file of source.files) {
    requireValue(typeof file.path === "string" && file.path.startsWith(`${SCAN.scope}/`) && !file.path.split("/").includes(".."), "Scan uploaded a file outside the requested scope");
    const original = execFileSync("git", ["show", `${SCAN.commit}:${file.path}`], { cwd: repo, timeout: 30_000 });
    const current = fs.readFileSync(path.join(repo, file.path));
    requireValue(isPinnedSource(original, current, file.source_sha256), "Scanned source differs from pinned/unchanged code");
  }
  const dir = path.join(repo, ".intent/scan", task.id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
  const bytes = fs.readFileSync(path.join(dir, "report.json"));
  const ref = task.result.report;
  requireValue(meta.task_id === task.id && meta.report?.status === "saved", "Saved Scan metadata differs from service evidence");
  requireValue(ref?.name === "report.json" && ref.url === `/tasks/${task.id}/artifacts/report.json` && bytes.length === ref.size && hash(bytes) === ref.sha256, "Saved report differs from authoritative artifact hash/size");
  const report = JSON.parse(bytes);
  requireValue(Number.isInteger(report.version) && report.coverage && typeof report.coverage === "object" && !Array.isArray(report.coverage) && Array.isArray(report.cards) && Array.isArray(report.one_liners), "Scan report lacks coverage/findings arrays");
  const levels = ["CRITICAL", "HIGH", "MODERATE", "LOW", "MARGINAL"];
  requireValue(levels.every((level) => Number.isSafeInteger(task.result.counts?.[level]) && task.result.counts[level] >= 0) && Array.isArray(task.result.cards) && Array.isArray(task.result.oneLiners), "Scan summary has invalid counts/findings");
  for (const finding of [...report.cards, ...report.one_liners, ...task.result.cards, ...task.result.oneLiners]) {
    requireValue(finding && levels.includes(finding.severity ?? finding.criticality) && typeof finding.title === "string" && finding.title.trim(), "Scan finding lacks title/severity");
    const locations = finding.source_references ?? finding.cause ?? [{ path: finding.path, line: finding.line }];
    requireValue(Array.isArray(locations) && locations.length > 0, "Scan finding lacks source locations");
    for (const location of locations) {
      requireValue(source.files.some((file) => file.path === location.path) && Number.isSafeInteger(location.line) && location.line > 0, "Scan finding location is outside submitted source");
      requireValue(location.line <= fs.readFileSync(path.join(repo, location.path), "utf8").split("\n").length, "Scan finding line is outside source file");
    }
  }
  return { taskId: task.id, repository: SCAN.remote, commit: SCAN.commit, scope: SCAN.scope, counts: task.result.counts, sourceUnchanged: true, reportSha256: ref.sha256 };
}

async function main() {
  const smokeCase = process.env.SMOKE_CASE ?? "withdraw";
  const prove = smokeCase === "withdraw";
  const output = path.resolve(requireValue(process.env.SMOKE_OUTPUT_DIR, "Set SMOKE_OUTPUT_DIR"));
  const artifact = path.join(output, "artifact");
  fs.mkdirSync(output, { recursive: true });
  const keys = [process.env.OPENROUTER_API_KEY, process.env.INTENT_STAGING_API_KEY].filter(Boolean);
  const redact = (text) => keys.reduce((value, key) => value.replaceAll(key, "[REDACTED]"), text);
  const write = (name, value) => fs.writeFileSync(path.join(output, name), redact(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`));
  const retainIntent = (directory) => {
    for (const file of files(directory)) {
      const destination = path.join(artifact, ".intent", path.relative(directory, file));
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      // Preserve binary evidence while redacting the ASCII API keys from every file.
      const bytes = Buffer.from(redact(fs.readFileSync(file).toString("latin1")), "latin1");
      fs.writeFileSync(destination, bytes);
    }
  };
  const result = {
    status: "failed", case: smokeCase, runner: prove ? "pi" : "deterministic", promptSource: "https://prover.intentcomputing.org/",
    headSha: null, baseSha: null, mergeSha: process.env.GITHUB_SHA ?? null,
    model: prove ? process.env.SMOKE_MODEL : null, thinking: prove ? process.env.SMOKE_THINKING : null,
    adequacyReview: "Required: inspect proof claims/assumptions or Scan finding support/coverage; service success alone is not adequacy.",
    usage: prove ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedUsd: 0 } : null,
    costBasis: prove ? "Pi usage estimates, not reconciled OpenRouter billing; remote service compute is separate." : "No outer model call; backend Scan model/compute costs are separate and unmeasured here.",
    tasks: [], cleanup: [],
  };
  const started = Date.now();
  let project, env, child, force, interrupted = false;
  const stop = () => {
    interrupted = true;
    if (child?.pid) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* Already exited. */ }
      force ??= setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already exited. */ } }, 5000);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const command = (args) => JSON.parse(execFileSync(CLI, args, { cwd: project, env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }));
  const run = async (executable, args, cwd = project, onOutput = () => {}) => {
    requireValue(!interrupted, "Smoke interrupted");
    let diagnostic = "";
    child = spawn(executable, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", onOutput);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => { diagnostic = (diagnostic + text).slice(-4000); });
    let exit;
    try {
      exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
    } finally { clearTimeout(force); force = undefined; child = undefined; }
    requireValue(!interrupted, "Smoke interrupted");
    requireValue(exit === 0, `${path.basename(executable)} exited ${exit}: ${diagnostic}`);
    return diagnostic;
  };
  try {
    requireValue(["withdraw", "mle-bench"].includes(result.case), "Unknown SMOKE_CASE");
    for (const key of prove ? ["OPENROUTER_API_KEY", "INTENT_STAGING_API_KEY"] : ["INTENT_STAGING_API_KEY"]) requireValue(process.env[key], `Missing GitHub Actions secret ${key}`);
    const packageRoot = path.resolve(requireValue(process.env.SMOKE_PACKAGE_ROOT, "Set SMOKE_PACKAGE_ROOT"));
    requireValue(fs.readFileSync(path.join(packageRoot, "release/channel"), "utf8").trim() === "staging", "Smoke requires a generated staging package");
    const channel = JSON.parse(fs.readFileSync(path.join(packageRoot, "release/channels.json"), "utf8")).staging;
    const skill = path.join(packageRoot, "skills/intent-prover-staging");
    if (prove) requireValue(fs.existsSync(path.join(skill, "SKILL.md")), "Generated staging skill is missing");
    if (prove) requireValue(result.model && result.thinking, "Pin SMOKE_MODEL and SMOKE_THINKING");
    if (process.env.GITHUB_EVENT_PATH) {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      requireValue(process.env.GITHUB_EVENT_NAME === "pull_request" && event.pull_request?.base.ref === "main" && event.pull_request?.head.ref === "staging" && event.pull_request.head.repo.full_name === process.env.GITHUB_REPOSITORY, "Only same-repository staging → main PRs may run this smoke");
      result.headSha = event.pull_request.head.sha;
      result.baseSha = event.pull_request.base.sha;
    }
    const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), `${result.case}-smoke-`));
    project = path.join(scratch, "project");
    const home = path.join(scratch, "home");
    for (const dir of [project, home, path.join(home, ".config/intent-prover-staging")]) fs.mkdirSync(dir, { recursive: true });
    // Do not forward GitHub tokens, other providers' credentials or personal configuration.
    env = {
      PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      TMPDIR: scratch,
      CLAUDE_PLUGIN_DATA: path.join(home, "scan-data"),
      INTENT_STAGING_API_KEY: process.env.INTENT_STAGING_API_KEY,
      INTENT_STAGING_API_URL: channel.api_url, INTENT_STAGING_CONSOLE_URL: channel.console_url,
    };
    const prompt = fs.readFileSync(path.join(ROOT, `test/smoke/${result.case}.txt`), "utf8");
    result.promptSha256 = hash(prompt);
    write("prompt.txt", prompt);
    let setup;
    if (prove) {
      env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
      env.PI_CODING_AGENT_DIR = path.join(home, ".pi/agent");
      fs.mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: project, env });
      const fixtureDir = path.join(ROOT, "test/smoke/withdraw");
      result.fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, "fixture.json"), "utf8"));
      requireValue(prompt.split("```python\n")[1]?.split("```")[0] === fs.readFileSync(path.join(fixtureDir, "withdraw.py"), "utf8"), "Withdrawal fixture differs from the website function");
      fs.mkdirSync(path.join(output, "fixtures"), { recursive: true });
      for (const name of ["withdraw.py", "withdraw.kpyc"]) {
        const bytes = fs.readFileSync(path.join(fixtureDir, name));
        requireValue(hash(bytes) === result.fixture.files[name], `Withdrawal fixture hash differs: ${name}`);
        fs.writeFileSync(path.join(project, name), bytes);
        write(`fixtures/${name}`, bytes.toString("utf8"));
      }
      write("fixtures/fixture.json", result.fixture);
      fs.writeFileSync(path.join(home, ".config/intent-prover-staging/config.toml"), "max_proof_attempts = 50\nmax_validation_attempts = 50\nmax_run_attempts = 50\n");
      const modelConfig = {
        providers: {
          openrouter: {
            modelOverrides: {
              [result.model]: {
                maxTokens: 393216,
                compat: { openRouterRouting: { zdr: true, data_collection: "deny", require_parameters: true, allow_fallbacks: true } },
              },
            },
          },
        },
      };
      fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR, "models.json"), JSON.stringify(modelConfig));
      write("model-config.json", modelConfig);
      fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, cacheWarming: "off", retry: { enabled: false } }));
      setup = `This is an explicitly requested internal staging smoke test. Use the installed Intent Prover Staging skill and ${CLI} on PATH, not the production client. The supplied website request retains its public product wording. The requested program and generated proof inputs may be uploaded to the configured staging service. Use one construction session and its existing attempt limits; do not start replacement sessions to bypass them. Do not install/update tools or start browser login; report missing authentication as blocked. Never print or read credentials into context.\n`;
      setup += `The working directory already contains withdraw.py (the unchanged website function) and withdraw.kpyc (its bytecode, generated with CPython ${result.fixture.pythonVersion} and the pinned exporter for ${result.fixture.semantics.id}@${result.fixture.semantics.commit}). Use these supplied inputs; no local Python interpreter or bytecode generation is needed. Read the matching semantics, construct the specification yourself, and use the staging CLI to validate/prove it. No claims or proof solution are supplied.\n`;
      write("setup.txt", setup);
    }
    result.config = command(["config"]);
    requireValue(result.config.channel === "staging" && result.config.config.server_url === channel.api_url, "CLI is not configured for staging");
    result.cliVersion = execFileSync(CLI, ["--version"], { env, encoding: "utf8" }).trim();
    const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
    requireValue(result.cliVersion === `${CLI} ${version}`, "CLI and generated package versions differ");
    if (prove) {
      result.piVersion = execFileSync("pi", ["--version"], { env, encoding: "utf8" }).trim();
      requireValue(result.piVersion === process.env.PI_VERSION, "Pi version differs from the workflow pin");
    }
    result.health = command(["health"]);
    if (prove) result.semantics = command(["semantics"]);
    command(["task", "list", "--limit", "1"]); // Check staging authentication before starting remote work.
    requireValue(!interrupted, "Smoke interrupted during preflight");
    if (prove) {
      const args = ["--provider", "openrouter", "--model", result.model, "--thinking", result.thinking,
        "--no-extensions", "--no-mcp", "--no-context-files", "--no-skills", "--skill", skill,
        "--no-prompt-templates", "--no-session", "--append-system-prompt", setup, "--mode", "json", prompt];
      result.piArguments = args;
      let buffer = "", streamError;
      const handle = (line) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line);
          addUsage(result.usage, event);
          if (event.type === "message_end" && event.message?.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) streamError = "Pi reported an assistant error/abort";
        } catch { streamError = "Pi emitted invalid JSONL"; }
      };
      await run("pi", args, project, (text) => {
        buffer += text;
        let end;
        while ((end = buffer.indexOf("\n")) !== -1) { handle(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      });
      handle(buffer);
      requireValue(!streamError, streamError);
      const sessions = files(path.join(home, ".config/intent-prover-staging/sessions")).filter((file) => path.basename(file) === "session.json");
      requireValue(sessions.length === 1, "Expected exactly one proof construction session");
      const session = JSON.parse(fs.readFileSync(sessions[0], "utf8"));
      requireValue(session.semantics.id === result.fixture.semantics.id && session.semantics.commit === result.fixture.semantics.commit, "Proof session differs from the supplied bytecode semantics pin");
      const proofs = evidence(project).filter(({ file }) => /\/proof-\d+\/result\.json$/.test(file)).sort((a, b) => a.file.localeCompare(b.file, "en", { numeric: true }));
      requireValue(proofs.length > 0, "Pi did not save a real proof submission");
      const saved = proofs.at(-1).snapshot.task;
      const { task } = command(["task", "show", saved.id]);
      result.proof = checkProof(task, saved, session.semantics);
      requireValue(files(path.join(project, ".intent/prove")).some((file) => path.basename(file) === "PROOF.md"), "Pi did not save PROOF.md");
      requireValue(files(path.join(project, ".intent/prove")).some((file) => path.basename(file) === "SCOPE.md"), "Pi did not save SCOPE.md");
    } else {
      const repo = path.join(project, "mle-bench");
      const launcher = path.join(packageRoot, "bin/intent.js");
      requireValue(fs.existsSync(launcher), "Generated staging Scan launcher is missing");
      result.scanCommands = [
        { executable: "git", args: ["init", "--quiet", repo], cwd: project },
        { executable: "git", args: ["remote", "add", "origin", SCAN.remote], cwd: repo },
        { executable: "git", args: ["fetch", "--depth=1", "origin", SCAN.commit], cwd: repo },
        { executable: "git", args: ["checkout", "--quiet", "--detach", SCAN.commit], cwd: repo },
        { executable: process.execPath, args: [launcher, "scan", SCAN.scope, "fast"], cwd: repo },
      ];
      write("scan-plan.json", { ...SCAN, depth: "fast", commands: result.scanCommands });
      write("upload-scope.txt", `Upload the public ${SCAN.remote} repository at ${SCAN.commit}, folder ${SCAN.scope}/, using the existing staging Scan launcher's snapshot filtering and redaction. No repository dependencies or scripts are installed/run.\n`);
      let log = "";
      try {
        for (const step of result.scanCommands) {
          const diagnostic = await run(step.executable, step.args, step.cwd, (text) => { log = (log + text).slice(-64000); });
          log = (log + diagnostic).slice(-64000);
        }
      } finally { write("scan-launcher.log", log.slice(-64000)); }
      const scans = scanRecords(env);
      requireValue(scans.length === 1, "Expected exactly one saved Scan submission");
      requireValue(evidence(project).length === 0, "Scan case unexpectedly submitted proof work");
      const { task } = command(["task", "show", scans[0].job_id]);
      result.scan = checkScan(task, scans[0], project, channel.api_url);
    }
    result.status = "passed";
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    // Cancel only jobs recorded by this isolated run, never another account's tasks.
    if (project && env) {
      try {
        const ids = [...evidence(project).map(({ snapshot }) => snapshot.task?.id), ...scanRecords(env).map((scan) => scan.job_id)];
        for (const id of ids) {
          if (!id || result.tasks.includes(id)) continue;
          result.tasks.push(id);
          try {
            let { task } = command(["task", "show", id]);
            if (!TERMINAL.has(task.status)) {
              result.status = "failed";
              result.error ??= "Smoke left an unfinished service task; cleanup requested cancellation";
              process.exitCode = 1;
              const stopped = command(["task", "cancel", id]);
              task = stopped.task;
              result.cleanup.push({ taskId: id, status: task.status, cancellationConfirmed: stopped.cancellation?.cancellationConfirmed });
            }
            write(`task-${id}.json`, task);
            requireValue(TERMINAL.has(task.status), `Task ${id} may still be active`);
          } catch (error) {
            result.cleanup.push({ taskId: id, error: error.message });
            result.status = "failed";
            process.exitCode = 1;
          }
        }
        retainIntent(path.join(project, ".intent"));
        for (const scan of scanRecords(env)) {
          if (!/^[0-9a-f-]{36}$/.test(scan.job_id)) continue;
          const repo = fs.realpathSync(scan.repo_root);
          if (!repo.startsWith(`${fs.realpathSync(project)}${path.sep}`)) continue;
          retainIntent(path.join(repo, ".intent"));
        }
      } catch (error) {
        result.cleanup.push({ error: error.message });
        result.status = "failed";
        process.exitCode = 1;
      }
    }
    if (files(path.join(artifact, ".intent")).length) {
      try {
        execFileSync(CLI, ["--project", artifact, "view", "--output", path.join(artifact, ".intent/report.html")], { env, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
        result.html = ".intent/report.html";
      } catch {
        result.reportError = "Could not export the local HTML evidence; retained source evidence is still available.";
      }
    }
    result.runtimeSeconds = (Date.now() - started) / 1000;
    write("result.json", result);
    if (process.env.GITHUB_OUTPUT) {
      const report = { status: result.status, runtimeSeconds: result.runtimeSeconds, proof: result.proof, scan: result.scan };
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `${smokeCase}=${JSON.stringify(report)}\n`);
    }
    const runner = prove ? `Model: ${result.model}; thinking: ${result.thinking}\n\nPi estimated cost: $${result.usage.estimatedUsd.toFixed(4)} (backend compute excluded).` : "Deterministic Scan launcher; no outer Pi/model call. Backend Scan model/compute costs are not measured here.";
    const summary = `## Smoke tests: ${result.case} — ${result.status}\n\n${runner}\n\nRuntime: ${result.runtimeSeconds.toFixed(1)}s.\n\n${result.adequacyReview}\n\n${result.error ? `Failure: ${result.error}\n\n` : ""}Task IDs: ${result.tasks.join(", ") || "none recorded"}.\n`;
    write("summary.md", summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact(summary));
    console.log(`Smoke tests (${result.case}): ${result.status}; selected evidence: ${output}`);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
