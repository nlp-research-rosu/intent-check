# Proof-extension soundness contract

Use this contract whenever a proof adds a function, equation, claim, or rewrite
that contributes to closing a reachability claim. A successful Prover run
establishes closure under the supplied theory; validate that theory before
claiming a proof of the program.

## Classify every proof extension

| Class | Meaning | Required justification |
|---|---|---|
| Definitional summary | Names a mathematical value without replacing program execution | Truthful, guarded, terminating equations covering every use |
| Derived lemma | States a consequence of fixed semantics or established mathematics | A derivation valid over the lemma's complete guard |
| Operational bridge | Replaces or accelerates a term fixed semantics would execute | Equivalence to the exact execution, binding, control, and state transition |
| Trusted primitive | Represents a fixed operation intentionally outside the theorem | An explicit conditional trust boundary and independent evidence where available |

Classify by behavior, not by the symbol's name. A rule called a summary is an
operational bridge when it rewrites a program term before fixed semantics can
execute it. Program-defined code belongs to the program under verification; do
not reclassify it as an external primitive because proving it is difficult.

**A derived lemma must be derived.** A simplification whose conclusion is the
requested postcondition itself, the aggregate value, ordering, primality,
membership, or any other human-facing property of the program's own result , 
installed with only an informal or on-paper justification is not a lemma; it
is the theorem assumed as an axiom, and no amount of reconstruction,
non-vacuity, or finite differential evidence legitimizes it. The test:
delete the rule, if the target becomes unprovable and the rule's statement
is (or directly entails) the target's postcondition, prove that statement as
a K claim (a loop-invariant circularity or auxiliary theorem over the same
fixed semantics) or the extension is an illegitimate material assumption.
Result-characterizing invariants are provable the same way the loop computes
them: thread the property through the loop claim (running product, running
order bound, divisor-exhaustion witness) instead of asserting it about the
finished result.

Operational bridges carry a heavy admission precondition; see the
[Gate A obligations](gate-a-soundness.md) before proposing one.

## The three gates

- **Gate A, Real-program soundness.** The proof's extensions must be
  sound about the real program: program-defined code executes or is
  connected by exact auxiliary theorems, bridges preserve state,
  binding, and control, equations are true wherever their guards
  apply, and the final claim constrains the result non-vacuously.
  Full obligations: [gate-a-soundness.md](gate-a-soundness.md).
- **Gate B, Intent adequacy.** A sound theorem must match the
  intended property: the formal domain covers the source contract,
  the language model is adequate and its boundaries witnessed, and
  summaries mean what the contract means. Full obligations:
  [gate-b-adequacy.md](gate-b-adequacy.md).
- **Gate C, Trust and evidence auditability.** Every unproved
  component is ledgered, every claimed test is reproducible, and the
  result language separates proved, conditional, empirical, and
  excluded. Full obligations: [gate-c-evidence.md](gate-c-evidence.md).

## Gate A repair transition

Gate A failure is a repair signal, not a successful proof state. Remove or
disable an unjustified extension and repair the proof using fixed semantics
and justified theory. Inspect the genuine residual when it helps locate the
defect. Recheck affected claims and review obligations after the repair;
unaffected evidence can be reused when its inputs and assumptions still match.

Repairs stay within the existing session and resource limits. Stop when the
user stops the work, the budget is exhausted, or an evidenced hard blocker
prevents progress. Hard blockers include unavailable required tools or inputs,
an out-of-scope fixed-semantics language gap, repeated external backend or
resource failure, or inconsistent requirements. Record the unresolved
obligations and evidence when reporting `Incomplete work`.

A difficult proof is not a hard blocker. A slower safe encoding is not a hard
blocker. Repair that requires redesign is not a hard blocker. A passing result
obtained only through an unsound shortcut is not a hard blocker and is not a
usable proof state.

## Proof-extension record

Record each extension's applicable justification in the proof artifacts.
Review the inventory against the actual files rather than trusting a
construction narrative. The fields below guide that review; reference
existing evidence instead of duplicating it in a separate stage report.

| Field | Required content |
|---|---|
| Extension | Exact symbol, rule, or claim |
| Class | One of the four classes above |
| Semantic role | Whether it reasons about or replaces execution |
| Domain | Complete guard and assumptions |
| Matched context | Complete term, continuation, control stack, bindings, and framed cells accepted by the extension |
| Justification scope | Exact configurations established by the derivation, auxiliary theorem, or trust assumption |
| Context containment | Why every matched configuration lies within the justification scope |
| State footprint | Cells read, written, preserved, or abstracted |
| Value influence | Branches, results, state, exceptions, and postconditions affected by the extension's value |
| Value justification | Defining equations, connection theorem, or external contract that fixes each result-bearing value |
| Justification | Derivation, auxiliary theorem, or named trust assumption |
| Dependents | Claims whose closure relies on it |
| Control validation | Connection theorem and any selected operational-sensitivity checks for control-affecting bridges |
| Value validation | Value justification and any selected fixed-versus-extended witnesses for result-bearing abstractions |
| Validation | Gate checks, reproducible evidence, and unresolved gaps |

## Decide the report status

Record PASS or FAIL for every completed gate and identify unchecked or blocked
obligations explicitly. Gate A must pass before issuing a successful proof
status; otherwise report `Incomplete work` and continue repair when possible.

| Result | Status |
|---|---|
| Gate A fails or lacks evidence when work stops | Incomplete work; do not issue a successful proof report |
| Gate A passes and Gate B fails | SOUND-BUT-LIMITED |
| Gates A and B pass and Gate C fails | FORMALLY-SOUND-UNVALIDATED |
| Gates A, B, and C pass | VALIDATED |

Always report later-gate failures even when an earlier gate determines the
headline status.

## Review assurance

Evidence review is required; independent auditing is optional. Same-agent
review checks the actual files and per-claim evidence against the original
scope. An independent reviewer uses a separate context and judges those
artifacts without relying on the constructor's reasoning.

Reuse successful proof evidence by default when the program, claims, proof
extensions, semantics ID and revision, submission controls, and assumptions
match the reviewed artifacts. A new reviewer or audit stage does not itself
justify another proof submission.

Replay only when the user requests it, relevant inputs changed, or retained
evidence is missing or insufficient to resolve a specific reproducibility
question. Before submitting, identify the reason and scope the replay to the
affected claims and required dependencies.

Choose concrete checks, negative controls, or differential tests when they
resolve a specific uncertainty or the user requests them. They are not
universal prerequisites. A missing justification remains a gap even when a
diagnostic check is omitted; finite tests never replace a required theorem.

`VALIDATED` means the recorded gate obligations pass under the stated trust
boundary. It does not imply independent review, replay, or negative controls.
Report the review mode, evidence used, checks performed, and important checks
not performed so readers can distinguish those assurance levels.

## Red flags: stop before reporting success

| Rationalization | Required response |
|---|---|
| “The shortcut is only an optimization.” | Classify it by the execution it replaces and prove full equivalence. |
| “The false case is unreachable.” | Narrow the guard so the rule is true wherever it applies. |
| “Differential tests prove the abstraction.” | Report finite evidence; provide a theorem for universal equivalence. |
| “The source helper is trusted.” | Execute program-defined code or prove an exact auxiliary execution claim. |
| “The return value is right.” | Compare binding, control, exceptions, and every observable state cell. |
| “The same symbol appears in execution and the spec.” | That is circular unless fixed execution is independently connected to the symbol's value. |
