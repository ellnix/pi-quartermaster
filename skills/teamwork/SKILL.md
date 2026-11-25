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
