#!/usr/bin/env python3
"""Content and structure tests for the proof skills and shared doctrine.

Every expectation is declared as data below; the test methods are the
generic mechanisms that apply it:

- SKELETONS  : the H2 structure each skill family must follow
- SECTIONS   : heading sets owned by the doctrine core and gate spokes
- TEMPLATES  : heading order in embedded artifact examples
- LINK_GRAPH : required edges from each skill to shared references
- ANCHORS    : doctrine sentences that live in exactly one file
- REQUIRED   : load-bearing phrases that must stay present per file
- FORBIDDEN  : leakage strings and stale vocabulary banned everywhere
"""
from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[2]
CORE = "skills/shared/proof-extension-soundness.md"
GATE_A = "skills/shared/gate-a-soundness.md"
GATE_B = "skills/shared/gate-b-adequacy.md"
GATE_C = "skills/shared/gate-c-evidence.md"
READING = "skills/shared/reading-the-contract.md"
RUNNING_K = "skills/shared/running-k.md"

CONSTRUCTOR_SKILLS = (
    "writing-semantics",
    "writing-spec",
    "proving-spec",
)
AUDIT_SKILLS = ("auditing-semantics", "auditing-spec", "validating-proof")

# The audit tail: the closing H2 run every auditor shares, in order.
# auditing-semantics has no on-paper stage (on-paper produces no
# semantics.k), so that section is exempt there.
AUDIT_TAIL = (
    "Findings need witnesses",
    "Unavailable Intent Check service",
    "Verdict artifact",
    "Dispatch contract",
)
AUDIT_TAIL_EXEMPT = {"auditing-semantics": {"Unavailable Intent Check service"}}

SECTIONS = {
    CORE: (
        "Classify every proof extension",
        "The three gates",
        "Gate A repair transition",
        "Proof-extension record",
        "Decide the report status",
        "Review assurance",
        "Red flags: stop before reporting success",
    ),
    GATE_A: (
        "A1. Program identity and body sensitivity",
        "A2. Operational-state preservation",
        "A3. Binding, evaluation, and control fidelity",
        "Value fidelity for result-bearing abstractions",
        "Context containment for operational bridges",
        "A4. Logical consistency and rule validity",
        "A5. Result constraint and non-vacuity",
    ),
    GATE_B: (
        "B1. Input-domain alignment",
        "B2. Language-model adequacy",
        "B3. Summary-to-property adequacy",
        "B4. Implementation-to-intent alignment",
    ),
    GATE_C: (
        "C1. Trust ledger",
        "C2. Reproducible evidence",
        "C3. Honest result language",
    ),
}

# Required outbound edges (by target basename) in the load map.
LINK_GRAPH = {
    "skills/using-prove/SKILL.md": (
        "proof-extension-soundness.md",
        "gate-a-soundness.md",
        "gate-b-adequacy.md",
        "gate-c-evidence.md",
        "deriving-invariants.md",
        "reading-the-contract.md",
        "running-k.md",
    ),
    "skills/writing-semantics/SKILL.md": (
        "semantics-template.md",
        "k-syntax.md",
        "running-k.md",
    ),
    "skills/auditing-semantics/SKILL.md": (
        "gate-b-adequacy.md",
    ),
    "skills/writing-spec/SKILL.md": (
        "proof-extension-soundness.md",
        "gate-b-adequacy.md",
        "reading-the-contract.md",
        "deriving-invariants.md",
        "k-syntax.md",
        "k-claims.md",
    ),
    "skills/auditing-spec/SKILL.md": (
        "gate-b-adequacy.md",
        "reading-the-contract.md",
        "deriving-invariants.md",
        "running-k.md",
        "k-syntax.md",
    ),
    "skills/proving-spec/SKILL.md": (
        "proof-extension-soundness.md",
        "gate-a-soundness.md",
        "deriving-invariants.md",
        "circularity-not-applying.md",
        "symbolic-recursion.md",
        "opaque-primitives.md",
        "sort-refinement.md",
        "nested-sequences.md",
        "running-k.md",
        "k-claims.md",
    ),
    "skills/validating-proof/SKILL.md": (
        "proof-extension-soundness.md",
        "gate-a-soundness.md",
        "gate-b-adequacy.md",
        "gate-c-evidence.md",
        "running-k.md",
    ),
}

