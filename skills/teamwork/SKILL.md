---
name: teamwork
description: >-
  Use this skill when deciding whether non-trivial work warrants a team
  of sub-agents — multi-file changes, exploration that would flood your
  context, reviews needing fresh eyes, or parallelizable spec-complete
  tasks. Also when a team is convened, when member traffic or permission
  asks arrive, or when the user asks about the team.
---

# Teamwork

Standing orders for the quartermaster.

## When to convene

- **Trivial work you do yourself.** Delegation costs a spawn and a
  context; one-file edits and quick questions are cheaper done directly.
- **Non-trivial or role-shaped work gets the team**: exploration that
  would flood your context with file debris, reviews that need fresh
  eyes, parallelizable spec-complete tasks.
- Members never see your conversation. Write each task complete enough
  to start from — then guide step by step with `message_member`, which
  can steer a running member mid-flight.

## Changing the team mid-flight

- `add_member` draws one new member into the live team (an agent name,
  optionally launched under another `name`; the task may be omitted to
  add it armed). Use it when scope grows, a specialist is needed, or a
  second copy of an agent should race. It
  takes an optional `mailboxes` list for the new member's channels;
  members already running hear of them at their next message.
  A failed draw leaves the team untouched. Channels are managed
  separately: `open_mailbox` wires a template between two live members
  and `close_mailbox` shuts a channel (an abused or finished one); a
  closed channel keeps its log and `open_mailbox` can revive it. Members
  are told at their next message; a member that has not started learns
  from its standing instructions.
- `remove_member` retires a member whose part is done, who is stuck, or
  who lost a race. It refuses while the member works or has pending
  asks; `force: true` interrupts and denies the asks. Channels close,
  logs and reports stay readable. **Rate before or after removing**:
  `rate_member` still works on a removed member, but an unrated removal
  loses its evidence.
- Prefer these over dissolve and reconvene, which re-draws everyone.
  A removed name stays in the record; launch the agent again under another `name`.

## Convening

1. `team_list` first. With no team it lists the user's configured agents
   (description, tools, spec) and mailbox templates (description). Read
   them and plan the team from what exists: the roles, names and
   relationships differ per user, and nothing here assumes yours.
2. Agents carry their reusable specs. Override a member's spec only when
   the task genuinely differs from its definition — build the override
   on the fly (weights, temperature, filters), don't invent named specs.
   When the user names a model, pass it as that member's `model`: it is a
   choice, not a draw — it skips the spec's filters and wins over the
   agent file's pin, which is exactly what is wanted for an experiment,
   and wrong when the spec exists to keep a member inside a pool.
3. Declare the channel wiring up front: every mailbox with its
   endpoints. The wiring is the single authority for who talks to whom;
   creating a channel mid-flight is a recorded decision, not a
   convenience.
4. **Armed convene.** The draws are the scarce, one-shot thing; tasks are
   cheap to send later. Omit `task` (or pass `""`) to convene a member
   idle and not started: model drawn, channels open, no run and no
   tokens. `team_list` shows it as `idle (not started)`. Its first
   `message_member` starts it, and that message is its first input, so
   write it as a complete task. Use this to draw the whole roster early
   and start each member when its spec is ready, instead of spending a
   warmup turn on "stand by" acknowledgments. Do not wait for reports
   from members you have not started.
5. Escalations, where the configuration has the agents for them: auth,
   tenant-scoping, or money-adjacent diffs → the strongest reviewer
   available (see example 4); spec-bearing changes → a reviewer reading
   the task text against the diff; view/CSS changes → an agent that can
   see images, with screenshots.

## Worked examples

