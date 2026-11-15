# CGG's Google RRSI learning domain

Google Research's RRSI searches for useful changes to CGG's reviewer prompt. It uses the user's specific feedback on saved review findings: retain useful catches and remove unnecessary complaints. CGG's current-review context also uses explicit corrections immediately; RRSI supplies later qualified prompt adaptation.

The upstream RRSI engine is retained in `third_party/rrsi`. CGG's domain is copied into an isolated checkout under the workspace's Guardian directory. It replays saved work through the installed hook and candidate prompt, with native `cursor-agent` supplying the search roles and any needed issue-identity matching. CGG does not change RRSI's upstream files.

## What is connected

- `adapter.py`: task splits, actual replay, specific-finding scores/weights and RRSI's own selection guards. Observed useful catches cannot be traded for fewer false complaints. Prompt edits use RRSI's real `prompt` category so history/credit remain meaningful.
- `feedback.py`: match the same concrete issue without exposing the desired label; a different flag is not the original catch. Unknown identity cannot qualify an update.
- `cursor_llm.py`: transport for the analyst, digester, proposer and critic through the user's Cursor model.
- `model_budget.py`: shared per-attempt and rolling workspace invocation allowances.
- `replay_cache.py`: compatible complete observations; labels can change without pretending the model reran, while scores are recalculated. Case, prompt, model/runtime or dependency changes prevent incompatible reuse.
- Constitution and briefs: allow supported stable workspace inspection knowledge, but not memorized case answers, changed user requirements or unconsumed learned files.

Only the consumed reviewer prompt is adopted. The goal, fixed completion checks and ADK evaluator are outside the learned output. A withheld comparison must improve the specific feedback judgments and preserve confirmed catches before adoption. The panel records adoption and offers Undo.

## When it runs

Automatic learning needs enough examples of both useful findings and unnecessary complaints in training and withheld splits, then enough new labelled reviews to try again. It waits while a goal is active or paused and yields to foreground work. Current automatic search is one round with one candidate; other multi-round exploration modes are not claimed as active.

Off, Light and Standard controls are in the Command Center. Per-attempt and rolling workspace allowances share usage across search, replays and issue matching. The standard allowance is 32 headless invocations; an invocation can contain several provider model turns, so this is not a dollar or token cap. A limited or unqualified run keeps the current reviewer, and compatible progress/history can be reused.

## Evidence

Earlier real-model RRSI search produced useful prompt changes; later native Cursor checks verified candidate installation/use and the current explicit-feedback connection. Local tests cover the current domain, guards, specific scoring, caches, controls and adoption/undo with stand-ins. A new winning automatic search is not required to repeat those completed checks.

Naturally accumulated user feedback has not yet demonstrated an improvement, and a fresh full feedback-to-search-to-automatic-adoption sequence has not completed in one native Cursor run. This is not a guarantee of improvement from every correction. See [verification](../../docs/verification.md) and the [maintainer record](../../docs/release-status.md). Native package checks execute RRSI transport through the bundled Python; controlled native learning tests cover search, adoption, recovery and allowances. These checks use stand-in model responses and do not add a real-model improvement estimate.