# Doctrine sentences with exactly one home. A consumer may point at the
# home but must not restate the sentence.
ANCHORS = {
    "bridge-free universal connection theorem": GATE_A,
    "A model boundary must be": GATE_B,
    "A difficult proof is not a hard blocker": CORE,
    "A derived lemma must be derived": CORE,
    "The docstring is the contract": READING,
    "Use ASD-STE100 writing principles": "skills/writing-spec/SKILL.md",
    "A self-contradicted worked example is not a proof-domain failure": READING,
}

# Embedded markdown examples that define an artifact's opening sections.
TEMPLATES = {
    "skills/writing-spec/SKILL.md": (
        "Verification scope",
        ("Property in plain language", "Program boundary"),
    ),
}

# Load-bearing phrases that must stay present (whitespace-normalized).
REQUIRED = {
    CORE: (
        "SOUND-BUT-LIMITED",
        "FORMALLY-SOUND-UNVALIDATED",
        "VALIDATED",
        "Incomplete work",
        "Gate A failure is a repair signal",
        "A slower safe encoding is not a hard blocker",
        "Repair that requires redesign is not a hard blocker",
        "unavailable required tools or inputs",
        "Repairs stay within the existing session and resource limits",
        "Evidence review is required; independent auditing is optional",
        "finite tests never replace a required theorem",
        "It does not imply independent review, replay, or negative controls",
        "Classify by behavior, not by the symbol's name",
    ),
    GATE_A: (
        "must not import the proposed bridge",
        "Finite tests do not satisfy this precondition",
        "operational-sensitivity mutation",
    ),
    GATE_B: (
        "witnessed, not assumed",
        "finitely many fixed sizes",
    ),
    READING: ("here is the Python example set",),
    "skills/writing-semantics/SKILL.md": (
        "smoke/RESULTS.md",
        "semantics.json",
    ),
    "skills/writing-spec/SKILL.md": (
        "VERIFICATION-SUMMARIES",
        "SCOPE.md",
        "session ID",
        "Make `## Property in plain language` the first section after the title",
        "Before submitting a K specification to the prover",
        "describe each property checked",
        "Do not use K notation or undefined technical terms",
        "Explain the permitted inputs, required result and state changes",
        "important conditions or exclusions",
        "Describe the submitted claims, not a stronger intended property",
        "State that termination is not proved",
        "Update the description whenever claims or summary definitions change",
    ),
    "skills/auditing-spec/SKILL.md": (
        "session ID",
        "Check that `SCOPE.md` starts with `## Property in plain language` after its title",
        "Check each description against the submitted claims and summary definitions",
        "Missing descriptions, unreadable wording",
        "cite the section order or wording as the witness",
    ),
    "skills/proving-spec/SKILL.md": (
        "proof extensions belong in `VERIFICATION`",
        "changed assumptions invalidate dependent evidence",
        "session ID",
    ),
    "skills/validating-proof/SKILL.md": (
        "Clean-room reconstruction",
        "Program pinning",
        "Existing mutation evidence can be reused",
        "Same-agent review is the default",
        "Missing or mismatched evidence leaves an obligation unresolved",
        "Recheck full intent adequacy against the original contract",
        "session ID",
    ),
    "skills/using-prove/SKILL.md": (
        "Discover available semantics with `intent-check semantics`",
        "Use the global `intent-check` CLI on `PATH`.",
        "Start one bounded session before construction",
        "Same-agent evidence review is the default",
        "Load specialist skills and references as needed",
        "Prefer bottom-up verification",
        "Dependency order matters more than function size",
        "function, smart contract, program, or whole codebase",
        "without inherited construction reasoning",
        "Record `same-agent review` or `independent review`",
        "session ID",
        "Approval to raise a limit resumes the existing session",
        "Other new user feedback that re-enters verification starts a fresh session",
    ),
    RUNNING_K: (
        "intent-check",
        "reachable Intent Check service",
        "health",
        "semantics",
        "run",
        "validate",
        "prove",
        "session.json",
        "workspaceDir",
        "Record assumed claims in the trust ledger",
        "failing nodes' reasons and path conditions",
    ),
    "skills/proof-help/SKILL.md": (
        "intent-check <command> --help",
        "intent-check session start --help",
        "`exhausted` is terminal",
        "Intent Check service owns task execution limits",
        "nor imposes a local task or queue-wait deadline",
    ),
    "skills/onboarding/SKILL.md": (
        "Intent Check requires `intent-check` on `PATH`.",
    ),
}
for _audit in AUDIT_SKILLS:
    _audit_path = f"skills/{_audit}/SKILL.md"
    REQUIRED[_audit_path] = REQUIRED.get(_audit_path, ()) + (
        "VERDICT: PASS | FAIL | BLOCKED",
        "untrusted evidence",
    )