**Every agent and mailbox name below is a placeholder.** `<implementer>`, `<reviewer>`, `<explorer>` and `<mailbox ...>` stand for whatever the
user's own configuration defines; their setup may have different roles,
fewer of them, or none of these. Before convening, call `team_list`: with
no team it lists every configured agent (description, tools, spec) and
every mailbox template (description). **Plan from that list**: choose
agents by what their descriptions say they are for, check their tools
(an agent without `edit`/`write` cannot build), and wire only mailboxes
whose descriptions fit the relationship you need. If the list lacks a
role an example uses, do without it or ask the user; do not invent an
agent name. Authoring agents is covered in [agent-files.md](agent-files.md).

The argument shapes are real `convene_team` shapes; the roles and task
text are illustrative.

### 1. One member, the minimum viable convene

Pick the agent whose description matches the work and whose tools allow it.

```json
{ "members": [{ "agent": "<an agent that can edit>", "task":
  "Branch `fix/invoice-rounding` (already checked out). In app/services/invoice_total.rb, round line totals half-even to 2 places before summing; today the sum is rounded once at the end (see the failing spec spec/services/invoice_total_spec.rb:41). Do not touch app/models. Commit as `fix: round invoice lines half-even` (one commit). Run `bundle exec rspec spec/services` and make it pass. Done = that suite green and a report with the diff summary. If the spec contradicts the code in a way you cannot resolve, report blocked instead of guessing." }] }
```

Why each part: the **branch** and the **file** are what a member cannot
guess; a **boundary** ("do not touch ...") stops scope creep; the
**commit convention** and **test command** spare a round trip;
**done = ...** is what you rate against. A task that cannot name these
is not ready: ask the user, or an exploring member, first.

### 2. A pair: an implementer and an independent reviewer

Non-trivial code gets a second pair of eyes that did not write it. Use
whichever two agents your list offers for implementing and reviewing.

```json
{ "members": [
    { "agent": "<implementer>", "task": "<complete task, as in example 1>" },
    { "agent": "<reviewer>",    "worktree": "attach", "attachTo": "<implementer>", "task": "Review the implementer's work on `fix/invoice-rounding`. First write your risk list (what could go wrong with half-even rounding on this code path: negative lines, zero quantity, currency with no minor units). Then review the diff against it once the implementer reports. Send findings to the implementer on your mailbox; do not wait for me to relay." } ],
  "mailboxes": [
    { "name": "<mailbox for implementer -> reviewer>", "from": "<implementer>", "to": "<reviewer>" },
    { "name": "<mailbox for reviewer -> implementer>", "from": "<reviewer>",    "to": "<implementer>" } ] }
```

Attaching the reviewer to the implementer's worktree (`worktree: "attach"`) lets it review the real tree while being unable to dirty it; the reviewer's agent must grant no `edit`/`write`, and the implementer must have its own worktree, which needs a git checkout. See the "Working trees" section for how placement works.

Choose each mailbox by its description: one that lets the implementer
ask the reviewer about intent, one that lets the reviewer send findings.
If one template is written direction-neutrally (its preamble uses
`${from}`/`${to}`), it can back both directions. The loop that makes the
pair cheaper than two independent reviews: findings go straight to the
implementer, fixes and questions come straight back, and you read the
log and the final reports. With no mailbox in the reviewer's direction,
findings never reach the person who must fix them. If no suitable
mailbox exists, say so to the user rather than relaying prose yourself.

### 3. Exploration first

When the work needs the codebase mapped, **convene everyone at once, let
the exploring member dig while you ask the user the decision questions,
then compose the implementer's real task from the map and the answers.**
This needs an agent whose description is read-only exploration.

```json
{ "members": [
    { "agent": "<explorer>", "task": "Map how invoice totals are computed: entry points, every place a line total or the sum is rounded, the specs that cover it. Report exact paths with line numbers and facts only; no proposals." },
    { "agent": "<implementer>" },
    { "agent": "<reviewer>" } ],
  "mailboxes": [
    { "name": "<implementer -> reviewer>", "from": "<implementer>", "to": "<reviewer>" },
    { "name": "<reviewer -> implementer>", "from": "<reviewer>",    "to": "<implementer>" },
    { "name": "<ask the explorer>",        "from": "<implementer>", "to": "<explorer>" },
    { "name": "<ask the explorer>",        "from": "<reviewer>",    "to": "<explorer>" },
    { "name": "<explorer answers>",        "from": "<explorer>",    "to": "<implementer>" },
    { "name": "<explorer answers>",        "from": "<explorer>",    "to": "<reviewer>" } ] }
```

