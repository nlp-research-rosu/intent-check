# Reading an underdetermined natural-language contract

Use these conventions when the property to prove is stated as a
docstring-style natural-language contract, a description, worked
examples, implicit conventions, with a presumed naive reference
implementation as the ground truth for whatever the text leaves
unstated. Spec writers apply the conventions when drafting claims;
spec auditors judge domain and reading choices by the same
conventions, so both load this file.

The concrete rules below are stated for Python reference code, here
is the Python example set, the common case for docstring contracts.
For another reference language, keep the two-level structure (the
contract's plain meaning first, the naive reference idiom for its
silences) and substitute that language's naive idioms.

## The docstring is the contract; idioms fill its silences

The docstring's plain natural-language meaning is the ground truth. Where
its words determine behavior, stated inclusion criteria, worked examples,
explicit descriptions, implement that meaning directly, even when a
habitual reference-implementation shortcut would differ (a "count the
digits" criterion includes a two-digit negative regardless of how a naive
`len(str(x))` spelling would classify the sign). Two consequences:

- **Character-class predicates mean the stated class, not a proxy.**
  "Letters" means alphabetic characters, including ones with no upper or
  lower case; a case-based test is a different predicate. "Digits" means
  digit characters, not a sign-dependent string length.
- **Cover the stated class completely.** If the contract names a class
  (letters, digits, whitespace), handle every member the model can
  represent, and document the model's boundary for the rest.

Only where the docstring is genuinely silent, unspecified edge behavior,
tie-breaking it does not mention, exotic inputs outside its stated
domain, fill the gap with the most direct naive Python transcription of
the docstring's nouns, because reference implementations are written that
way, and record the chosen reading:

- **Use the literal naive expression, not an equivalent reformulation.**
  Digit extraction is `x % 10` with Python's modulo semantics (so the
  "unit digit" of a negative number follows `-1 % 10 == 9`), not an
  abs-normalized variant, unless the docstring states otherwise.
- **Size and digit-count predicates are string-length predicates.**
  "At most N digits" in reference code is habitually
  `len(str(x)) <= N`, which counts a minus sign as a character.
- **Transformations specified on a stated alphabet pass other input
  through unchanged.** "Rotate the letters" with lowercase examples means
  characters outside the stated alphabet are emitted verbatim, not
  transformed, dropped, or rejected.
- **Split and scan only what the stated delimiter consumes.** Do not
  strip, collapse, or normalize whitespace beyond what the delimiter
  pattern itself consumes; a fragment's leading or trailing characters
  are part of the fragment.
- **Tests written on the textual form stay textual.** When reference code
  classifies an input by its string shape, a suffix, prefix, length, or
  substring test on the raw text, implement that same string test, never
  a numeric reformulation. Parsing collapses textually distinct inputs
  (trailing zeros, signs, exponent spellings) that the string test
  distinguishes, so an arithmetically equivalent tie or shape check is a
  different function on the full string domain.

These are conventions of how Python reference code is written, not
task-specific facts. When two readings survive, prefer the one the naive
one-line Python implementation would produce, state the choice in the
scope record, and cover the chosen reading's full domain.

## A contradicted example is a documentation defect

**A self-contradicted worked example is not a proof-domain failure.** When
a contract's own definition and one of its worked examples disagree, the
example's stated output is not what the defined operation yields on the
example's input, the definition wins. Implement the definition, record the
contradicted example in the scope record with the computed-versus-stated
divergence, exclude nothing else, and submit the full-domain theorem. Do
not downgrade the report or stop at partial because the contradicted
example fails: an example inconsistent with its own contract cannot be an
obligation, and gating on it converts a documentation defect into a lost
proof.
