pub const ROOT: &str = r#"The Intent Check plugin bundles agent skills and the intent-check CLI.
intent-check connects to Prover, the remote server.
Use `intent-check <command> --help` for options, examples, and result details.
For nested commands, use e.g. `intent-check session start --help`.

Use --project <directory> when starting a session; it defaults to the current
directory. Execution commands use --session <ID>; --project on them asserts
the saved project matches. Configuration is shared.

Commands print one JSON object to stdout; diagnostics may also go to stderr.
Login first prints a pending JSON object, waits for browser approval, then
prints its final result. Keep that command running while the user signs in.
Run, validate, and prove return the unmodified server response under task,
plus sessionId, budget (used, limit, remaining), and evidenceDir. They exit
with the last task.toolRuns entry's numeric exitCode. If unavailable, the JSON
adds exitCode: null and an error diagnostic; the shell reports failure.
Read each command's help to interpret its backend result; exit 0 alone is not
proof evidence. The CLI does not translate backend outcomes into its own statuses.
Local failures return status failure and exit 1. Budget refusals return status
exhausted and exit 20 without submitting a task. Inspect the JSON to distinguish
these local cases from a backend tool returning the same number.
Argument errors exit 2. Help and version output are plain text.

The budget shows attempts used when Prover accepted this task.
Other commands can use more attempts while it runs. Use
`intent-check session show <SESSION_ID>` to see the latest counts.
Use `intent-check task --help` to inspect or recover accepted tasks without
submitting again or consuming another attempt.

Use `intent-check config --help` for settings, timeouts, and cancellation behavior."#;

pub const LOGIN: &str = r#"Run `intent-check login` and give the user verification_url.
The link includes the connection code. The user signs in and approves the machine.
The command keeps running, collects the API key, saves it without printing it,
and exits with status connected. No user terminal interaction is needed.
Production server and portal URLs are the defaults. To override them, set
INTENT_API_URL and INTENT_CONSOLE_URL, or edit config.toml; see
`intent-check config --help`. INTENT_API_KEY, when set, is used instead of
the saved key.

Credentials are saved in credentials.json beside config.toml, scoped to the
Prover origin, with mode 600 on Unix. Do not read this file into agent context.
Config and login output never print a credential. If login expires, is stopped,
or loses its one-time key response, run intent-check login again."#;

pub const CONFIG: &str = r#"Run `intent-check config` to see effective settings and the configuration file location.
To change settings, edit the TOML configuration file. Its location is the
first applicable path:
  $XDG_CONFIG_HOME/intent-check/config.toml
  %APPDATA%/intent-check/config.toml (Windows)
  ~/.config/intent-check/config.toml

Settings:
  server_url                Prover HTTP endpoint.
                            Default: https://prover.intentcomputing.org.
  portal_url                Prover web origin for browser login.
                            Default: https://prover-console.intentcomputing.org.
  request_timeout_seconds   Limit for each HTTP request.
  poll_interval_seconds     Delay between task-status polls.
  max_run_attempts          Concrete-run limit per session. Default: 50.
  max_validation_attempts   Validation limit per session. Default: 50.
  max_proof_attempts        Proof-attempt limit per session. Default: 50.

All numeric settings must be positive and are read on each command.
Prover owns task execution limits. Run, validate, and prove do not send a
timeout override or impose a local task or queue-wait deadline. The CLI polls
until Prover reports a terminal status, polling retries are exhausted, a
non-retryable request fails, or the user interrupts.
request_timeout_seconds limits individual HTTP requests, not task duration.
Task-status polls retry connection errors, timeouts, and HTTP 408, 429, 500,
502, 503 and 504 up to three times, after 1, 2 and 4 seconds. A successful poll
resets this allowance. Authentication errors, invalid JSON and other HTTP
errors fail immediately. Submissions and cancellation requests are not retried.
If polling stops, the task may still run. Use task wait to reconnect, not prove
or validate to resubmit. See `intent-check task --help`.
Session counters live in sessions/<ID>/session.json beside config.toml; shared
language sources live in semantics/<id>/<commit>/ there too.
The same XDG_CONFIG_HOME / APPDATA / home-directory rules apply to all three.
Working files and results live in <project>/.intent/prove/sessions/<ID>/.
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

pub const HEALTH: &str = r#"Example: intent-check health
Returns the server health response and exits 0 only when status is ok.
Use `intent-check config` to inspect the endpoint if the request fails."#;

pub const TASK: &str = r#"Examples:
  intent-check task list --status running
  intent-check task show <TASK_ID>
  intent-check task wait <TASK_ID> --session <SESSION_ID>
  intent-check task cancel <TASK_ID>

These commands use the configured server and saved credential. They never
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
Polling and Ctrl-C cancellation follow `intent-check config --help`.

Cancel sends one cancellation request and checks confirmation for up to five
seconds. It returns task and cancellation, including cancellationConfirmed,
and exits 0 only when terminal cancellation is confirmed. Otherwise it exits
1; inspect the returned task, which may have completed during cancellation.
Cancel does not update local evidence; use wait afterward to collect it."#;

