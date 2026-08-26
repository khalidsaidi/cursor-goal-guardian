# User-facing content strategy — Goal Guardian 1.0

## The job to be done
Convert a visitor into an installer in 10 seconds, an installer into a
successful first session in 5 minutes (even a junior developer), and a user
into a power user in a week. Every asset below is assigned to exactly one of
those three jobs and one placement.

## Audiences
- **Visitor (10s)** — skimming Open VSX. Needs: one-line promise + one moving
  image proving it. Decides: install or leave.
- **New user (5min, possibly junior)** — just installed. Needs: a guided,
  zero-jargon path to the first "wow" (ask → tracked → tape). Never assume
  they know what MCP, hooks, or event sourcing are.
- **Working user** — needs reference: surfaces, skills, settings.
- **Skeptic/senior** — needs mechanism + evidence.

## Placement map (where every piece lives)
| Surface | Role | Content |
|---|---|---|
| **Open VSX listing** (= extension README) | Storefront | Hero GIF, benefits, "First 10 minutes" tutorial, the tour (per-capability media), full capability matrix, mechanism, reference |
| ~~In-editor Walkthrough~~ | **Dropped after live verification (2026-08-25): Cursor removed the `Welcome: Open Walkthrough` command, so `contributes.walkthroughs` never surfaces.** The guided onboarding lives in the README tutorial, the panel welcome view, and `/guardian` instead. |
| **Panel welcome view** | First-glance teacher | Already built: one promise + one button; add "or just ask your agent — Guardian starts tracking automatically" |
| **`/guardian` skill** | In-chat help desk | Already answers "what can you do"; the briefing IS the tutorial's step 4 |
| **Root README (GitHub)** | Evaluator/contributor page | Architecture, dev, validation (exists; link to extension README for the product story) |
| **CHANGELOG** (Open VSX tab) | Trust signal | Exists |

## Media strategy
- **1 hero GIF** (12–18s loop, ≤6MB, 900px): THE core loop — type a request →
  "Tracking: …" appears → panel fills → a detour happens → calm nudge → judge
  clears it → "on course". Autoplays on the listing; the single
  highest-converting asset.
- **3 focused GIFs** (5–10s each): (a) request→goal in chat, (b) Command
  Center steering, (c) AI review clearing false alarms in the panel.
- **1 annotated panel anatomy image**: every region labeled in plain words
  (junior-friendly).
- **Stills** (already captured): slash menu, pivot transcript, briefing,
  wizard, welcome, palette, consent.
- Production: automation-driven flows + timed frame capture (PowerShell) +
  ffmpeg palettegen GIF assembly.

## README information architecture (rewrite, benefit-first)
1. Banner + one-line hook + **hero GIF** (above the fold)
2. **What you get** — 3 benefit bullets (no mechanism words)
3. **Your first 10 minutes** — numbered junior tutorial: Install → open panel
   → Connect → *ask your agent for anything* → watch "Tracking:" → open the
   panel → type `/guardian`. Each step: one sentence + one image. Plain words
   only ("Guardian writes everything in a small folder in your project — you
   never have to open it").
4. **The tour** — five sections with media: In your chat · The session panel ·
   One-keystroke steering · AI review · Safety rails (never blocks, quiet
   mode, boundaries, uninstall-removes-everything)
5. **Everything it does** — the full capability matrix (all 30, grouped by
   surface, ✓ rows so nothing is invisible)
6. **How it works (plain English)** — existing Redux/mechanism section
7. **Reference** — files, settings, skills, commands
8. Upgrading + Validation

## Walkthrough spec (`contributes.walkthroughs`) — DROPPED, see placement map
ID `goalGuardian.gettingStarted`, title "Get started with Goal Guardian":
1. **Connect Guardian** — media: welcome shot; completes on
   `onCommand:goalGuardian.setup`
2. **Ask your agent for something** — media: tracking GIF; explains
   request-is-the-goal in two sentences
3. **Open the session panel** — media: anatomy image; completes on
   `onCommand:goalGuardian.showPanel`
4. **Steer from chat** — media: briefing still; teaches `/guardian`,
   `/guardian-goal`, and "just say 'actually, let's…'"
5. **Turn on AI review** — media: consent still; completes on
   `onCommand:goalGuardian.rescoreDrift`
6. **The Command Center** — media: center still; completes on
   `onCommand:goalGuardian.commandCenter`

## Execution order
P1 tooling (ffmpeg) → P2 README rewrite to the new architecture (stills
already staged) → P3 walkthrough contribution + step markdown files →
P4 GIF shoots (drive flows with frame capture; hero last, composed from the
best takes) → P5 panel-welcome copy touch → P6 gates, package, verify
walkthrough renders in Cursor, commit.
