pub const ROOT: &str = r#"Connects to the configured remote analysis and verification service.
Add --help to any command or subcommand for its arguments and result details.

Sessions automatically use the repository root, even from a subdirectory.
Outside a repository they use the current directory. --project <directory>
selects another project, with the same root detection. Execution commands use
--session <ID>; --project on them asserts the saved project matches.
Configuration is shared.

Scan and doctor print readable text; other commands print one JSON object to
stdout. Diagnostics may also go to stderr.
View prints a listening URL when its local server starts and a final stopped
object on Ctrl-C; --output exports HTML and returns immediately.
Login first prints a pending JSON object, waits for browser approval, then
prints its final result. Keep that command running while the user signs in.
Run, validate, and prove return the unmodified server response under task,
plus sessionId, budget (used, limit, remaining), and evidenceDir. They exit
with the last task.toolRuns entry's numeric exitCode. A completed task with a
result, no error and an empty toolRuns list exits 0: the service can reuse results
without executing a tool. Its output has exitCode: null, not an invented tool
exit code. Otherwise a missing exit code adds an error diagnostic and the shell
reports failure.
Read each command's help to interpret its backend result; exit 0 alone is not
proof evidence. The CLI does not translate backend outcomes into its own statuses.
Local failures return status failure and exit 1. Budget refusals return status
exhausted and exit 20 without submitting a task. Inspect the JSON to distinguish
these local cases from a backend tool returning the same number.
Argument errors exit 2. Help and version output are plain text.

The budget shows attempts used when the service accepted this task.
Other commands can use more attempts while it runs. Session details include
the latest counts. Task inspection and recovery do not submit new work or
consume another attempt.

Configuration help explains settings, timeouts, and cancellation behavior."#;

pub const SCAN: &str = r#"Submits tracked and non-ignored working-tree text from a Git repository.
The optional file or folder is resolved from the current directory. Evidence
always goes under .intent/scan/<task-id>/ at the repository root.
An optional depth word selects fast (default), balanced or full. Place the
target and depth in either order. Give only one target and one depth.

The collect action accepts an optional task ID. It resumes an existing local
record for this project and service without another upload. Without an ID it
collects pending records. Existing saved reports survive failed downloads.

Scan waits until the service finishes; there is no overall client deadline.
Ctrl-C stops waiting, not the remote task. Its saved record can be collected
later. Findings are analysis, not reproduced bugs or proof results.
Completion prints the existing offline HTML export handoff and remote job link.
Scan and doctor print readable text rather than a JSON envelope.

Plugin data and host options preserve the installed plugin's recovery location
and snapshot metadata. They do not select the service or distribution channel.
Authentication and API/console settings use this CLI's channel configuration.
INTENT_DISABLED=1 and DO_NOT_TRACK=1 prevent Scan submissions and collection."#;

pub const LOGIN: &str = r#"Give the user the returned verification_url.
The link includes the connection code. The user signs in and approves the machine.
The command keeps running, collects the API key, saves it without printing it,
and exits with status connected. No user terminal interaction is needed.
This release channel's server and portal URLs are the defaults. To override
them, set INTENT_API_URL and INTENT_CONSOLE_URL, or edit config.toml.
INTENT_API_KEY, when set, is used instead of the saved key.

Credentials are saved in credentials.json beside config.toml, scoped to the
service origin, with mode 600 on Unix. Do not read this file into agent context.
Config and login output never print a credential. If login expires, is stopped,
or loses its one-time key response, repeat the login command."#;

pub const CONFIG: &str = r#"Shows effective settings and the configuration file location.
To change settings, edit the TOML configuration file. Its location is the
first applicable path:
  $XDG_CONFIG_HOME/intent-prover/config.toml
  %APPDATA%/intent-prover/config.toml (Windows)
  ~/.config/intent-prover/config.toml

The plugin reads this same file through the installed CLI for API
and console endpoints. INTENT_API_URL and INTENT_CONSOLE_URL override it;
blank variables count as unset.

