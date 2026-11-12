// A separate reporting job reads selected artifacts; the agent never receives this token.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- intent-website-smoke-report -->";

function readJson(file) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

function files(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : entry.isFile() ? [file] : [];
  });
}

export function renderReport({ directory, runId, attempt, runUrl, jobs, artifacts, results }) {
  const rows = ["| Check | Result | Time | Report |", "|---|---|---|---|"];
  for (const name of ["withdraw", "mle-bench"]) {
    const artifactName = `${name}-smoke-${runId}-${attempt}`;
    const dir = path.join(directory, artifactName);
    const artifact = artifacts.find((item) => item.name === artifactName);
    const result = results[name];
    const job = jobs.find((item) => item.name === `Smoke (${name})`);
    let outcome = job?.conclusion === "cancelled" ? "Cancelled" : "Blocked";
    if (result) {
      if (name === "withdraw") {
        const tasks = files(path.join(dir, ".intent/prove"))
          .filter((file) => path.basename(file) === "result.json")
          .map((file) => readJson(file)?.task);
        const proof = tasks.find((task) => task?.kind === "proof" && task.id === result.proof?.taskId);
        if (result.status === "passed" && proof?.status === "completed" && proof.result === "proved") outcome = "Proof succeeded";
        else if (proof?.result === "notProved") outcome = "Not proved";
      } else {
        const reportPath = result.scan?.taskId ? path.join(dir, ".intent/scan", result.scan.taskId, "report.json") : null;
        const report = reportPath ? readJson(reportPath) : null;
        if (result.status === "passed" && report) {
          const count = (report.cards ?? []).length + (report.one_liners ?? []).length;
          outcome = `Completed · ${count} finding${count === 1 ? "" : "s"}`;
        }
      }
    }
    const seconds = Number.isFinite(result?.runtimeSeconds) ? Math.round(result.runtimeSeconds) : null;
    const duration = seconds === null ? "—" : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
    const report = artifact ? `[Download](${runUrl}/artifacts/${artifact.id})` : "Unavailable";
    rows.push(`| ${name === "withdraw" ? "Prove" : "Scan"} | ${outcome} | ${duration} | ${report} |`);
  }
  return [MARKER, "## Smoke tests", rows.join("\n"),
    `[Workflow run](${runUrl}) · Downloads contain the .intent folder (7 days).`].join("\n\n") + "\n";
}

async function main() {
  const event = readJson(process.env.GITHUB_EVENT_PATH);
  const repository = process.env.GITHUB_REPOSITORY;
  const pr = event?.pull_request;
  if (process.env.GITHUB_EVENT_NAME !== "pull_request" || pr?.head.ref !== "staging" || pr?.base.ref !== "main" || pr?.head.repo.full_name !== repository) throw new Error("Only same-repository staging → main PRs may receive a smoke report");
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  const runUrl = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`;
  const api = async (route, method = "GET", body) => {
    const response = await fetch(`${process.env.GITHUB_API_URL}/repos/${repository}${route}`, {
      method, headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error(`GitHub reporting request failed (${response.status})`);
    return response.json();
  };
  const [jobData, artifactData] = await Promise.all([
    api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`),
    api(`/actions/runs/${runId}/artifacts?per_page=100`),
  ]);
  const results = Object.fromEntries(Object.entries(JSON.parse(process.env.SMOKE_RESULTS ?? "{}"))
    .filter(([, value]) => value)
    .map(([name, value]) => [name, JSON.parse(value)]));
  const body = renderReport({ directory: process.env.SMOKE_EVIDENCE_DIR, runId, attempt, runUrl, jobs: jobData.jobs, artifacts: artifactData.artifacts, results });
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  let existing;
  for (let page = 1; !existing; page++) {
    const comments = await api(`/issues/${pr.number}/comments?per_page=100&page=${page}`);
    existing = comments.find((comment) => comment.user?.login === "github-actions[bot]" && comment.body?.startsWith(MARKER));
    if (comments.length < 100) break;
  }
  const comment = existing
    ? await api(`/issues/comments/${existing.id}`, "PATCH", { body })
    : await api(`/issues/${pr.number}/comments`, "POST", { body });
  console.log(`Updated smoke test report: ${comment.html_url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
