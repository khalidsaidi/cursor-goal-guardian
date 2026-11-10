# Pattern Library (reference)

1. Materiality: flag an item only when the user, reading the goal, would say it isn't done; edge cases
   or polish nobody asked for are not failures.
2. Scope of "extra": tests, types and docs for the new work belong to it; extra means changes to other
   behaviour, renames, refactors, validation or rewrites of existing code or docs that no item needs.
3. Evidence first: run the project's checks and the new behaviour before judging; quote what you saw.
4. Tie-break: when unsure whether something is a failure or extra, say holds and leave it out.