Settings:
  server_url                Service HTTP endpoint.
                            Default: https://api.prover.intentcomputing.org.
  portal_url                Web origin for browser login.
                            Default: https://prover-console.intentcomputing.org.
  request_timeout_seconds   Limit for each HTTP request.
  poll_interval_seconds     Delay between task-status polls.
  max_run_attempts          Concrete-run limit per session. Default: 50.
  max_validation_attempts   Validation limit per session. Default: 50.
  max_proof_attempts        Proof-attempt limit per session. Default: 50.

All numeric settings must be positive and are read on each command.
The service owns task execution limits. Run, validate, and prove do not send a
timeout override or impose a local task or queue-wait deadline. The CLI polls
until the service reports a terminal status, polling retries are exhausted, a
non-retryable request fails, or the user interrupts.
request_timeout_seconds limits individual HTTP requests, not task duration.
Task-status polls retry connection errors, timeouts, and HTTP 408, 429, 500,
502, 503 and 504 up to three times, after 1, 2 and 4 seconds. A successful poll
resets this allowance. Authentication errors, invalid JSON and other HTTP
errors fail immediately. Submissions and cancellation requests are not retried.
If polling stops, the task may still run. Use task wait to reconnect, not prove
or validate to resubmit. Task help explains recovery.
Session counters live in sessions/<ID>/session.json beside config.toml; shared
language sources live in semantics/<id>/<commit>/ there too.
The same XDG_CONFIG_HOME / APPDATA / home-directory rules apply to all three.
Working files and results live in <project>/.intent/prove/sessions/<ID>/.
Inside a repository, <project> is always its root, not the working directory.
Existing project-local descriptors are left untouched and are not imported.

Cancellation:
  Ctrl-C requests cancellation. The request and confirmation polls
  share a five-second limit, also respecting the HTTP request timeout.
  Acceptance alone does not confirm terminal cancellation. Rejection,
  connection failure, or an unconfirmed stop is reported with the task ID and
  evidence location; the server task may still be active. Log retrieval is
  separate and remains subject to the HTTP request timeout.
  result.json is refreshed after each status poll and retains the last server
  response under task. Its optional wait field records the stop reason,
  request errors, and confirmation status.
  The retained task is the actual server response, including if the task
  completes during cancellation. The CLI does not synthesize a timeout task
  or proof outcome. Ctrl-C reports interruption even if the task completes
  in that race.
  The client cancels only this command's task, not other tasks in the session."#;

pub const HEALTH: &str = r#"Returns the server health response and exits 0 only when status is ok.
Inspect the configured endpoint if the request fails."#;

pub const TASK: &str = r#"These commands use the configured server and saved credential. They never
submit a new task or increment any session counter, even at the attempt limit.
Task IDs are in the saved result.json under task.id, or in task list output.

List returns the server's task page, newest first. When hasMore is true, pass
the last task's cursor to --before for the next page. --limit accepts 1 to 100.
Show returns the current server response under task and exits 0 if fetched;
it does not wait, save logs, or establish proof success.

Wait requires the original local session and its saved result.json. It updates
that task's original evidence folder, checks its pinned semantics, and saves
stdout, stderr and metrics without resubmitting. Its output and backend exit
code follow run, validate or prove; budget reflects current session counts.
Use it after the original waiting process has stopped. Logs and other remote
files may already have expired; local evidence cannot reconstruct them.
Configuration help explains polling and Ctrl-C cancellation.

Cancel sends one cancellation request and checks confirmation for up to five
seconds. It returns task and cancellation, including cancellationConfirmed,
and exits 0 only when terminal cancellation is confirmed. Otherwise it exits
1; inspect the returned task, which may have completed during cancellation.
Cancel does not update local evidence; use wait afterward to collect it."#;

pub const SEMANTICS: &str = r#"Lists the configured server's current {id, commit} identities.
The fetch subcommand downloads reference sources for an identity.
The returned ID selects a language definition for a new session."#;

