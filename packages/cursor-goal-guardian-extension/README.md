# Cursor Goal Guardian

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/banner.png" alt="Goal Guardian Banner" width="700" />

**Your request becomes the goal, the agent is reminded of it, and it is sent back when it stops early.**

Ask your agent for something the way you always do. Guardian records that request as the
goal, puts it in front of the agent with every message, and when the agent stops before the
goal is accepted, sends it back with what is still open. When the agent says it is done,
the work is checked before that is accepted. It never blocks: the agent can always stop,
and Guardian shows you how the goal stood when it did.

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/hero.gif" alt="The core loop: ask, track, send back" width="900" />

*The screenshots on this page are from an earlier version. The panel's layout is the same;
some of its words have changed.*

## What you get

- **A goal that stays put.** Your own request becomes the goal, with a "done when"
  checklist, kept in a file outside the AI's memory, so a new chat or a compacted one still
  has it.
- **An agent that is sent back.** When it stops early, Guardian sends it back with your
  goal and what's still open.
- **"Done" is checked.** The agent's proof is compared with Guardian's own record of what
  ran. Then a second agent reviews the real project and an evaluator judges the recorded
  run. The panel says whether the goal ended proved, unchecked or disputed.
- **A reviewer you can correct.** Mark each objection right or wrong, or say "this wasn't
  done" when it missed something. Once there are enough verdicts Guardian tries a better
  version of its reviewer by itself, keeps it only if it does better on your past cases it
  didn't learn from, and shows an Undo. This has never run on real feedback: it has only
  been tried on constructed cases, so whether it improves anything for you is unproven.
- **Where things stand.** A glance at the panel, or `/guardian` in chat.

## Your first 10 minutes

Seven steps. Step 5 is the whole of it.

**1. Install.** The panel opens on its own the first time, then never interrupts again.
Nothing is written to your project yet.

**2. That open panel is home base.** It lives behind the target icon at the top of the
file sidebar.

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s6-welcome.png" alt="The welcome panel" width="800" />

**3. Fill the form, or don't.** Say what you're working toward in your own words, press
Enter to add each "done when" line (the × removes it), optionally add a boundary, and click
**Connect Guardian**. Every field is optional. Guardian writes its files into a
`.cursor/goal-guardian` folder.

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s9-setup.png" alt="The in-panel connect form, filled" width="500" />

**4. One switch that belongs to Cursor.** Cursor lists every project-configured MCP server
as *Disabled* until you enable it once. A notification appears with an **Open MCP
Settings** button; flip the switch next to your project's *goal-guardian* row. Once per
project. The panel's **Get started checklist** ticks itself from what happens in your
session.

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s13-tour.png" alt="The panel and get-started checklist right after connecting" width="500" />

**5. Ask your agent for something, like you always do.** If you connected empty, Guardian
records your request in your own words as the goal when the agent first changes something:
the text before a list is the goal, the list becomes the "done when" items, and anything
after the list is left out. If you filled the form, that goal is
already on the record.

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s2-hub-tracking.png" alt="A plain request becomes a tracked goal" width="800" />

**6. Glance at the panel** any time. Your goal is the title. The lamp and its word say
where the goal stands: active, paused, blocked, stalled, proved, unchecked, disputed,
unverified. The checklist ticks each "done when" line that a run's proof backed.

**7. Type `/guardian` in the chat** for a short briefing of where the goal stands.

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s4-hub-briefing.png" alt="/guardian briefing" width="800" />

## The tour

### In your chat

Guardian's skills sit in the same `/` menu as everything else. One plain request, and the
goal and its "done when" list come from it:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/gif-ask.gif" alt="One request becomes a tracked goal with its own done-when list" width="800" />

When you change direction ("actually, let's do X first"), your new words become the goal:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/gif-pivot.gif" alt="A mid-session change of goal" width="800" />

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s1-slash-menu.png" alt="Guardian skills in the slash menu" width="800" />

### The session panel

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/panel-anatomy.png" alt="Panel anatomy, annotated" width="800" />

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s5-session.png" alt="The session panel in a live session" width="900" />

### The Command Center

Click the status bar item (or run "Goal Guardian: Command Center") to update the goal, open
the panel, open one of Guardian's files, or remove Guardian from the workspace:

<img src="https://raw.githubusercontent.com/khalidsaidi/cursor-goal-guardian/main/packages/cursor-goal-guardian-extension/images/store/s7-command-center.png" alt="The Command Center" width="800" />

### How a goal ends

When the agent stops after changing something, it's sent back with your goal and what
Guardian's record shows. For each "done when" line the agent names a command it ran after
its last change and text that command printed, or a file and text in it. Guardian compares
that with what it recorded itself: a command that never ran or failed, a result from before
the latest change, output that doesn't match, or a file that isn't in the project is
refused.

When the record backs every line, two checks run on your own Cursor model. A reviewer works
in a throwaway copy of your project, tries to prove each line isn't really done, and lists
changes no line needs. An evaluator judges Guardian's record of the run against each line
and for work you didn't ask for; when it alone objects, the reviewer checks that claim
against the project first. Objections go back to the agent.

