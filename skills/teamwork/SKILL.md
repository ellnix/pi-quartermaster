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

- `add_member` draws one new member into the live team (an agent or
  variant name; the task may be omitted to add it armed). Use it when
  scope grows, a specialist is needed, or a variant should race. It
  takes an optional `mailboxes` list for the new member's channels;
  members already running are not told about them, so message them.
  A failed draw leaves the team untouched. Channels are managed
  separately: `open_mailbox` wires a template between two live members
  and `close_mailbox` shuts a channel (an abused or finished one); a
  closed channel keeps its log and `open_mailbox` can revive it. Members
  are not told when channels change, so message them.
- `remove_member` retires a member whose part is done, who is stuck, or
  who lost a race. It refuses while the member works or has pending
  asks; `force: true` interrupts and denies the asks. Channels close,
  logs and reports stay readable. **Rate before or after removing**:
  `rate_member` still works on a removed member, but an unrated removal
  loses its evidence.
- Prefer these over dissolve and reconvene, which re-draws everyone.
  A removed name stays in the record; add a variant with another name.

## Convening

1. `team_list` first — see who exists and what each is for.
2. Agents carry their reusable specs. Override a member's spec only when
   the task genuinely differs from its definition — build the override
   on the fly (weights, temperature, filters), don't invent named specs.
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
5. Escalations: auth, tenant-scoping, or money-adjacent diffs → the
   security reviewer at frontier settings; spec-bearing changes → the
   business-logic reviewer reading the task text against the diff;
   view/CSS changes → the designer with screenshots.

## Worked examples

All of these features exist today: armed convene (empty `task`),
one template wired to many pairings, and `add_member` / `open_mailbox`
mid-flight. Agent files are authored per [agent-files.md](agent-files.md).
Arguments are real `convene_team` shapes; adapt the task text.

### 1. One member, the minimum viable convene

```json
{ "members": [{ "agent": "builder", "task":
  "Branch `fix/invoice-rounding` (already checked out). In app/services/invoice_total.rb, round line totals half-even to 2 places before summing; today the sum is rounded once at the end (see the failing spec spec/services/invoice_total_spec.rb:41). Do not touch app/models. Commit as `fix: round invoice lines half-even` (one commit). Run `bundle exec rspec spec/services` and make it pass. Done = that suite green and a report with the diff summary. If the spec contradicts the code in a way you cannot resolve, report blocked instead of guessing." }] }
```

Why each part: the **branch** and the **file** are what a member cannot
guess; a **boundary** ("do not touch ...") stops scope creep; the
**commit convention** and **test command** spare a round trip;
**done = ...** is what you rate against. A task that cannot name these
is not ready: ask the user or the scout first.

### 2. A pair: builder and reviewer

```json
{ "members": [
    { "agent": "builder",  "task": "<complete build task, as in example 1>" },
    { "agent": "reviewer", "task": "Review the builder's work on `fix/invoice-rounding`. First write your risk list (what could go wrong with half-even rounding on this code path: negative lines, zero quantity, currency with no minor units). Then review the diff against it once the builder reports. Send findings to the builder on your mailbox; do not wait for me to relay." } ],
  "mailboxes": [
    { "name": "builder-to-reviewer", "from": "builder",  "to": "reviewer" },
    { "name": "reviewer-to-builder", "from": "reviewer", "to": "builder" } ] }
```

The loop that makes the pair cheaper than two independent reviews: the
reviewer writes findings straight to the builder on
`reviewer-to-builder`; the builder replies with fixes or questions on
`builder-to-reviewer`; you only read the log and the final reports.
Without the second mailbox findings never reach the person who must fix
them.

### 3. A trio with a scout (scout-first)

The pattern proven live: **convene everyone at once, let the scout dig
while you ask the user the decision questions, then compose the
builder's real task from the map and the answers.**

```json
{ "members": [
    { "agent": "scout",    "task": "Map how invoice totals are computed: entry points, every place a line total or the sum is rounded, the specs that cover it. Report exact paths with line numbers and facts only; no proposals." },
    { "agent": "builder" },
    { "agent": "reviewer" } ],
  "mailboxes": [
    { "name": "builder-to-reviewer", "from": "builder",  "to": "reviewer" },
    { "name": "reviewer-to-builder", "from": "reviewer", "to": "builder" },
    { "name": "request-scouting",    "from": "builder",  "to": "scout" },
    { "name": "request-scouting",    "from": "reviewer", "to": "scout" },
    { "name": "scout-to-builder",    "from": "scout",    "to": "builder" },
    { "name": "scout-to-reviewer",   "from": "scout",    "to": "reviewer" } ] }
```

Builder and reviewer have no task: they convene **armed** (idle, not
started, no tokens), so there is no "stand by" warmup. One template
(`request-scouting`) backs both asks to the scout. Then, in order:

1. While the scout digs, ask the user the questions that change the
   design (rounding mode, back-compat for stored totals). Do not read
   the codebase yourself.
2. When the scout reports, `message_member` the **reviewer** first: the
   map is its risk-list input. It starts on that message.
3. Compose the builder's task from the scout's map (cite paths and line
   numbers) plus the user's answers, in the shape of example 1, and send
   it with `message_member`. That starts the builder.
4. Rate scout, builder and reviewer when they return.

The two rules: **ask the scout instead of grepping the repo yourself**
(the biggest context saver you have), and **ask the user the decision
questions while the scout digs**, never after it finishes.

### 4. Specialists

Add each when the work needs it; do not convene them by default.

```json
{ "agent": "designer", "task": "Compare the attached screenshots against the mockup; list concrete discrepancies." }
```
`designer` carries `filters.require: [image, text]`, so the draw only
considers vision models. Use it when a diff touches what the user sees.

```json
{ "agent": "researcher", "task": "Which of gem A or B supports half-even rounding with BigDecimal on Ruby 3.3? Cite sources; say what you verified." }
```
Research is outside the repo: a `researcher` (with the `request-research`
mailbox), not the scout's read-only dig.

```json
{ "agent": "reviewer-frontier", "spec": { "weights": { "review": 1.0 }, "filters": { "minScores": { "review": 0.85 } } }, "task": "..." }
```
For auth, tenant-scoping or money-adjacent diffs: a score floor
(`minScores`) is a requirement; a higher weight is only a tilt. A spec
override here is for this deployment only; make it permanent in the file.
Mid-flight: `add_member` with the same arguments, then `open_mailbox` to
wire it in.

## Anti-patterns

| Don't | Because |
|---|---|
| Convene before the spec exists | Members improvise, or you spend a run on a warmup; convene armed and start when ready |
| Task: "explore the repo and work out how to do X" | You pay a builder for what a scout maps cheaper |
| Research the codebase in your own context | Context flood and shallower coverage than a dedicated dig |
| Convene a pair with no mailboxes | Findings never reach whoever must fix them |
| Skip the ratings | Evidence is lost and the next draw is uninformed (see Ratings) |
| Dissolve and reconvene to add one specialist | Every draw is lost; use `add_member` |

## While the team works

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
- **Steering**: `message_member` with `steer: true` interrupts a running
  member with your message; without it the message queues as a
  follow-up. Steer for corrections; follow-up for additions.
- **Permission asks**: `pending_asks` shows each ask with its policy
  classification. Auto-approvable categories you may resolve alone.
  Escalate-only categories require the user's confirmation quoted in
  `userConfirmed` — ask the user, then resolve with their words. Deny
  freely when the ask is off-task.
- A member that errors or times out is a fact to report to the user,
  not something to paper over.

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
