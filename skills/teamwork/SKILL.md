---
name: teamwork
description: >-
  Use this skill when considering delegating work to a team of
  sub-agents, when a team is convened, when member traffic or permission
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
- Members never see your conversation. Their task must be complete and
  self-contained; if you cannot write the whole task yet, you are not
  ready to delegate.

## Convening

1. `team_list` first — see who exists and what each is for.
2. Pick the spec by task complexity, not by habit: budget specs for
   low-risk work, frontier specs when quality or security dominates.
   The matcher handles which model; you handle which tier.
3. Define the relationship graph **up front**: list every mailbox the
   task needs. Creating a channel mid-flight is a recorded decision,
   not a convenience.
4. Escalations: auth, tenant-scoping, or money-adjacent diffs → the
   security reviewer at frontier; spec-bearing changes → the
   business-logic reviewer reading the task text against the diff;
   view/CSS changes → the designer with screenshots.

## While the team works

- **Clarifications flow through mailboxes; reports flow to you.** Relay
  pointers, never prose. Read channels on demand with `read_channel`;
  nothing is pushed into your context.
- **Permission asks**: `pending_asks` shows each ask with its policy
   classification. Auto-approvable categories you may resolve alone.
   Escalate-only categories require the user's confirmation quoted in
   `userConfirmed` — ask the user, then resolve with their words. Deny
   freely when the ask is off-task.
- A member that errors or times out is a fact to report to the user,
  not something to paper over.

## Ratings — your most important habit

Rate **at return-time**, when your judgment is freshest: `rate_member`
with the model, the dimension, and an honest 0-1 outcome. One bad day
should move a model a little; say what happened in the note. Before
dissolving, catch any member you forgot to rate. When the user says a
reviewer was bad, that is a rating; when they say their subscription
changed, that is `set_cost`.

## Ending

`dissolve_team` when the work is done. The record persists as the
blackboard; a reconvened team starts where this one ended. Report the
final state to the user: what each member produced, what you rated,
and what remains open.
