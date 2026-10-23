# Nested sequence domains: no custom wrapper sorts

Symptom: the input is a nested container, a sequence of heap references to
inner sequences, and the unbounded claim must range over every well-typed
inner sequence. The tempting representation is a custom embedding wrapper
(`xsSeq(IS)` injecting a homogeneous static sequence into the semantics'
dynamic sequence sort). This fails structurally: the semantics' iteration
rules match the dynamic sort's raw constructors (nil/cons), and the backend
will not narrow a custom wrapper application to those alternatives at the
loop head. Fixed-size instances close while the symbolic claim stalls on
unresolved constructor alternatives or diverges during the case split.

Sound approach, in order:

1. Represent symbolic inputs with the semantics' **own constructors** plus
   recursive domain predicates as claim preconditions (`allXs(S)` for
   element typing, length/shape predicates for structure). A custom wrapper
   sort is never the input representation; if one is convenient as a
   *summary codomain*, keep it out of every operational position.
2. Expose exactly **one constructor layer per circularity**. Give each loop
   its own claim whose initial term already has the iterated sequence in
   nil/cons form; the empty and cons instances are then separate proof
   obligations, and the backend never has to invent the split itself.
3. Summarize each inner loop as a **total, structurally recursive function
   over the raw constructors** (the general summary-shape rule in
   [deriving-invariants.md](deriving-invariants.md)), proved against that
   loop's circularity, so the outer induction carries only the summary
   value, never the inner sequence's structure.
4. Keep unexposed inner sequences **abstract**: one symbolic variable per
   heap entry in the outer claim, with only the currently iterated inner
   sequence unfolded by its own circularity.
5. Nested symbolic induction is memory-intensive on the Haskell backend.
   If a claim still diverges after the restructuring above, record each
   attempt with its resident-memory evidence and report the limitation
   honestly. Do not add iterator accelerator or interception rules to force
   progress, those manufacture a passing result and fail the soundness gates.
