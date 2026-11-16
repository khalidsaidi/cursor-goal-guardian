# Cursor Goal Guardian

**Keep Cursor working on your goal, check the finished work, and learn from your corrections.**

![Cursor Goal Guardian](packages/cursor-goal-guardian-extension/images/banner.png)

Ask for the work as usual. CGG remembers the goal across chats, sends unfinished work back to the agent, and gives completion a separate check.

## One request, through to completion

You ask for CSV export that respects the current filters, with tests. Cursor adds the export and stops, but it still exports filtered-out rows. CGG’s review finds the missing behavior and sends the agent back with a concrete next step. Cursor fixes the export and adds a regression test. CGG checks the updated work against your original request.

![An illustrative CSV task: request, unfinished behavior, CGG follow-up, repair and checked completion](packages/cursor-goal-guardian-extension/images/store/hero.gif)

*Illustrative conversation and example data, with the current CGG panel. This is an explanation of the workflow, not a recording of a real model run.*

## Get started

You need Cursor, a trusted Git project and a signed-in [Cursor CLI](https://cursor.com/docs/cli/installation) on the machine where the project runs. For WSL, install and sign in to the CLI inside WSL. CGG recognizes `agent` and the older `cursor-agent` name. Linux packages require glibc 2.39+ and OpenSSL 3, such as Ubuntu 24.04. CGG bundles its other runtimes; no separate Google Cloud account or Google model key is required.

1. Download the **1.0.2 VSIX** for your operating system and processor from [GitHub releases](https://github.com/khalidsaidi/cursor-goal-guardian/releases/tag/v1.0.2). Choose `win32` for Windows, `darwin` for macOS or `linux` for Linux; choose `arm64` for Apple silicon or an ARM processor, otherwise `x64`. For a WSL project, use the Linux package and install it in the WSL extension host.
2. In Cursor, open the Command Palette (**Ctrl+Shift+P**, or **Cmd+Shift+P** on macOS), run **Extensions: Install from VSIX…** and select the downloaded file.
3. Open your trusted Git project. Run **Goal Guardian: Show Panel**, then click **Connect Guardian**. The goal fields are optional; you can leave them empty.
4. Click **Open MCP Settings** in the setup notification and enable **goal-guardian** for the project. In a remote workspace, open Cursor’s MCP settings manually if the button cannot open them.
5. Ask Cursor for the work as usual: “Add CSV export that respects the current filters, with tests.” That request becomes the goal.

The Open VSX listing may still carry an older version; use the linked release for this build. For an illustrated tour of setup, controls and feedback, see the [store guide](packages/cursor-goal-guardian-extension/README.md).

## Three parts, one purpose

- **Goal loop — Codex + DeepSeek.** CGG remembers your request and finish conditions, brings previous work back into context and sends the agent back with what remains. DeepSeek Harness controls goal status and rounds; OpenAI Codex supplies usage accounting, optional token budgets and continuation instructions. Cursor does the implementation work.
- **Independent review — CGG + Google ADK.** CGG’s reviewer checks the finished project for missing work, real defects and meaningful unrequested changes. Google’s open-source ADK separately evaluates the recorded work and project evidence against your request. Useful findings go back to the agent.
- **Learning from feedback — Google RRSI.** Your specific corrections become examples for testing reviewer-prompt updates. With enough examples, RRSI searches for improvements and CGG checks them on examples withheld from search. An update must improve those judgments without losing confirmed useful findings. You can undo it.

These components have complementary jobs: keep the goal available, check the work, and improve the reviewer from specific corrections. RRSI updates the reviewer prompt; it does not change your goal or the fixed completion checks.

## What happens while you work

The goal lives in `.cursor/goal-guardian/contract.json`, outside the agent's conversational memory. Questions alone do not create a goal. CGG captures requested project work, keeps the recorded request, and uses a detected list as the finish conditions. Only when the request supplies none may the agent add finish conditions.

The agent gets the goal, relevant previous checks and useful findings. Checks can be reused while the relevant project content and evidence stay unchanged. A new commit or a reworded completion report does not by itself require repeating them.

When the agent stops early, Cursor's desktop stop hook can send it back. Continuation is bounded by progress, round limits, user control and any goal token budget. A temporary instruction such as “only the first part for now” leaves the full goal for later.

When completion is requested, the project reviewer and ADK evaluator run. A disputed finding can receive a focused project check. Missing work goes back to the agent; unfinished verification gets a bounded recovery attempt. CGG does not ask the agent to prove its honesty, copy command output into a report or remove useful work to satisfy bookkeeping.

## You stay in control

Pause the goal, resume it, continue it in a new chat, or mark it done yourself. Your latest words are checked when the agent requests a goal change or pause. The agent cannot lift your pause on its own; you can resume from the panel or `/guardian-goal resume`.

The panel distinguishes an independently checked completion from incomplete checks, unresolved review findings, tracking failures, a block, a goal set aside for later, and work stopped by a limit. Internal records call a completion with passing checks `proved`; this describes the checks on that project state, not a guarantee about every possible input.

For learning, use **Goal Guardian: Command Center → Automatic learning…** to choose Off, Light or Standard. Feedback stays saved when learning is off. Background learning yields to active work, shares a rolling workspace allowance across attempts, and keeps the current reviewer when a candidate cannot qualify.

## Usage and privacy

Continuation, review, evaluator judgments and learning use your Cursor plan. A headless invocation can contain several model turns; invocation limits are not dollar or token caps. The reviewer and evaluator run on completion, rather than as extra implementation agents throughout the task. Automatic learning has its own configurable allowance.

Goal records, command output and replayable review cases are stored locally in the project's Guardian folder. Review and learning send relevant project content and records to the model through your Cursor account. Keep confidential material out of model-visible context as you would with Cursor itself.

## What the evidence supports

Real Cursor checks cover goal retention across chats, user control, review-driven repair and completion checks. Recent native reviews also show a specific correction removing an unnecessary complaint while a genuine missing public export remains caught. Earlier real-model RRSI search produced useful prompt changes; separate native checks verified installation of a qualified prompt and its use by a subsequent review.

Local tests cover the current integration, feedback handling, learning guards and usage controls. These are different kinds of evidence. They do not establish that every task will finish correctly, that every review finding is right, or that ordinary users' feedback has already improved reviewers in practice. A fresh full feedback → search → automatic adoption sequence has not completed in one native Cursor run.

See [verification](docs/verification.md), [performance and usage](docs/benchmarks.md) and the [maintainer release record](docs/release-status.md) for their precise scopes. No global improvement percentage or percentage of bundled source used is claimed.

## Limits

- CGG advises and sends follow-up messages; it cannot prevent the agent from stopping.
- Model reviews can be wrong, unavailable or inconclusive. Outside a Git repository the project review does not run, so completion cannot be independently checked by both checks.
- Desktop continuation needs Cursor's stop hook and a trusted workspace. The tested headless CLI does not supply that hook; CLI results do not demonstrate desktop continuation.
- Some ignored-path shell changes are not observed. Multiple stop hooks and Cursor changes can affect follow-ups.
- CGG does not protect its records against deliberate tampering. Its purpose is helping a normal agent finish the work.
- Native package checks exercise the goal loop, review, ADK and RRSI on each target with a stand-in model. Real Cursor/model evidence comes from Linux/WSL; these package checks do not measure model accuracy or desktop delivery on every OS.

## For contributors

Use Node.js and pnpm for development, plus Rust for the Codex goal wrapper. Build and check the parts you change:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:e2e:offline
pnpm package:vsix --target linux-x64
```

Repository layout: `packages/core` owns CGG's adapters and records; `hook` connects Cursor events; `mcp` exposes the six goal/feedback tools; `cursor-goal-guardian-extension` supplies the interface; `codex-goals`, `evaluator` and `rsi` connect the upstream components. See the [design](docs/goal-design.md) and [example workspace](examples/cursor-project/README.md).

Upstream code and legal notices are described in [NOTICE](NOTICE). CGG uses selected capabilities of [OpenAI Codex](https://github.com/openai/codex), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Google ADK](https://github.com/google/adk-python) and [Google Research RRSI](https://github.com/google-research/rrsi).
