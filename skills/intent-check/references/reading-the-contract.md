# Interpreting the requested property

The contract defines the theorem; the implementation is what the theorem must
establish. A claim can faithfully describe the code and still miss the request.
Examples illustrate a domain but do not automatically limit it.

## Meaning versus representation

Similar expressions can define different properties:

| Wording or operation | Distinction |
|---|---|
| Alphabetic characters | Case conversion is not an alphabetic predicate; some letters have no case. |
| Decimal digit count | A textual length can include signs; a mathematical digit count may not. |
| Python remainder | `-1 % 10` is `9`, not the last digit of the absolute value. |
| String shape | Parsing can erase trailing zeros, signs and exponent spelling. |
| Splitting text | Delimiter matching does not imply stripping or normalizing whitespace. |
| Untyped containers | Integer examples do not exclude other representable element types. |

Use the stated meaning and any explicitly supplied reference behavior. Language
idioms explain an implementation; they do not settle an unspecified requirement
by themselves. Material ambiguity belongs in the scope, resolved from the task
or clarified with the user rather than hidden in a precondition.

## Contradictions and boundaries

If an example conflicts with a clear definition, show the computed-versus-stated
difference. Do not change the theorem just to match both inconsistent statements.
If the intended precedence is unclear, the requirement remains unresolved.

Separate three cases: the program violates the property; the proof has not
covered part of it; or the pinned semantics cannot represent the needed behavior.
These imply different conclusions. A language-model boundary needs evidence
from the definition or a relevant execution, not an assumed limitation.