FORBIDDEN_STRINGS = (
    "HumanEval",
    "humaneval",
    "canonical.py",
    "solution.py",
    "_reviews/",
    "problems/",
    "KPROVE_PASSED",
    "PROVER_URL",
    "--url",
    "task.result.residual",
    "residualInStdout",
    "RESIDUAL <KAST JSON>",
    "task.result.outcome",
    "task.result.valid",
    "task.result.configuration",
    "task.metrics",
    "Fresh replay and negative probes remain",
    "assume maximum automation",
    "the-two-claims-in-speck",
    "The live proof workflow covers PyK APR",
    "KIT's live proof guidance uses PyK APR",
    "KIT does not guide live proofs for them",
)
FORBIDDEN_PATTERNS = (re.compile(r"\bGate\s+[123]\b", re.IGNORECASE),)

LINK_RE = re.compile(r"\]\(([^)#]+)")


def read(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def norm(relative_path: str) -> str:
    return " ".join(read(relative_path).split())


def production_text_files() -> list[Path]:
    paths = []
    paths.extend(
        path
        for path in (ROOT / "skills").rglob("*")
        if path.is_file() and path.suffix in {".md", ".py"}
    )
    return sorted(paths)


def headings(relative_path: str, levels: tuple[str, ...] = ("## ",)) -> list[str]:
    """Headings in file order, ignoring code-fence content."""
    found = []
    in_code = False
    for line in read(relative_path).splitlines():
        stripped = line.lstrip()
        if stripped.startswith(("```", "~~~")):
            in_code = not in_code
            continue
        if in_code:
            continue
        for level in levels:
            if line.startswith(level):
                found.append(line[len(level):].strip())
                break
    return found


def link_basenames(relative_path: str) -> set[str]:
    return {
        Path(target).name
        for target in LINK_RE.findall(read(relative_path))
        if not target.startswith(("http://", "https://", "mailto:"))
    }


def is_subsequence(needle: tuple[str, ...], haystack: list[str]) -> bool:
    it = iter(haystack)
    return all(item in it for item in needle)


class SkeletonTests(unittest.TestCase):
    def test_artifact_examples_keep_their_opening_sections(self) -> None:
        for path, (title, sections) in TEMPLATES.items():
            with self.subTest(path=path, title=title):
                blocks = re.findall(r"```markdown\n(.*?)\n```", read(path), re.S)
                examples = [
                    block for block in blocks
                    if block.splitlines()[0] == f"# {title}"
                ]
                self.assertEqual(1, len(examples))
                found = [
                    line.removeprefix("## ")
                    for line in examples[0].splitlines()
                    if line.startswith("## ")
                ]
                self.assertEqual(list(sections), found[:len(sections)])

    def test_constructors_open_with_artifact_close_with_dispatch(self) -> None:
        for skill in CONSTRUCTOR_SKILLS:
            h2 = headings(f"skills/{skill}/SKILL.md")
            with self.subTest(skill=skill):
                self.assertTrue(h2, "no H2 headings found")
                self.assertEqual("Artifact contract", h2[0])
                self.assertEqual("Dispatch contract", h2[-1])

    def test_audits_open_with_stance_and_share_the_tail(self) -> None:
        for skill in AUDIT_SKILLS:
            h2 = headings(f"skills/{skill}/SKILL.md")
            tail = tuple(
                section
                for section in AUDIT_TAIL
                if section not in AUDIT_TAIL_EXEMPT.get(skill, set())
            )
            with self.subTest(skill=skill):
                self.assertEqual("Stance", h2[0])
                self.assertEqual(list(tail), h2[-len(tail):])

    def test_doctrine_files_keep_their_sections(self) -> None:
        for path, sections in SECTIONS.items():
            found = headings(path, levels=("## ", "### "))
            for section in sections:
                with self.subTest(path=path, section=section):
                    self.assertIn(section, found)
            with self.subTest(path=path, check="order"):
                self.assertTrue(
                    is_subsequence(sections, found),
                    f"sections of {path} out of declared order",
                )


class LoadMapTests(unittest.TestCase):
    def test_every_skill_links_its_required_references(self) -> None:
        for path, targets in LINK_GRAPH.items():
            found = link_basenames(path)
            for target in targets:
                with self.subTest(path=path, target=target):
                    self.assertIn(target, found)


class DoctrineTests(unittest.TestCase):
    def test_each_anchor_has_exactly_one_home(self) -> None:
        for phrase, home in ANCHORS.items():
            containing = [
                path
                for path in production_text_files()
                if phrase in " ".join(path.read_text(encoding="utf-8").split())
            ]
            with self.subTest(phrase=phrase):
                self.assertEqual(
                    [ROOT / home],
                    containing,
                    f"anchor {phrase!r} must live only in {home}",
                )

    def test_required_phrases_are_present(self) -> None:
        for path, phrases in REQUIRED.items():
            text = norm(path)
            for phrase in phrases:
                with self.subTest(path=path, phrase=phrase):
                    self.assertIn(phrase, text)


class LeakageTests(unittest.TestCase):
    def test_no_forbidden_content(self) -> None:
        for path in production_text_files():
            text = path.read_text(encoding="utf-8")
            for phrase in FORBIDDEN_STRINGS:
                with self.subTest(path=path.relative_to(ROOT), phrase=phrase):
                    self.assertNotIn(phrase, text)
            for pattern in FORBIDDEN_PATTERNS:
                with self.subTest(
                    path=path.relative_to(ROOT), pattern=pattern.pattern
                ):
                    self.assertIsNone(pattern.search(text))

    def test_no_local_k_commands_in_shell_blocks(self) -> None:
        local_command = re.compile(
            r"^\s*(?:kompile|krun|kprove|kast|kup)(?:\s|$)|"
            r"^\s*command\s+-v\s+(?:kompile|krun|kprove|kast|kup)(?:\s|$)"
        )
        for path in production_text_files():
            in_shell = False
            for line in path.read_text(encoding="utf-8").splitlines():
                stripped = line.strip()
                if stripped.startswith("```"):
                    if in_shell:
                        in_shell = False
                    else:
                        language = stripped.removeprefix("```").strip()
                        in_shell = language in {"bash", "sh", "shell"}
                    continue
                if in_shell:
                    with self.subTest(path=path.relative_to(ROOT), line=line):
                        self.assertIsNone(local_command.search(line))


if __name__ == "__main__":
    unittest.main()