The panel then shows one of:

- **Proved.** The proof held and neither check objected.
- **Unchecked.** The proof held, but a check didn't run or didn't answer for a line: for
  example `cursor-agent` isn't installed, the project isn't a git repository, or it took
  too long.
- **Disputed.** A check objected and it wasn't resolved. Reporting the same work again
  doesn't get a new review.
- **Unverified.** Part of Guardian couldn't run, so the goal was neither kept going nor
  accepted.
- **Blocked.** The agent reported an obstacle outside its reach. If it did so on the first
  turn, the panel says "blocked (unverified)": that was accepted at the agent's word.
- **Set aside.** Your latest message asked for only part of the goal or for something else.
  The agent has to quote it; the goal stays open.
- **Stalled or out of rounds.** Three rounds in a row where nothing changed, or 20
  send-backs for one message from you.

You're in charge from the panel. **Pause goal** stops the chat at work and the send-backs;
the agent can pause only by quoting your request to pause from your latest message, and can
never lift a pause. You lift it from the panel, or by sending `/goal resume`. **Resume goal** and **Work on the goal** start the agent in a new chat.
**Mark goal done** closes a goal you're happy with.

Every file the agent changed has to be tied to a "done when" line or called extra. Only
your words change the goal: the agent has to quote your latest message to change it, and if
it rewrites Guardian's goal file, the file is put back. One exception: when your goal has no
"done when" lines at all, the agent may write them; once there are any, it can't add more.

**What it costs.** Each send-back is an agent turn on your Cursor plan. A review is one
more agent call for the reviewer, about five short ones for the evaluator, and one more
when the evaluator alone objects. On Linux, the moment the agent stops and is sent back
takes about 0.55 seconds of Guardian's own time, and a message of yours about 0.16. The
download is 171 MB and unpacks to 440 MB.

**What it can't do.**
- It never blocks. The agent can stop anyway.
- It can't tell whether a command really tests what the agent says; the reviewer is the
  check on that.
- It doesn't defend its own files: an agent that tampers with Guardian's records under
  `.cursor/goal-guardian` can end up "proved".
- It does nothing when a turn changes nothing, and it doesn't see changes made only by
  commands in ignored paths. Outside git, the reviewer doesn't run, so nothing ends proved.
- It doesn't run in headless runs of the command-line agent, where Cursor fires no stop
  hook, or in Cmd+K, Ask or Plan mode. Cursor only runs project hooks in a trusted
  workspace.
- It has been measured only on a test rig with a stand-in model, not on a real Cursor
  model, and the current version has been built and run on Linux x64 only. The repository's
  README has the numbers and their limits.

### Safety rails

- **Never blocks.** Every check answers "allow."
- **Quiet while the agent works.** Guardian records and says nothing. It speaks when the
  agent stops, about the goal.
- **Few popups.** A notice on connecting that points you to Cursor's MCP settings, a
  confirmation before "Remove from Workspace", and one migration notice.
- **Leaves no trace.** "Remove from Workspace" deletes everything Guardian created: files,
  hook wiring, skills, the rule.

## How it works

1. **One answer to "what is the goal?"** The hooks, the panel and the agent all read the
   same file. Your own words change it; the agent writes "done when" lines only when the
   goal has none.
2. **It comes back with every message.** A new chat or a compacted one still has the goal
   in front of it.
3. **The agent is sent back.** When it stops with the goal not accepted, Cursor's stop
   hook returns a message that puts it back to work, up to 20 times per message of yours.
4. **A record of what happened.** Every shell command with its output and every edit is
   recorded in your workspace, excluded from git, along with your last 3 messages.

## Reference

**Files** (created by Connect, removed by uninstall):

```
.cursor/goal-guardian/
  contract.json      # the goal and "done when" list
  config.json        # settings version
  telemetry/         # the record of commands, edits and outcomes (gitignored)
.cursor/rules/goal-guardian.mdc      # teaches the agent the protocol
.cursor/skills/guardian*/            # /guardian and /guardian-goal
```

**Agent tools**: `get_goal`, `create_goal`, `update_goal`, `goal_command`,
`guardian_change_goal`.

**Settings**: `goalGuardian.statusBar.enabled`.

## Upgrading from 0.4.x

Automatic on first activation: files backed up as `*.v1.bak`, one passive notice. The old
permit system and task board are retired; your goal carries over.

## Credits

Guardian runs other people's code beside its own, as they wrote it; see `NOTICE` for what
runs and what is adapted.

- [OpenAI Codex](https://github.com/openai/codex)'s goal package (Apache-2.0) and
  [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)'s goal packages (MIT)
  each hold a copy of the goal, can refuse a change, and supply most of the instructions
  the agent is sent.
- The evaluator is [Google's Agent Development Kit](https://github.com/google/adk-python)
  (Apache-2.0).
- The reviewer's prompt is retuned with [RRSI](https://github.com/google-research/rrsi) by
  Google Research (Apache-2.0).
