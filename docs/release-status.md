# Release decision: current evidence and remaining work

Updated 2026-11-13 against product commit `c4c1526`. This is the release checklist, not a new benchmark plan.

## Target

Remember the user's goal and keep Cursor working on it; independently check unfinished or meaningfully unrequested work; improve the reviewer from feedback through RRSI. Codex and DeepSeek goal code, CGG's reviewer, ADK and RRSI remain the intended components. Help ordinary agents finish; do not police honesty.

## Completed evidence: do not restart these gates

| Area | Existing evidence | What it establishes |
|---|---|---|
| Goal retention and human control | `5a1cb7a`; `cursor-desktop-final/acceptance.json` | Actual Cursor desktop with WSL respected the temporary stop, retained the original goal across a fresh chat and completed with both independent checks. |
| Automatic correction | `d4b43b8`; `cgg-automatic-final-2026-11-12/assessment.json` | Actual Cursor CLI received CGG findings, repaired incomplete work and ended proved without a person relaying feedback. Independent public-entry checks passed. Both final checks ran. This was a controlled case; it did not exercise a stop-hook continuation round. |
| Meaningful unrequested-work detection | `5a1cb7a` and earlier reviewer work; `outcomes-live-v2/verified-summary.json`, case `unrelated_behavior` | Real Claude through the lab Cursor-compatible adapter detected an unrequested change to existing API behavior. This was a real model, not a scripted fake, though not native Cursor authentication. Historical study cases also exercised unrequested changes. Do not call this capability untested. |
| RRSI's ability to improve a reviewer prompt | `f597b5d`; historical `t15/result.json` and its `replay.sh` | The RRSI-derived prompt performed better in real-Claude replays without losing catches in that replay. This is historical evidence, not validation of today's automatic adoption policy. The earlier search itself lost a held-out catch and would fail today's gate. |
| Current feedback and learning machinery | `45be7ce`, `c4c1526` | Local integration checks exercise correction -> original goal resumed; feedback -> real RRSI search with a stand-in model -> held-out gate -> apply/undo. Learning waits for goal work, has a shared invocation allowance, prevents overlapping runs, and requires both kinds of examples in both splits. These checks do not establish improvement with a real model. |
| Packaging and installation | `c4c1526`; recorded local full-suite/build/package checks | Linux-x64 package built and installed. Installed learning adapter files matched the tested source and archive. Do not list packaging as wholly unverified. |

The local records above are under `/home/khali/ggw-study/`; they are existing supporting evidence, not a requirement to copy raw logs into this repository.

## One remaining release gate

- [ ] Validate the current automatic feedback -> RRSI -> candidate evaluation -> adoption -> subsequent review path with a real model, within a predeclared usage allowance. Historical prompt improvement and current stand-in integration tests are relevant but do not substitute for this combined check. A safely rejected candidate establishes the guard, not an improvement; do not claim that the reviewer got better unless the measured result supports it.

Reuse the existing cases and feedback records where they retain the necessary context. Do not fabricate user feedback or treat deliberate-bluff cases as ordinary-use evidence. Check current account usage before spending quota; do not infer reset or remaining allowance from the date.

After that gate, make the publication decision against this brief. If it fails, identify the specific failed requirement; do not add unrelated features or reopen completed gates. If it passes, publication preparation follows without inventing another round of product validation.

## Carry evidence forward

The first reviewer timed out in the successful automatic repair case, but ADK supplied useful findings and both final checks completed. That is a recorded reliability limitation, not grounds to erase the successful workflow or demand zero timeouts in all future tasks.

Only reopen an area when a relevant change can invalidate its behavior or an observed failure contradicts the evidence. UI-only changes, learning limits and documentation edits do not by themselves require repeating goal retention, ordinary repair and scope-detection studies.

No evidence here establishes that every future task will finish correctly, or that ordinary users' feedback has already improved their reviewers in practice. Preserve those limits without turning them into an indefinite release programme.
