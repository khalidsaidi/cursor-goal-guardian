# 100% Capability Showcase — plan

One realistic scenario — **"Ship the checkout flow"** in a small web-shop repo —
driven end-to-end by automation (CDP + input injection) across BOTH surfaces:
the Agents hub and the classic IDE window. Every capability below is
demonstrated live; a curated subset becomes the store screenshots.

## Capability inventory (from code audit)

**Chat layer (hub + IDE agent pane)**
| # | Capability | Demo step | Store shot |
|---|---|---|---|
| C1 | Rule anchor: agent reads contract first | P2/P4 transcripts | S2 |
| C2 | Request-is-the-goal auto-declaration ("Tracking: …") | P2, P4 | S2 |
| C3 | /guardian skill in "/" menu + plain-prose briefing | P4 | S1, S4 |
| C4 | /guardian-goal skill | P4 | S1 |
| C5 | User pivot → recorded on the tape (rule 5) | P4 | S3 |
| C7 | 4 MCP tools (get_contract/update_goal/report_goal/get_status) | P2–P4 tool chips + tape | — |
| C8 | MCP roots resolution + user-level registration + one-time Connect consent | P4 (already proven) | — |

**Hooks (background)**
| C9 | Event observation incl. raw tape (hook.event, action.observed) | all phases (tape) | — |
| C15 | Never blocks / never crashes | implicit everywhere + suite | — |

**State machine**
| C19 | Contract-as-projection | disk | — |

**AI review**
| C20 | Per-drift verdicts w/ rationale + cache | P3 (real judge) | S5 chips |
| C21 | Whole-tape session review | P3 staged | S5 AI line |
| C22 | Consent gating + per-item "check with AI" + rescoreDrift cmd | P3 | S5 consent |

**IDE surfaces**
| C23 | Panel: welcome / goal-as-title(edit) / lamp / Now-Next / Done when / Boundaries | P1+P3 | S5, S6 |
| C24 | Status bar states + tooltip | P3 | S8 |
| C25 | Command Center (7 actions) | P3 | S7 |
| C26 | 8 palette commands (setup, open-files ×3, uninstall, center, panel, refresh) | P1 palette shot + flows | S10 |
| C27 | Setup wizard (3 steps + gitignore) wiring hooks+mcp(ws+user)+rule+skills | P1 | S9 |
| C28 | Doctor + migration (v0.4.x auto, backups, notice) | already verified; excluded from store | — |
| C29 | Opt-in auto-behaviors settings | shown in settings注? excluded from store | — |
| C30 | Uninstall = complete removal (modal) | end of run (cleanup) | — |

## Store screenshot list (images/store/)
S1 hub-slash-menu · S2 hub-tracking · S3 hub-pivot · S4 hub-briefing ·
S5 panel-session (money shot: goal, lamp, done-when, boundaries)
· S6 panel-welcome · S7 command-center · S8 status-bar · S9 setup-wizard ·
S10 palette

## Execution phases
P0 Build /tmp/webshop (realistic: src/cart.ts, prices.ts, order.ts; git).
P1 IDE window: welcome shot → setup wizard shots → palette shot →
P2 IDE agent pane (Ctrl+Shift+L): plain checkout request → Tracking (goal on
   disk).
P3 Drift machinery: staged caution command via agent; Command Center flows
   (notify toggle); consent → real judge verdicts →
   session review → panel money shot, status bar shot.
P4 Hub: same repo → "/" menu shot → follow-up request → Tracking shot →
   pivot request → recorded shot → /guardian briefing shot.
P5 Crop + save to packages/…/images/store/, add Store section to README with
   raw.githubusercontent URLs, full gates, commit.
