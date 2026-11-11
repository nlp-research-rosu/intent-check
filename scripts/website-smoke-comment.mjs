// A separate reporting job reads selected artifacts; the agent never receives this token.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = "<!-- intent-website-smoke-report -->";
const text = (value, limit = 1200) => String(value ?? "").slice(0, limit)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/@/g, "&#64;").replace(/[\\`*_{}\[\]()#!|]/g, "\\$&");

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

export function renderReport({ directory, runId, attempt, runUrl, headSha, jobs, artifacts }) {
  const sections = [MARKER, "## Website smoke — advisory", `Run: [${runId}, attempt ${attempt}](${runUrl}) · staging commit: ${text(headSha)}`,
    "These results do not gate merging. **Not proved is not a counterexample; blocked means the requested verification was not completed.**"];
  for (const name of ["withdraw", "mle-bench"]) {
    const artifactName = `${name}-smoke-${runId}-${attempt}`;
    const dir = path.join(directory, artifactName);
    const result = readJson(path.join(dir, "result.json"));
    const artifact = artifacts.find((item) => item.name === artifactName);
    const job = jobs.find((item) => item.name.startsWith(`website (${name},`));
    sections.push(`### ${name === "withdraw" ? "Prove: Python withdrawal" : "Scan: MLE-bench (fast)"}`);
    if (!result) {
      const failed = job?.steps?.find((step) => step.conclusion === "failure");
      sections.push(`**Blocked / no saved result.** Job: ${text(job?.conclusion || job?.status || "unknown")}.${failed ? ` Failed step: ${text(failed.name)}.` : ""}`);
    } else {
      sections.push(`Harness outcome: **${text(result.status)}** · Runtime: ${Number(result.runtimeSeconds ?? 0).toFixed(1)}s.`);
      if (result.error) sections.push(`Diagnostic: ${text(result.error)}`);
      if (result.reportError) sections.push(text(result.reportError));
      const tasks = files(dir).filter((file) => /^task-[0-9a-f-]+\.json$/.test(path.basename(file))).map(readJson);
      if (name === "withdraw") {
        sections.push(`Model: ${text(result.model)} · Reasoning: ${text(result.thinking)} · Pi estimated cost: $${Number(result.usage?.estimatedUsd ?? 0).toFixed(5)} (not billing; backend compute excluded).`);
        const proofs = tasks.filter((task) => task.kind === "proof");
        sections.push(proofs.length ? proofs.map((task) => `- Proof ${text(task.id)}: **${text(task.status)} / ${text(task.result)}**${task.error ? ` — ${text(typeof task.error === "string" ? task.error : JSON.stringify(task.error))}` : ""}`).join("\n") : "**No proof task recorded; none of the requested properties is established.**");
        for (const filename of ["PROOF.md", "SCOPE.md"]) {
          const file = files(path.join(dir, ".intent/prove")).find((entry) => path.basename(entry) === filename);
          if (file) sections.push(`<details><summary>${filename === "PROOF.md" ? "Agent outcome and limitations" : "Agent verification scope"} (reported, not independently audited)</summary>\n\n${text(fs.readFileSync(file, "utf8"), 6000)}\n\n</details>`);
        }
      } else {
        const task = tasks.find((item) => item.kind === "scan");
        sections.push(task ? `Service Scan: **${text(task.status)}** · task ${text(task.id)}.` : "No Scan task recorded.");
        const reportPath = files(path.join(dir, ".intent/scan")).find((file) => path.basename(file) === "report.json");
        const report = reportPath ? readJson(reportPath) : null;
        if (report) {
          const findings = [...(report.cards ?? []), ...(report.one_liners ?? [])];
          sections.push(`Saved report: **${findings.length} findings**. Backend model/compute cost is not measured here.`);
          for (const finding of findings.slice(0, 15)) {
            const locations = finding.source_references ?? finding.cause ?? [{ path: finding.path, line: finding.line }];
            const location = locations.find((item) => item.path);
            sections.push(`- **${text(finding.severity ?? finding.criticality)}** — ${text(finding.title, 300)}${location ? ` (${text(location.path)}:${text(location.line)})` : ""}`);
          }
          if (findings.length > 15) sections.push("Remaining findings are in the retained full report.");
          sections.push(`<details><summary>Scan coverage and limitations</summary>\n\n${text(JSON.stringify(report.coverage, null, 2), 5000)}\n\n</details>`);
        } else sections.push("No saved Scan report; findings and coverage are unavailable.");
      }
    }
    if (artifact) sections.push(`[Download full evidence${result?.html ? " and offline HTML report" : ""}](${runUrl}/artifacts/${artifact.id}) (retained for 7 days).`);
    else sections.push(`No retained artifact found. Inspect the [workflow logs](${runUrl}).`);
  }
  sections.push("Service success alone does not establish that the intended theorem was proved or that Scan findings are correct. Review the claims, assumptions, findings and coverage before promotion.");
  return sections.join("\n\n") + "\n";
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
  const body = renderReport({ directory: process.env.SMOKE_EVIDENCE_DIR, runId, attempt, runUrl, headSha: pr.head.sha, jobs: jobData.jobs, artifacts: artifactData.artifacts });
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
  console.log(`Updated advisory smoke report: ${comment.html_url}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
