---
name: guardian-goal
description: Declare or change the goal Guardian tracks for this session.
disable-model-invocation: true
---
# Guardian goal

Accept `/guardian-goal [<objective>|clear|edit <objective>|pause|resume]`. This is DeepSeek Harness's
own `/goal` command.

Call the `goal-guardian` MCP tool `goal_command` with everything the user typed after
`/guardian-goal`, exactly as typed (empty to show the goal), and show them its answer as it is.
After a new or edited objective that lists no 'done when' items, add 2–4 practical items with
`guardian_change_goal` (add_criteria), then continue. Do not interrupt with a goal interview.
