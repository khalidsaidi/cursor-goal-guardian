# Product visual guide

The store visuals explain how CGG helps finish work. They use labelled example data and current production panel markup, not manufactured recordings of a model run.

## Scenes

Use one ordinary CSV task throughout: request an export that respects filters, let the agent stop with that behavior unfinished, show CGG sending the finding back, show the agent fixing it with a regression test, then show checked completion. The main animation contains those five stages with readable illustrative chat beside the current panel.

Feedback has its own story: a requested CSV regression test is wrongly called unrelated, the user corrects that specific complaint, and the correction is saved. The final scene explains that later RRSI prompt updates need enough examples and must qualify. It does not show immediate adoption or claim a learning gain from that one correction.

Other visuals each explain an action: connect the project, enable MCP, get a briefing, pause without losing the CSV goal, find the Command Palette, or control learning. Keep the task consistent and avoid repeated panel shots with different slogans. Leave enough time to read each animation frame.

## Asset inventory

Branding is in the extension's images directory. The store subdirectory contains the hero, ask, pivot and review animations; panel anatomy; welcome/setup/tour/session examples; and chat/menu/guidance illustrations. File names are retained so published image links keep working. Each exported scene identifies itself as an example or illustration.

The main store page links the explanatory animations, setup view and session panel. Other assets remain available for documentation and release communication. Regenerate them from `scripts/render-public-media.mjs`; its examples are presentation fixtures, not test outcomes or performance evidence. Run `pnpm build` first. Media generation needs a development Python with Playwright and Pillow plus Chromium; it makes no model calls.

## Accuracy

Show the Windows, macOS and Linux package targets, with x64 and ARM64 variants. Keep real Cursor/model evidence scoped to Linux/WSL and label native integration checks as using a stand-in model. Do not show old permit systems, retired tools, universal platform/test-count claims, automatic honesty judgments or unconditional learned improvements. The panel may display a checked completion only as illustrative example data; that image is not proof of a real task result.
