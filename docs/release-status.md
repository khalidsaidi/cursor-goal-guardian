# Release decision: current evidence and remaining work

Updated 2026-11-13 from product commit `26f93ef`, with the final reference-label finding and consumer-probe review correction. This is the release checklist, not a new benchmark plan.

## Target

Remember the user's goal and keep Cursor working on it; independently check unfinished or meaningfully unrequested work; improve the reviewer from feedback through RRSI. Codex and DeepSeek goal code, CGG's reviewer, ADK and RRSI remain the intended components. Help ordinary agents finish; do not police honesty.

## Completed evidence: do not restart these gates

| Area | Existing evidence | What it establishes |
|---|---|---|
| Goal retention and human control | `5a1cb7a`; `cursor-desktop-final/acceptance.json` | Actual Cursor desktop with WSL respected the temporary stop, retained the original goal across a fresh chat and completed with both independent checks. |
| Automatic correction | `d4b43b8`; `cgg-automatic-final-2026-11-12/assessment.json` | Actual Cursor CLI received CGG findings, repaired incomplete work and ended proved without a person relaying feedback. Independent public-entry checks passed. Both final checks ran. This was a controlled case; it did not exercise a stop-hook continuation round. |
| Meaningful unrequested-work detection | `5a1cb7a` and earlier reviewer work; `outcomes-live-v2/verified-summary.json`, case `unrelated_behavior` | Real Claude through the lab Cursor-compatible adapter detected an unrequested change to existing API behavior. This was a real model, not a scripted fake, though not native Cursor authentication. Historical study cases also exercised unrequested changes. Do not call this capability untested. |
| Earlier real-model RRSI learning demonstration | `f597b5d`; `ext/runs/logs/run.log`, `heldout-base.log`, `heldout-champ.log`; Test 11 in `long/PLAN.md` | RRSI evolved and accepted prompt edits with real Claude models. On a repo-separated held-out set, objections to work labelled complete fell and unrequested-work catches were retained, but one previously caught real failure was missed. This establishes an earlier learning demonstration with a measured tradeoff, not today's automatic adoption path or improvement without regression. Its held-out repos exclude camelcase; the later bad camelcase label does not invalidate this separate result. |
| Current feedback and learning machinery | `45be7ce`, `c4c1526` | Local integration checks exercise correction -> original goal resumed; feedback -> real RRSI search with a stand-in model -> held-out gate -> apply/undo. Learning waits for goal work, has a shared invocation allowance, prevents overlapping runs, and requires both kinds of examples in both splits. These checks do not establish improvement with a real model. |
| Packaging and installation | `c4c1526`; recorded local full-suite/build/package checks | Linux-x64 package built and installed. Installed learning adapter files matched the tested source and archive. Do not list packaging as wholly unverified. |

The local records above are under `/home/khali/ggw-study/`; they are existing supporting evidence, not a requirement to copy raw logs into this repository.

## One remaining release gate

- [ ] Validate the current automatic feedback -> RRSI -> candidate evaluation -> adoption -> subsequent review path with a real model, within a predeclared usage allowance. The earlier real-model prompt-learning demonstration and current stand-in integration tests do not substitute for this combined check. A safely rejected candidate establishes the guard, not an improvement; do not claim that the reviewer got better unless the measured result supports it.

The frozen experiment at `/home/khali/ggw-study/learning-release-final/plan.json` has finished. `runtime-process.json` records completion and `assessment.json` records no adopted prompt and no demonstrated improvement. No paid work remains running. Do not restart the experiment or change its labels to obtain a passing score.

The held-out case `learning_0_2` was labelled finished, but the real reviewer correctly found that the new `toSnake` export was absent from the package's TypeScript declarations. An independent local consumer compilation reproduced TS2614 (`type-finding-verification.json`). This invalidates using that reference label as a false alarm and the perfect-agreement claim from Test 15, which reused that case. It does not invalidate the separate Test 11 held-out result: its frozen held-out repos were bytes.js, dequal, filenamify and klona, excluding camelcase. The earlier blanket withdrawal of historical learning evidence was too broad. Do not train away the useful current catch.

The search also stopped on incomplete training evaluations: one timed out and another was rejected after the reviewer created a temporary consumer-probe link in its copy. The latter was a review setup artifact rather than a source repair; a local regression now allows new consumer links while still rejecting changed submitted inputs and newly added source/tests. Earlier setup attempts exposed an unsupported model setting, replay timeouts and a Node runtime mismatch; those records are preserved separately. None establishes learning improvement.

**Release verdict:** the full three-part claim is not ready to publish. Goal keeping and independent review retain the completed evidence above. The current automatic learning path remains experimental; earlier real-model prompt learning has been demonstrated with a regression tradeoff. A Linux/WSL preview can honestly describe those two established capabilities and the experimental learning machinery, but that is a narrower release than the user's requested proof of all three. Do not silently substitute that scope or add unrelated release gates. No further paid trial is scheduled. The focused review and learning regression suites passed locally after the consumer-probe correction (`final-local-regression.log`); those stand-in tests do not change the real-model learning verdict. The corrected Linux-x64 package built and installed successfully, with installed hook/MCP hashes matching the packaged binaries (`final-package.log`, `final-installed-verification.json`).

Reuse the existing cases and feedback records where they retain the necessary context. Do not fabricate user feedback or treat deliberate-bluff cases as ordinary-use evidence. Check current account usage before spending quota; do not infer reset or remaining allowance from the date.

After that gate, make the publication decision against this brief. If it fails, identify the specific failed requirement; do not add unrelated features or reopen completed gates. If it passes, publication preparation follows without inventing another round of product validation.

## Carry evidence forward

The first reviewer timed out in the successful automatic repair case, but ADK supplied useful findings and both final checks completed. That is a recorded reliability limitation, not grounds to erase the successful workflow or demand zero timeouts in all future tasks.

Only reopen an area when a relevant change can invalidate its behavior or an observed failure contradicts the evidence. UI-only changes, learning limits and documentation edits do not by themselves require repeating goal retention, ordinary repair and scope-detection studies.

No evidence here establishes that every future task will finish correctly, or that ordinary users' feedback has already improved their reviewers in practice. Preserve those limits without turning them into an indefinite release programme.
