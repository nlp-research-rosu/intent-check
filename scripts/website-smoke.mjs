// One real Pi invocation; proof construction and tool execution stay in Pi/the CLI.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = "intent-prover-staging";
const TERMINAL = new Set(["completed", "failed", "timed_out", "cancelled", "data_expired"]);

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

async function main() {
  const output = path.resolve(requireValue(process.env.SMOKE_OUTPUT_DIR, "Set SMOKE_OUTPUT_DIR"));
  fs.mkdirSync(output, { recursive: true });
  const keys = [process.env.OPENROUTER_API_KEY, process.env.INTENT_STAGING_API_KEY].filter(Boolean);
  const redact = (text) => keys.reduce((value, key) => value.replaceAll(key, "[REDACTED]"), text);
  const write = (name, value) => fs.writeFileSync(path.join(output, name), redact(typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`));
  const result = {
    status: "failed", case: "withdraw", promptSource: "https://prover.intentcomputing.org/",
    headSha: null, baseSha: null, mergeSha: process.env.GITHUB_SHA ?? null,
    model: process.env.SMOKE_MODEL, thinking: process.env.SMOKE_THINKING,
    adequacyReview: "Required: inspect the claims, program correspondence and assumptions; service success alone is not adequacy.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, estimatedUsd: 0 },
    costBasis: "Pi usage estimates, not reconciled OpenRouter billing; remote proof compute is separate.",
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
  try {
    for (const key of ["OPENROUTER_API_KEY", "INTENT_STAGING_API_KEY"]) requireValue(process.env[key], `Missing GitHub Actions secret ${key}`);
    const packageRoot = path.resolve(requireValue(process.env.SMOKE_PACKAGE_ROOT, "Set SMOKE_PACKAGE_ROOT"));
    requireValue(fs.readFileSync(path.join(packageRoot, "release/channel"), "utf8").trim() === "staging", "Smoke requires a generated staging package");
    const channel = JSON.parse(fs.readFileSync(path.join(packageRoot, "release/channels.json"), "utf8")).staging;
    const skill = path.join(packageRoot, "skills/intent-prover-staging");
    requireValue(fs.existsSync(path.join(skill, "SKILL.md")), "Generated staging skill is missing");
    const timeout = Number(process.env.SMOKE_TIMEOUT_SECONDS);
    requireValue(Number.isSafeInteger(timeout) && timeout > 0, "Set a positive SMOKE_TIMEOUT_SECONDS");
    requireValue(result.model && result.thinking, "Pin SMOKE_MODEL and SMOKE_THINKING");
    if (process.env.GITHUB_EVENT_PATH) {
      const event = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
      requireValue(process.env.GITHUB_EVENT_NAME === "pull_request" && event.pull_request?.base.ref === "main" && event.pull_request?.head.ref === "staging" && event.pull_request.head.repo.full_name === process.env.GITHUB_REPOSITORY, "Only same-repository staging → main PRs may run this smoke");
      result.headSha = event.pull_request.head.sha;
      result.baseSha = event.pull_request.base.sha;
    }
    const scratch = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP ?? os.tmpdir(), "withdraw-smoke-"));
    project = path.join(scratch, "project");
    const home = path.join(scratch, "home");
    for (const dir of [project, home, path.join(home, ".config/intent-prover-staging"), path.join(home, ".pi/agent")]) fs.mkdirSync(dir, { recursive: true });
    // Do not forward GitHub tokens, other providers' credentials or personal configuration.
    env = {
      PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"),
      PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"), TMPDIR: scratch,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      INTENT_STAGING_API_KEY: process.env.INTENT_STAGING_API_KEY,
      INTENT_STAGING_API_URL: channel.api_url, INTENT_STAGING_CONSOLE_URL: channel.console_url,
    };
    execFileSync("git", ["init", "--quiet"], { cwd: project, env });
    fs.writeFileSync(path.join(home, ".config/intent-prover-staging/config.toml"), "max_proof_attempts = 5\nmax_validation_attempts = 5\nmax_run_attempts = 10\n");
    fs.writeFileSync(path.join(home, ".pi/agent/settings.json"), JSON.stringify({ enableInstallTelemetry: false, cacheWarming: "off", retry: { enabled: false } }));
    const prompt = fs.readFileSync(path.join(ROOT, "test/smoke/withdraw.txt"), "utf8");
    result.promptSha256 = createHash("sha256").update(prompt).digest("hex");
    write("prompt.txt", prompt);
    const setup = `This is an explicitly requested internal staging smoke test. Use the installed Intent Prover Staging skill and ${CLI} on PATH, not the production client. The supplied website request retains its public product wording. The requested program and generated proof inputs may be uploaded to the configured staging service. Use one construction session and its existing attempt limits; do not start replacement sessions to bypass them. Do not install/update tools or start browser login; report missing authentication as blocked. Never print or read credentials into context. You have ${timeout} seconds overall; leave time to return the proof evidence and unresolved obligations.\n`;
    write("setup.txt", setup);
    result.config = command(["config"]);
    requireValue(result.config.channel === "staging" && result.config.config.server_url === channel.api_url, "CLI is not configured for staging");
    result.cliVersion = execFileSync(CLI, ["--version"], { env, encoding: "utf8" }).trim();
    const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
    requireValue(result.cliVersion === `${CLI} ${version}`, "CLI and generated skill package versions differ");
    result.piVersion = execFileSync("pi", ["--version"], { env, encoding: "utf8" }).trim();
    requireValue(result.piVersion === process.env.PI_VERSION, "Pi version differs from the workflow pin");
    result.health = command(["health"]);
    result.semantics = command(["semantics"]);
    command(["task", "list", "--limit", "1"]); // Check staging authentication before paying for a model call.
    requireValue(!interrupted, "Smoke interrupted during preflight");
    result.timeoutSeconds = timeout;
    const args = ["--provider", "openrouter", "--model", result.model, "--thinking", result.thinking,
      "--no-extensions", "--no-mcp", "--no-context-files", "--no-skills", "--skill", skill,
      "--no-prompt-templates", "--no-session", "--append-system-prompt", setup, "--mode", "json", prompt];
    result.piArguments = args;
    let buffer = "", diagnostic = "", streamError;
    const handle = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        addUsage(result.usage, event);
        if (event.type === "message_end" && event.message?.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) streamError = "Pi reported an assistant error/abort";
      } catch { streamError = "Pi emitted invalid JSONL"; }
    };
    child = spawn("pi", args, { cwd: project, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (text) => {
      buffer += text;
      let end;
      while ((end = buffer.indexOf("\n")) !== -1) { handle(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text) => { diagnostic = (diagnostic + text).slice(-4000); });
    const timer = setTimeout(stop, timeout * 1000);
    let exit;
    try {
      exit = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code) => resolve(code)); });
    } finally { clearTimeout(timer); clearTimeout(force); }
    child = undefined;
    handle(buffer);
    requireValue(!interrupted, "Pi exceeded the smoke deadline or was interrupted");
    requireValue(exit === 0 && !streamError, streamError ?? `Pi exited ${exit}: ${diagnostic}`);
    const sessions = files(path.join(home, ".config/intent-prover-staging/sessions")).filter((file) => path.basename(file) === "session.json");
    requireValue(sessions.length === 1, "Expected exactly one proof construction session");
    const session = JSON.parse(fs.readFileSync(sessions[0], "utf8"));
    const proofs = evidence(project).filter(({ file }) => /\/proof-\d+\/result\.json$/.test(file)).sort((a, b) => a.file.localeCompare(b.file, "en", { numeric: true }));
    requireValue(proofs.length > 0, "Pi did not save a real proof submission");
    const saved = proofs.at(-1).snapshot.task;
    const { task } = command(["task", "show", saved.id]);
    result.proof = checkProof(task, saved, session.semantics);
    requireValue(files(path.join(project, ".intent/prove")).some((file) => path.basename(file) === "PROOF.md"), "Pi did not save PROOF.md");
    requireValue(files(path.join(project, ".intent/prove")).some((file) => path.basename(file) === "SCOPE.md"), "Pi did not save SCOPE.md");
    result.status = "passed";
  } catch (error) {
    result.error = error.message;
    process.exitCode = 1;
  } finally {
    // Cancel only jobs recorded by this isolated run, never another account's tasks.
    if (project && env) {
      try {
        for (const { snapshot } of evidence(project)) {
          const id = snapshot.task?.id;
          if (!id || result.tasks.includes(id)) continue;
          result.tasks.push(id);
          try {
            let { task } = command(["task", "show", id]);
            if (!TERMINAL.has(task.status)) {
              result.status = "failed";
              result.error ??= "Pi left an unfinished service task; cleanup requested cancellation";
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
        for (const file of files(path.join(project, ".intent/prove"))) {
          if (!/\.(?:k|md|py|sh)$/.test(file) && path.basename(file) !== "result.json") continue;
          const relative = path.relative(project, file);
          fs.mkdirSync(path.dirname(path.join(output, relative)), { recursive: true });
          write(relative, fs.readFileSync(file, "utf8"));
        }
      } catch (error) {
        result.cleanup.push({ error: error.message });
        result.status = "failed";
        process.exitCode = 1;
      }
    }
    result.runtimeSeconds = (Date.now() - started) / 1000;
    write("result.json", result);
    const summary = `## Website withdrawal smoke: ${result.status}\n\nModel: ${result.model}; thinking: ${result.thinking}\n\nRuntime: ${result.runtimeSeconds.toFixed(1)}s; Pi estimated cost: $${result.usage.estimatedUsd.toFixed(4)} (backend compute excluded).\n\n${result.adequacyReview}\n\n${result.error ? `Failure: ${result.error}\n\n` : ""}Task IDs: ${result.tasks.join(", ") || "none recorded"}.\n`;
    write("summary.md", summary);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, redact(summary));
    console.log(`Website withdrawal smoke: ${result.status}; selected evidence: ${output}`);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
