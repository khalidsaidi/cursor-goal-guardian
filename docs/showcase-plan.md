# Product visual guide

The store visuals explain how CGG helps finish work. They use labelled example data and current production panel markup, not manufactured recordings of a model run.

## Scenes

- Welcome and setup: connect with optional goal, finish conditions and boundaries.
- Ask and track: an ordinary request becomes the project goal.
- Continue: incomplete work returns to the agent with a concrete next step.
- Review: a missing package export is a useful finding; supporting types/docs are not unrelated work.
- Correct: a specific correction helps the next check and is retained for eligible learning.
- Control: pause, resume, mark done and choose a background-learning allowance.
- Briefing: `/guardian` summarizes what remains without requiring another goal interview.

## Asset inventory

Branding is in the extension's images directory. The store subdirectory contains the hero, ask, pivot and review animations; panel anatomy; welcome/setup/tour/session examples; and chat/menu/guidance illustrations. File names are retained so published image links keep working. Each exported scene identifies itself as an example or illustration.

The main store page links the explanatory animations, setup view and session panel. Other assets remain available for documentation and release communication. Regenerate them from `scripts/render-public-media.mjs`; its examples are presentation fixtures, not test outcomes or performance evidence. Run `pnpm build` first. Media generation needs a development Python with Playwright and Pillow plus Chromium; it makes no model calls.

## Accuracy

Show the Windows, macOS and Linux package targets, with x64 and ARM64 variants. Keep real Cursor/model evidence scoped to Linux/WSL and label native integration checks as using a stand-in model. Do not show old permit systems, retired tools, universal platform/test-count claims, automatic honesty judgments or unconditional learned improvements. The panel may display a checked completion only as illustrative example data; that image is not proof of a real task result.