pub const SEMANTICS_FETCH: &str = r#"Downloads the current bundled sources from the configured service's authenticated
/semantics/<id>/archive endpoint. Authentication is required.
The ZIP must match the catalog's semantics ID and commit before it is cached.
Download or extraction failures leave existing cached sources unchanged.

Sources are shared under semantics/<id>/<commit>/ beside config.toml.
Read the returned sourceDir with your agent harness. Do not edit or upload
these reference sources. The CLI does not interpret repository metadata.
Each fetch resolves the current server revision and reuses existing downloads.
It does not change existing session pins. Unsupported revisions are rejected
by the server."#;

pub const RUN: &str = r#"--session identifies an existing session and its pinned language definition.
Create session-specific programs in <workspaceDir>/inputs/.
The program path resolves within the session's projectRoot.
Exit code: the last task.toolRuns entry's exitCode, unchanged, when a tool ran.
With no tool runs, a completed backend result exits 0; see the root command's help.
Also check task.status and task.error. Inspect
saved stdout for the returned state and task.toolRuns for
backend timeout or output-limit outcomes. This does not check a specification.
Every server-accepted run consumes one run attempt, including failure, timeout,
and interruption. The response includes budget (used, limit, remaining).
Run, validation, and proof limits are independent. At the limit, the next run
is refused with local status exhausted and exit 20; the last run's backend
result and exit code are not overwritten.
task.result is success or error; the configuration is in saved stdout.
Evidence is stored under <workspaceDir>/run-NNN/result.json, with inline
stdout and stderr. The snapshot is updated from acceptance to completion.
Configuration help explains timeout and cancellation behavior."#;

pub const SESSION: &str = r#"Start detects the repository root automatically from the current directory
or --project directory. Worktrees and submodules use their own repository root.
Outside a repository, that directory is the project root.
Start creates a fresh session ID with zero operation counters.
The global session.json records only its ID, projectRoot, semantics identity,
attemptsUsed, validationsUsed, and runsUsed. Settings remain in config.toml.
Each operation has its own sequence: run-NNN, validation-NNN, proof-NNN.
Each accepted operation increments only its own counter.

Create inputs/ inside the returned workspaceDir and write session input files
there (spec.k, verification.k, and concrete programs). Keep results outside
inputs/. Pass --session <ID> to run, validate, and prove.
Proof paths resolve within workspaceDir and must stay inside inputs/.
Uploads omit the inputs/ prefix and preserve internal paths and file contents.
Run program paths
resolve within projectRoot. Show returns the stored fields plus workspaceDir.
Remaining attempts are the configured maximum minus the used counter, floored
at zero. You can run several commands at the same time with the same session ID.
They share the session's attempt limits, and each saves its own results.
The client submits one task at a time, but it can wait for several tasks at once.
Finish writing input files before starting a command. Do not edit those files
while the client reads or uploads them. Use different folders inside inputs/
if commands need different files.
The agent decides when to start another session; there is no automatic reset."#;

const SOURCE_FILES: &str = r#"Proof inputs:
  --session identifies an existing session and its pinned language definition.
  Write proof files in <workspaceDir>/inputs/. Paths are relative to workspaceDir,
  not the shell directory. --spec includes the specification; --spec-module
  names its claim module. --verification includes optional helpers and requires
  --verification-module to name their module.

  --source includes an additional dependency. Repeat it for every direct and
  indirect local import not already included by --spec or --verification.
  Imports are not discovered automatically. Validation does not save an upload
  list for later commands; supply the same dependencies again when proving."#;

const CLAIM_LABELS: &str = r#"Claim selection:
  Use the label format from your specification:
    claim [loop-inv]: in module SPEC  ->  SPEC.loop-inv
    claim [label(loop-inv)]:          ->  loop-inv
  Check these forms if the server reports Unused filtering labels.

  Without --claim, all claims are selected before exclusions. With --claim,
  only the named claims are selected. Filtering happens before trust: include
  every trusted label in the --claim selection when combining these options.
  An omitted claim is removed even if named by --trusted.

  Example selection on a prove command (in addition to its required arguments):
    --claim SPEC.loop-inv --claim SPEC.entry --trusted SPEC.loop-inv
  This assumes SPEC.loop-inv and attempts SPEC.entry. It does not prove both.
  To skip a claim, use --exclude-claim LABEL. Repeat either filter as needed.

