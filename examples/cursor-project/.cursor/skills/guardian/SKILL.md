---
name: guardian
description: See the session goal and progress — and steer from chat.
disable-model-invocation: true
---
# Guardian

Accept `/guardian [question]`.

1. Call the `goal-guardian` MCP tool `get_goal`.
2. With no question: present a short, readable briefing — the goal, its 'done when' items,
   what is complete, what was checked and what remains. Plain prose, no JSON, no field names.
3. With a question ('what's left?'): answer it from that tool and the project itself.
4. If the user asked to continue, keep working; do not stop at a status report or an offer.
   Use `guardian_change_goal` only when the user actually changes the goal.
