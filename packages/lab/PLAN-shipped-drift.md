# Shipped-product drift test (to run after 2026-11-12, when the Cursor plan resets)

Registered 2026-11-04, before any run.

**Question:** do agents drift less with the product as it ships, with no reviewer and no AI drift check?

**Design:** the 14 narrow tasks in `~/.cache/ggw/study/ab2-tasks.json`, 2 fresh repetitions per arm = 28 pairs, pinned to `composer-2.5`, random arm order. Arms: Guardian as shipped (done check `enforce`, tests on, goal loop on) vs bare project. Blind judges with the A/B 3 brief.

**Primary:** drift incidents per run, paired by task and repetition, two-sided sign test. Shown only if drift is lower with Guardian at p < 0.05.

**Secondary:** the same count leaving out documentation for a feature the request asked for; criteria met; misleading final message.

**Budget:** one agent run per arm per pair, plus Guardian follow-ups. No reviewer calls, so far cheaper than A/B 2 and 3. Stop on the first usage-limit error.