Several claims:
  Repeat --claim to check several claims in one command:
    --claim SPEC.first --claim SPEC.second
  This uses one proof attempt. It does not make the claims run at the same time.

Parallel proofs:
  Start separate prove commands without waiting for the first to finish.
  Use the same session ID and select the relevant claims in each command.
  Both commands count towards the same proof-attempt limit.
  Each saves its own result. Check the result of both commands.
  If a claim needs another claim, include both in its command.
  One command does not reuse proofs from another command."#;

const EVIDENCE: &str = r#"Evidence:
  The CLI automatically polls the service while the command runs. The evidenceDir
  contains only result.json: it starts with the accepted task, then each poll
  replaces it with the latest task response. Earlier snapshots are not kept.
  At completion it adds inline stdout and stderr. The file holds the last
  server response under task, including its ID, semantics, status, and result.
  The file saves /tasks/{id}/metrics separately under metrics during execution
  and afterward. An empty object means no snapshot is available. Fetch failures
  appear as metricsError, retaining the last fetched metrics without changing
  the task outcome. Remote files expire after 48 hours by default; these local
  snapshots remain in the session workspace. Read
  saved stdout and stderr together with the task result when diagnosing a
  proof. The proof result has no residual field.
  Backend task.status describes the job lifecycle:
  queued or running means unfinished; completed means execution finished;
  failed means preparation or execution failed; timed_out means its time limit
  ended it; cancelled means cancellation; data_expired means files have expired.
  A failed or timed_out task has task.error.code, which sets the next step:
  INVALID_INPUT: fix the input. K's message is in stderr; details.path names
  the source at fault, and details.supported the current semantics revision.
  PROOF_UNDECIDED: the solver decided nothing, so this is no counterexample.
  Split the claim or add lemmas. PROVER_BACKEND_FAILED: change the proof
  before resubmitting. TIMED_OUT: narrow the program or claim; details.tool
  names the tool. TASK_FILE_MISSING: submit again. SERVICE_UNAVAILABLE: try
  again later. INTERNAL_ERROR or an unknown code: the service already retried;
  report the task ID. task.error.message is fixed text; do not parse it.
  A completed task is not necessarily a successful run, validation, or proof.
  A completed task with a result, no error and an empty toolRuns list can be
  a reused backend result. The CLI exits 0 with exitCode: null; this reports
  completion, not proof success. Inspect task.result and saved evidence.
  Otherwise, if the final tool run has no numeric exit code, the CLI adds
  exitCode: null and error: "Backend did not provide a final tool exit code."
  Task and saved backend evidence remain unchanged.
  CLI budget data is not duplicated in evidence files. Local errors include
  a message with the task ID and evidence location when available.
  Recover an accepted task with the task wait subcommand.
  A polling failure retains the last task response. A failed log download
  retains previously saved logs and records stdoutError or stderrError.
  New submissions save reportUrl beside task: it points to the console configured
  when the job was accepted and survives later configuration changes.
  For a user handoff, update .intent/prove/<target>/PROOF.md and SCOPE.md, then
  export a new HTML report with the viewer's --output option. Present the
  local HTML first; remote jobs and raw evidence are secondary. Export is local
  and needs no sign-in. Preserve the actual outcome, scope and assumptions.
  Configuration help explains timeouts and cancellation."#;