The implementer and reviewer have no task: they convene **armed** (idle,
not started, no tokens), so there is no "stand by" warmup. A template may
back several wirings, as `<ask the explorer>` does here; if your list has
one template per direction and pairing, wire each as its description
says. Then, in order:

1. While the explorer digs, ask the user the questions that change the
   design (rounding mode, back-compat for stored totals). Do not read
   the codebase yourself.
2. When the explorer reports, `message_member` the **reviewer** first:
   the map is its risk-list input. It starts on that message.
3. Compose the implementer's task from the map (cite paths and line
   numbers) plus the user's answers, in the shape of example 1, and send
   it with `message_member`. That starts it.
4. Rate everyone when they return.

The two rules: **ask the explorer instead of grepping the repo
yourself** (the biggest context saver you have), and **ask the user the
decision questions while it digs**, never after it finishes. If the
configuration has no read-only exploring agent, ask the user whether to
add one, or accept the cost of exploring in your own context.

### 4. Specialists

Add a specialist when the work needs one and your list has it; do not
convene them by default. Three shapes recur. Each depends on what the
agent files declare, so read the agent's `team_list` entry first:

- **Needs to see images** (UI work, screenshots): pick an agent whose
  spec requires image input (`filters.require: [image]`); the draw then
  only considers vision models. Without one, a text-only member cannot
  judge a screenshot.
- **Needs facts from outside the repo** (libraries, versions): pick an
  agent described as research, not your exploring member's read-only dig.
- **Needs the strongest review** (auth, tenant-scoping, money-adjacent
  diffs): use a reviewer agent, optionally with a spec override that sets
  a score floor. A floor is a requirement, a higher weight is only a tilt.

```json
{ "agent": "<reviewer>", "spec": { "weights": { "review": 1.0 }, "filters": { "minScores": { "review": 0.85 } } }, "task": "..." }
```

`review` here is a score dimension from the user's `models.yaml`; use the
dimensions their agents' specs already name. An override applies to this
deployment only; make it permanent in the agent file. Mid-flight: the
same arguments to `add_member`, then `open_mailbox` to wire it in.

## Anti-patterns

| Don't | Because |
|---|---|
| Convene from remembered or example names | Agents and mailboxes are the user's own; read `team_list` and use what exists |
| Convene before the spec exists | Members improvise, or you spend a run on a warmup; convene armed and start when ready |
| Task: "explore the repo and work out how to do X" | You pay an implementer for what a read-only explorer maps cheaper |
| Research the codebase in your own context | Context flood and shallower coverage than a dedicated dig |
| Convene a pair with no mailboxes | Findings never reach whoever must fix them |
| Skip the ratings | Evidence is lost and the next draw is uninformed (see Ratings) |
| Dissolve and reconvene to add one specialist | Every draw is lost; use `add_member` |

## Working trees

Members that can write (`edit`/`write` in their tools) each get their
own git worktree and branch, `quartermaster/<team>/<member>`, so nobody
overwrites anyone, including the user. Read-only members share the
user's tree.

- **Review in the builder's tree**: add the reviewer with
  `worktree: "attach"` and `attachTo: "<builder>"` (list the builder
  first). It sees the tree and cannot dirty it: attach is refused for any
  agent granted `edit` or `write`. Tell it to wait for the builder's
  report, since it sees only what is on disk.
- **Racing**: launch one builder definition twice under different names
  (`{"agent": "<builder>", "name": "builder-a"}` and `builder-b`; give each
  its own `spec` override if their draws should differ). They get two branches. When
  both report, compare branches, not trees:
  `git diff <base>...quartermaster/<team>/<a>` against `<b>`. Keep the
  winner (merge it yourself; members never push) and `remove_member` the
  loser. Branches with commits are kept, so the loser's work stays
  inspectable.
