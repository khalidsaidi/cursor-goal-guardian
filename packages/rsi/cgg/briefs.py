"""Domain paragraphs for RRSI's search roles: Guardian's reviewer."""

ANALYST = """The harness is a reviewer prompt for Goal Guardian, a Cursor extension that keeps AI coding
agents on the user's goal. When the agent says the goal is done, one call to the user's own model,
with shell and file tools in a throwaway copy of the project, reads the user's goal and "done when"
items, inspects the work, runs checks, and returns JSON: each item holds or fails, plus any extra work
no item needs. Any failing item or extra work is a flag, and a flag sends the agent back to work.
Each trace is one real review from this workspace with a verdict from what people did: 'right' (the
reviewer objected and was right: the agent fixed it, or the user agreed) or 'wrong' (it objected but
shouldn't have: the user overruled it or said so). A flag on work that should pass is the main cost,
weighted 2. Find why the reviewer objects to good work (nitpicks, edge cases nobody asked about,
treating tests, types or docs for the new work as extra) and why it misses real gaps."""

DIGESTER = """The trajectory is one replayed review: the case's verdict, whether the reviewer flagged it,
and the items it judged failing or the extra work it named. Say whether the flag or the silence was
right and what in the reviewer's instructions caused it."""

PROPOSER = """Edit harness/reviewer.md, the reviewer prompt. Keep the {goal} and {items} placeholders
and the JSON answer format exactly: {"items":[{"id":...,"verdict":"holds or fails","evidence":...}],
"extra":[{"file":...,"what":...}]}; a flag is any 'fails' or any extra entry. Score: share of cases
judged right, with flags on work that should pass weighted double. Aim for a reviewer a busy developer
trusts: it flags an item only when the user would agree it isn't done, and names extra work only when
it is clearly beyond what any item needs. It must stay general: no project, file, function or language
names, no assumptions about a test tool or file type."""

CRITIC = """Reject a reviewer prompt that names anything specific to the cases (a project, file, function,
or task wording), that hard-codes answers, that tells the reviewer to always or never flag, that removes
the {goal} or {items} placeholders or changes the JSON format, or that assumes a programming language,
test tool or file type."""
