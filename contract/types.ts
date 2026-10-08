// Intent Check job API, contract v1. Mirrors job-v1.schema.json exactly.
// Changes are additive only and are applied to both repos in one commit (see README.md).

export type Host = "claude-code" | "codex";
export type Mode = "edit" | "request" | "repo";
export type JobStatusValue = "queued" | "running" | "done" | "failed" | "superseded";
export type Verdict = "no_concerns" | "concerns";
export type ConcernType = "intent_mismatch" | "hidden_assumption" | "implementation_bug";
export type Severity = "high" | "medium";
export type ClaimStatus = "no_conflict_found" | "concern" | "not_checked";

export interface CodexModes {
  approval_policy: string | null;
  sandbox: string | null;
  collaboration_mode: string | null;
}

export interface Intent {
  prompts: string[];
  first_prompt: string | null;
  plan: string | null;
  todos: string[];
  agent_message: string | null;
  notes?: string | null;
}

export interface Prior {
  intent_md: string | null;
  spec_k: string | null;
  semantics_k: string | null;
  source_sha256: string | null;
  verification_k?: string | null;
}

export interface UnitRequest {
  path: string;
  language: string;
  sha256: string;
  diff: string | null;
  content: string;
  content_truncated: boolean;
  /** Optional: real 1-based inclusive line ranges of the regions in a truncated content, in order. */
  regions?: { start: number; end: number }[];
  prior: Prior | null;
}

export interface JobRequest {
  contract_version: "1";
  mode: Mode;
  host: Host;
  host_version: string;
  plugin_version: string;
  os: string;
  session_id: string;
  turn_id: string;
  permission_mode: string | null;
  codex_modes: CodexModes | null;
  intent: Intent;
  units: UnitRequest[];
  changed_lines: number;
  truncated: boolean;
}

export interface JobCreated {
  job_id: string;
  url: string;
  status: "queued";
}

export interface AgentConcern {
  id: string;
  type: ConcernType;
  severity: Severity;
  path: string;
  line: number | null;
  claim_id: string | null;
  title: string;
  explanation: string;
  fix_direction: string;
}

export interface Claim {
  id: string;
  function: string;
  status: ClaimStatus;
}

export interface UnitArtifacts {
  "INTENT.md": string;
  "SPEC.k": string;
  /** May be a one-line stub ("Not generated; see REASONING.md") when REASONING.md carries the reasoning instead. */
  "SEMANTICS.k": string;
  "VERDICT.md": string;
  /** Optional (additive, v1). Summary functions, predicates and lemmas the SPEC.k claims use. */
  "VERIFICATION.k"?: string;
  /** Optional (additive, v1). The natural-language symbolic trace; see contract/README.md for the layout. */
  "REASONING.md"?: string;
}

export interface UnitResult {
  path: string;
  checked_sha256: string;
  verdict: Verdict;
  artifacts: UnitArtifacts;
  claims: Claim[];
}

export interface JobResult {
  verdict: Verdict;
  partial: boolean;
  checked_at: string;
  agent_concerns: AgentConcern[];
  units: UnitResult[];
}

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "payload_too_large"
  | "upgrade_required"
  | "rate_limited"
  | "spend_cap"
  | "blocked"
  | "not_found"
  | "budget_exceeded"
  | "pipeline_error"
  | "internal";

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  reason?: string | null;
}

export interface ErrorResponse {
  error: ErrorBody;
}

export interface JobStatus {
  job_id: string;
  status: JobStatusValue;
  url: string;
  result?: JobResult;
  error?: ErrorBody;
}

export interface ConnectStart {
  host: Host;
  host_version: string;
  plugin_version: string;
  os: string;
  machine_name?: string | null;
}

export interface ConnectCreated {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface ConnectPoll {
  status: "pending" | "approved" | "denied" | "expired" | "consumed";
  api_key?: string;
  /** Handle of the approving account; sent with api_key. Same value as account.handle. */
  handle?: string;
  account?: { handle: string };
}

/** GET /v1/me (Bearer): who the calling key belongs to. */
export interface Me {
  handle: string;
  machine_name: string | null;
  key_last4: string;
  /** Deployment the key is for, e.g. "production" or "staging". */
  environment: string;
}

// DeepScan, contract v1. Mirrors deepscan-v1.schema.json exactly.

export type Criticality = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "MARGINAL";

export interface DeepscanTrimmed {
  path: string;
  reason: string;
}

export interface DeepscanMeta {
  contract_version: "1";
  host: Host;
  plugin_version: string;
  os: string;
  /** https, userinfo stripped; null when the repo has no remote. */
  remote_url: string | null;
  head_sha: string | null;
  branch: string | null;
  dirty: boolean;
  scope: string | null;
  file_count: number;
  bytes: number;
  trimmed: DeepscanTrimmed[];
}

export interface DeepscanFile {
  path: string;
  content: string;
}

/** The document inside the gzip body of POST /v1/deepscans. */
export interface DeepscanUpload {
  meta: DeepscanMeta;
  files: DeepscanFile[];
}

export interface DeepscanCreated {
  job_id: string;
  url: string;
  status: "queued";
}

export interface DeepscanProgress {
  stage: string;
  hunters_done: number;
  hunters_total: number;
  elapsed_s: number;
}

export interface DeepscanCause {
  path: string;
  line: number;
}

export interface DeepscanCard {
  id: string;
  criticality: Criticality;
  title: string;
  property: string;
  cause: DeepscanCause[];
  repro_sketch: string;
  control: string;
}

export interface DeepscanOneLiner {
  criticality: Criticality;
  title: string;
  path: string;
  line: number;
}

/** Agent-facing result, at most 8 KB serialized. */
export interface DeepscanSummary {
  counts: Record<Criticality, number>;
  cards: DeepscanCard[];
  one_liners: DeepscanOneLiner[];
}

export interface DeepscanStatus {
  job_id: string;
  status: JobStatusValue;
  stage: string;
  progress: DeepscanProgress;
  url: string;
  summary?: DeepscanSummary;
  error?: { code: string; message: string; reason?: string | null };
}