- Every report carries the member's `branch` and `worktree`; read them
  with `read_channel "reports"`.
- `worktrees` lists what exists (live or unclaimed, clean or dirty) and
  prunes the unclaimed: `worktrees {prune: true, team: "<id>"}`. List
  after a session ends; leftovers are what accumulate.
- A dirty tree is never discarded silently: it survives removal and
  dissolve, and you will see "kept ... uncommitted changes". Decide what
  to do with it; do not reach for `discardDirty` by reflex.
- Outside a git repository members share the user's tree and the
  convene result says so loudly. Do not give a write grant to a member
  you cannot isolate unless the user accepts that.

## While the team works

- **A mailbox is one-way.** A member that asks a question can only be
  answered if the other member has a mailbox back to it: wire both
  directions (a pair's two mailboxes), or `open_mailbox` the reverse. A
  sender is told on every send whether the recipient can reply; a member
  with no way back is told not to wait. Replies arrive later as messages
  (nothing to poll). Both ends hear of channels you open or close at
  their next message.
- **"Unread" reports** counts only those you have not read with
  `read_channel "reports"`; reading marks them read.
- **Clarifications flow through mailboxes; reports flow to you.** Relay
  pointers, never prose. Mailbox traffic stays on demand — read channels
  with `read_channel`; the logs are plain JSONL, so read them with your
  own tools and run any analysis you like. Reports and permission asks
  do arrive as short **wake digests** (ids, members, one-line summaries)
  so you hear about a blocked member or a finished task without a user
  ping — treat a digest as a pointer into the record, not as the report.
  A wake lands as a follow-up: never mid-turn, so you are never steered
  by it.
- **Members cite tracking numbers**: reports are `r1, r2, ...`, messages
  `m1, m2, ...`. Steer by reference — "regarding r3, do X instead" —
  rather than re-describing.
- **Steering**: `message_member` with `steer: true` joins the member's run
  in flight: the session queues it and the run delivers it before its next
  model call (usually before the first one, when the run is still being
  prepared). It never waits for the run to settle and never absorbs queued
  follow-ups. To an idle member it starts a run. Without `steer`, the
  message waits as a follow-up. Steer for corrections; follow-up for
  additions.
- **Permission asks**: `pending_asks` shows each ask with its policy
  classification. Auto-approvable categories you may resolve alone.
  Escalate-only categories require the user's confirmation quoted in
  `userConfirmed` — ask the user, then resolve with their words. Deny
  freely when the ask is off-task.
- **An unrecoverable error is a report.** A member whose run stops on an
  error flips to state `error` and files an engine report
  (`status: error`) carrying the message, so the wake digest reaches you
  without a user ping — errors wake on their own switch, independent of
  report wakes. `team_list` shows the state and the note. Treat it
  as a decision point: `message_member` to try waking it (a good run
  returns it to `idle`), `remove_member` if it is stuck, or leave it and
  tell the user. Aborted runs and errors the member recovered from are
  not reported. A member that never started cannot be rated (no
  outcome); one that ran and then errored can. Tell the user either way —
  this is a fact, not something to paper over.

## Ratings — your most important habit

Rate **at return-time**, when your judgment is freshest: `rate_member`
with the member's name and an honest 0-1 outcome — the member's spec
resolves the drawn model and its dimensions, so you never track who
runs on what. One bad day should move a model a little; say what
happened in the note. Before dissolving, rate every member — a
dissolution without ratings wastes the session's evidence. When the
user says a reviewer was bad, that is a rating; when they say their
subscription changed, that is `set_cost`.

## Ending

`dissolve_team` when the work is done. The record persists as the
blackboard; a reconvened team starts where this one ended. Report the
final state to the user: what each member produced, what you rated,
and what remains open.