pub const SEMANTICS: &str = r#"Example: intent-check semantics
Lists the configured server's current {id, commit} identities.
Use `intent-check semantics fetch --help` to download and select a revision.
The returned ID selects a language definition for a new session."#;

pub const SEMANTICS_FETCH: &str = r#"Example: intent-check semantics fetch <SEMANTICS_ID>

Downloads the current bundled sources from the configured Prover's authenticated
/semantics/<id>/archive endpoint. Run `intent-check login` to connect first.
The ZIP must match the catalog's semantics ID and commit before it is cached.
Download or extraction failures leave existing cached sources unchanged.

Sources are shared under semantics/<id>/<commit>/ beside config.toml.
Read the returned sourceDir with your agent harness. Do not edit or upload
these reference sources. The CLI does not interpret repository metadata.
Each fetch resolves the current server revision and reuses existing downloads.
It does not change existing session pins. Unsupported revisions are rejected
by the server."#;

pub const RUN: &str = r#"Start a session, then use its returned sessionId:
  intent-check session start --semantics <SEMANTICS_ID>
  intent-check run --session <SESSION_ID> \
    --program .intent/prove/sessions/<SESSION_ID>/inputs/program

Create session-specific programs in <workspaceDir>/inputs/.
The program path resolves within the session's projectRoot.
Exit code: the last task.toolRuns entry's exitCode, unchanged. Zero means the
backend process exited successfully; also check task.status and task.error. Inspect
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
See `intent-check config --help` for timeout and cancellation behavior."#;

pub const SESSION: &str = r#"Examples:
  intent-check session start --project /absolute/path/to/project --semantics <SEMANTICS_ID>
  intent-check session show <SESSION_ID>

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

const SOURCE_EXAMPLES: &str = r#"Source examples:
  Write files in <workspaceDir>/inputs/. Suppose local requires "..." imports are:
    spec.k -> verification.k -> helper.k -> lib/math.k

  --spec and --verification include the first two files. Supply both other
  files explicitly, including the indirect dependency lib/math.k:

    intent-check validate --session <SESSION_ID> \
      --spec inputs/spec.k --spec-module SPEC \
      --verification inputs/verification.k --verification-module VERIFICATION \
      --source inputs/helper.k --source inputs/lib/math.k

  Repeat the same source options when proving; validation does not save an
  upload list for later commands:

    intent-check prove --session <SESSION_ID> \
      --spec inputs/spec.k --spec-module SPEC \
      --verification inputs/verification.k --verification-module VERIFICATION \
      --source inputs/helper.k --source inputs/lib/math.k

  Start with `intent-check session start --semantics <id>` and use its sessionId.
  Proof file paths are relative to workspaceDir, not the shell directory.
  This example assumes modules SPEC and VERIFICATION in the named files."#;

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
  Use the same session ID:

    intent-check prove --session <SESSION_ID> \
      --spec inputs/spec.k --spec-module SPEC --claim SPEC.first
    intent-check prove --session <SESSION_ID> \
      --spec inputs/spec.k --spec-module SPEC --claim SPEC.second

  Both commands count towards the same proof-attempt limit.
  Each saves its own result. Check the result of both commands.
  If a claim needs another claim, include both in its command.
  One command does not reuse proofs from another command."#;

const EVIDENCE: &str = r#"Evidence:
  The CLI automatically polls Prover while the command runs. The evidenceDir
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
  A completed task is not necessarily a successful run, validation, or proof.
  If the final tool run has no numeric exit code, the CLI adds exitCode: null
  and error: "Backend did not provide a final tool exit code." to its output.
  Task and saved backend evidence remain unchanged.
  CLI budget data is not duplicated in evidence files. Local errors include
  a message with the task ID and evidence location when available.
  Recover an accepted task with task wait; see `intent-check task --help`.
  A polling failure retains the last task response. A failed log download
  retains previously saved logs and records stdoutError or stderrError.
  See `intent-check config --help` for timeouts and cancellation details."#;

pub fn validate() -> String {
    format!(
        "{SOURCE_EXAMPLES}\n\n{CLAIM_LABELS}\n\n\
Validation results:
  Compiles proof sources without proving claims. The CLI returns the backend
  task unchanged and uses the last task.toolRuns entry's exitCode. Zero means
  the backend check succeeded; nonzero is its diagnostic exit code. Inspect
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
        "{SOURCE_EXAMPLES}\n\n{CLAIM_LABELS}\n\n\
Proof results and attempts:
  Each server-accepted proof consumes one attempt, including interruption,
  timeout, replay, and audit mutation. Evidence is stored under
  <workspaceDir>/proof-NNN/. The response includes the backend task unchanged,
  sessionId, budget (used, limit, remaining), and evidenceDir.
  Exit code: the last task.toolRuns entry's exitCode. Zero means the backend process
  exited successfully, not necessarily that the claim was proved. Nonzero is
  the backend's exit code; there is no CLI-specific retry code or outcome mapping.
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