pub fn validate() -> String {
    format!(
        "{SOURCE_FILES}\n\n{CLAIM_LABELS}\n\n\
Validation results:
  Compiles proof sources without proving claims. The CLI returns the backend
  task unchanged and uses the last task.toolRuns entry's exitCode when a tool
  ran; nonzero is its diagnostic exit code. A completed reused result with no
  tool runs exits 0, whether valid or invalid. Inspect
  task.result (valid or invalid), task.toolRuns, and task.error for evidence.
  Neither compilation nor a valid result establishes proof or non-vacuity.
  Accepted submissions increment validationsUsed and are retained under
  <workspaceDir>/validation-NNN/, including failed tasks. The response includes
  budget (used, limit, remaining) and evidenceDir. At the limit, the next
  validation is refused with local status exhausted and exit 20; the last
  validation's backend result and exit code are not overwritten.\n\n{EVIDENCE}"
    )
}

pub fn prove() -> String {
    format!(
        "{SOURCE_FILES}\n\n{CLAIM_LABELS}\n\n\
Proof results and attempts:
  Each server-accepted proof consumes one attempt, including interruption,
  timeout, replay, and audit mutation. Evidence is stored under
  <workspaceDir>/proof-NNN/. The response includes the backend task unchanged,
  sessionId, budget (used, limit, remaining), and evidenceDir.
  Exit code: the last task.toolRuns entry's exitCode when a tool ran. A completed
  reused result with no tool runs exits 0, whether proved or notProved.
  Zero alone does not establish proof. Nonzero tool exits pass through unchanged;
  there is no CLI-specific retry code or outcome mapping.
  Check task.result together with the saved logs and tool evidence:
    proved        Selected claims passed or were admitted with --trusted.
    notProved     At least one claim remains unproved, including bounded leaves.
  Preparation or execution failures appear in task.error with status failed.
  PyK APR stdout reports each claim's summary, pending node IDs, and failing
  nodes' reasons and path conditions, including after a timeout. Other backends
  emit their residual as KAST in stdout; parse it without a recursion limit.
  task.definitionId identifies the compiled definition.
  These are backend fields passed through unchanged, not CLI classifications.
  A successful proof does not establish that its assumptions are sound or that
  its theorem matches the intended property; inspect the evidence and audit it.
  At the limit, the next proof is refused with local status exhausted and exit
  20; the last proof's backend result and exit code are not overwritten.
\n\
Bounded diagnosis:
  Add --claim SPEC.loop-inv --depth 10 to inspect one claim at a limited depth.
  Remove --depth for the final proof; see that option's help for its limits.
  Use the same sessionId for subsequent attempts.\n\n{EVIDENCE}"
    )
}
pub const VIEW: &str = r#"Without --output, serves a read-only viewer on 127.0.0.1. Open the printed URL;
Ctrl-C stops the server. The page refreshes local artifacts and active checks
every ten seconds. It never submits tasks or contacts the remote service.

--output writes a self-contained offline HTML snapshot using system fonts.
It never overwrites an existing file. Share it only with people who may read
the included .intent evidence. It does not include source workspaces,
credentials, plugin prompts or transcripts. Symlinks and hidden files are not
exported. Saved Scan reports include findings, coverage and source metadata;
supporting Scan detail files remain remote. Proofs display existing PROOF.md,
SCOPE.md and session evidence; the viewer does not generate those documents.
Present one local HTML link as the user handoff, not raw JSON or a console login.
The HTML includes optional Open job in Prover links from saved Scan URLs and new
proof-operation reportUrl records. It never guesses missing historical URLs
from current configuration. Remote jobs may require sign-in; local viewing does not.

Append #view=scans&scan=scan%2F<TASK_ID>%2Fmeta.json to open a specific Scan, or
#view=proofs&proof=prove%2F<TARGET>%2F&proofTab=report for a proof report.
URL-encode paths in these fragments. Hash links select local content only.

The name comes from the origin repository name, falling back to the root folder.
Scan reports and proof sessions come from this project's .intent directory.
Scan progress comes from installed Claude Code/Codex plugin data; set
--plugin-data for a custom or isolated plugin installation. Scan status is the
last locally saved state, not a fresh server status."#;
