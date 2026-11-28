# Changelog

## [Unreleased]
### Added
- A run that stops on an unrecoverable error now changes the member's
  status to `error` and files an engine report (`status: "error"`) with
  the message, so the wake digest notifies the quartermaster instead of
  the member quietly going idle. `team_list` shows the state and the
  note; the quartermaster can wake the member with `message_member`
  (a good run returns it to `idle`), `remove_member`, or do nothing.
  Aborted runs and tool errors the agent recovered from are not errors.
  The fleet follows the session's own run events (`agent_start`,
  `message_end`, `agent_settled`) and reads the run's last assistant
  message: `prompt()` resolves without starting a run when it is queued
  into a busy session or deferred while one settles, so its promise is
  not the signal, and compaction cannot move an event.
  Errors have their own wake switch (`wake.errors`, default immediate),
  independent of `wake.reports`, and arrive in their own digest section.
  Messages queued while a member was working are delivered ahead of the
  next wake-up message, in the order they were sent, and a message that
  arrives while a run is still being prepared is queued behind it instead
  of racing the session into refusing it (every dispatched prompt carries
  a `streamingBehavior`, so the session queues a surprise instead of
  throwing it away).
- A convene member or `add_member` can name an explicit `model` (a
  physical `provider/model-id`). It pins that model for the deployment:
  the spec draw is skipped, and it wins over the agent file's own
  `model` pin. Precedence is explicit choice, then agent pin, then draw.
  The id is checked against the catalog and configured auth, and a bad
  one fails that member instead of quietly falling back to a draw.
  `team_list` marks the member `(explicit)` and the composition record
  keeps how each model was resolved. An empty `model` is refused instead
  of quietly falling through to the pin or the draw, and a chosen model
  that bypasses a spec's filters is flagged at convene — a capability gap
  it actually has ("lacks image input that the spec requires") and the
  score or cost floors that were not applied. The choice still wins, but
  you hear what it skipped.

- A crewman's mailbox `send` can steer: `send { steer: true }` joins the
  recipient's run in flight — delivered at its next model call, held while
  the run is prepared, starting a run if the member is idle — while the
  default still waits until the recipient is idle. A run window takes at
  most three steers; further ones queue as follow-ups. Across runs a
  steered exchange is still bounded only by the runs themselves — every
  reply costs a run, as any follow-up would. The traffic log records which
  sends were steers, the recipient's framing says when a message is
  steering (and not when the budget queued it), and the sender's receipt
  says what the engine actually did (started, steered, held, queued). The
  receipt reflects that decision at send time: a prompt an extension or
  input hook consumes before it runs does not update it.

### Changed
- Ratings are banded, and the quartermaster is held to the bands:
  `[0, 0.4)` less than competent, `[0.4, 0.6)` satisfactory (the task to
  the letter), `[0.6, 0.8)` beyond the task, `[0.8, 1]` outstanding
  (half-open: 0.6 is already "beyond the task"). A competent run that did
  only what it was told is around 0.5; 0.8 and above means the work would
  be significantly worse without a unique, non-obvious contribution, and
  `rate_member` refuses such a rating with no `note` naming it.
  The standard is defined once in `src/matching/rating.ts`, the
  `rate_member` tool renders its bands from that table, and the teamwork
  skill, ARCHITECTURE and README restate the same bands. The
  acknowledgement names the band. This makes ratings comparable and the
  top band costly; it does not by itself stop upward drift, which still
  rests on the quartermaster rating against the band instead of against
  the member's peers.

### Fixed
- Steering no longer errors with the SDK's "Agent is already processing"
  refusal. A steer to a member whose run is in flight is queued into that
  run's steering queue and delivered at its next model call; a steer that
  arrives while the run is still being prepared is held in the engine's
  queue and injected as the run starts (so a refused or abandoned run
  counts it as undelivered); a steer to an idle member starts a run.
  Follow-ups keep their own queue, delivered after the run settles, and a
  steer never absorbs them.
- A failed `add_member` lost the reason along with the member: the team
  was left unchanged, but the note vanished with the dropped crewman.
  The rejection reason now rides on the result's warnings, so a spec-less
  agent or an unusable model id says why it was not added.
- `rate_member` on a member whose agent names no spec reported success
  while writing nothing: there were no dimensions to update. It now
  refuses and says why, instead of reporting evidence that never landed.
  A bare model pin, or an explicit model without a spec, has nowhere to
  be rated.
- `rate_member` also refuses a member that never resolved a usable model
  (a failed convene, a bad explicit model): rating it wrote evidence
  against a model id that may not exist. The rating resolver carries the
  member's state, and the engine refuses with the member's own note. A
  member whose *run* stopped on an error is a real outcome and stays
  ratable; only one that never started is refused.
- A member that failed during convene no longer counts as an active
  channel endpoint. A mailbox wired to or from it does not open, and the
  convene warnings say the channel will not open instead of leaving the
  rest of the team pointed at an endpoint that can never receive.

## [0.3.0]
### Added
- One agent definition can be launched several times under different names:
  `convene_team` members and `add_member` take an optional `name`
  (`builder` as `builder-a` and `builder-b`). Each is its own member with
  its own draw, worktree, channels and rating; `team_list` shows
  `builder-a (from builder)`. Per-launch stance comes from the convene's
  `spec` override.

### Fixed
- A member that asks a question can now be answered: every send tells the
  sender whether the recipient has a mailbox back, and names it, so a
  member with no way back stops waiting instead of hanging. The `send`
  tool description says replies arrive as later messages and cannot be
  polled.
- Channel changes reach the members they affect. Opening or closing a
  mailbox (and the `mailboxes` of `add_member`) queues a short notice for
  both ends, delivered ahead of their next message; a not-yet-started
  member learns the current channels from its standing instructions.
  Previously running members never learned a channel existed.
- `team_list` "unread reports" counted every report ever written. It now
  counts only reports newer than your last `read_channel "reports"`.
- Identical warnings (for example the unrated-candidates note, once per
  drawn member) are reported once.
- Wake digests name the team they came from and how old each report is,
  so one that arrives late (after a long turn, or after a dissolve) cannot
  be mistaken for news from the running team.
- The `worktrees` listing no longer fails when a tree is removed while it is
  being listed.
- `team_list` with no team shows each agent's `worktree` setting.
- Provisioning is gated on project trust: when pi does not trust the
  project, the `setup` and `copy` in its `.pi/team/worktrees.jsonc` are
  skipped (members still get their own tree, bare, and the convene result
  says why). `setup` is shell from the repository, and pi gates project
  config on trust for the same reason.

### Changed
- Ratings now refine your scores instead of replacing them. A `models.yaml`
  score (or override) is a beta prior worth `k` pseudo-trials
  (`matching.priorStrength` in `authority.jsonc`, default 6; per-model
  `prior_strength` in `models.yaml`). One strong rating can no longer drop a
  model below its prior or flatten models with different priors; the prior
  fades as evidence accrues. Dimensions you never scored keep the old
  Beta(1,1) start. Existing `evidence.json` needs no migration: counts are
  re-anchored when read, so editing a score or `k` takes effect on the next
  draw. `priorStrength: 1` is the closest to the old behaviour. `minScores`
  gates are unchanged.
- Crewmen are told what their mailboxes are for: they are sanctioned by the
  Quartermaster, using them lightens its load, and the recipient already
  knows the sender, so no introductions are needed. The statement appears
  in the member's standing instructions (whenever it has an outbound
  channel) and in the `send` tool description.

### Added
- Per-member git worktrees. A member that can write (`edit`/`write` in its
  tools) now works in its own worktree on its own branch,
  `quartermaster/<team>/<member>`, started from `HEAD` (or the configured
  base), so one member's blunt command can no longer touch your tree or
  another member's. The session's cwd is the tree. Read-only members share
  your tree as before. Agent frontmatter `worktree: shared | per-member |
  attach` and the convene / `add_member` fields `worktree` and `attachTo`
  override this; `attach` places a read-only member in another member's
  tree. The primary tree's HEAD, index and branch are never touched,
  members are told never to push, and reports carry the branch and path.
  Racing two builders now gives two branches and a real diff.
- `.pi/team/worktrees.jsonc` declares provisioning once: `base`, `setup`
  commands (run once per tree, in it, with a timeout), `copy` of exact
  untracked files from your tree (`.env`), `keepOnDissolve`, `location`
  (`tmp`, or `repo` under `.quartermaster/`), and `default`. A failed copy
  or setup removes the worktree and fails that member's spawn, naming the
  cause; no half-provisioned trees. With no config the tree is created bare
  and the member is told so.
- Lifecycle: trees persist while a member is idle, and are removed with the
  member or at dissolve unless dirty (uncommitted work is kept and reported)
  or `keepOnDissolve`; a branch with commits is never deleted. A new
  `worktrees` tool lists every quartermaster tree of the repository (team,
  branch, clean or dirty, commits ahead, live or unclaimed) and prunes
  unclaimed ones, which works with no team convened. Outside a git
  repository members fall back to your tree with a loud warning.
- `team_list` with no team convened now lists the configured agents
  (description, tools, spec) and mailbox templates (description), so a convene
  is planned from what the user actually has.
- teamwork skill: worked examples (single member, implementer+reviewer pair,
  exploration-first trio, specialists), written with placeholder roles, real `convene_team` arguments and the
  anti-patterns each avoids, plus `skills/teamwork/agent-files.md`, a
  field-by-field agent file reference with a prompt-body skeleton.
- `open_mailbox` and `close_mailbox`: manage channels on a live team,
  separately from `add_member`. Closing is the quartermaster's first admin
  lever: delivery stops at once, the log is kept, and `open_mailbox`
  revives the same channel. Both are recorded in `composition.jsonl`.
- `add_member` and `remove_member`: change a live team without dissolving.
  Adding draws one member under the usual gates (a failed draw leaves the
  team unchanged), with an optional task (omit to add armed) and optional
  `mailboxes`. Removing refuses while the member is working or has
  pending asks; `force` interrupts it and denies the asks with a recorded
  note. Removed members keep their place in the record (`team_list` shows
  added/removed markers), their channels close with logs preserved, and
  `rate_member` still works for them. Composition history is appended to
  `composition.jsonl`. Later members' spawn prompts list the current team.
- One mailbox template can back many wirings. A template wired once keeps
  its channel name and log; wired more than once, each pairing gets
  channel `<template>__<from>--<to>` with an isolated log. `read_channel`
  accepts the template name (all wirings), the channel id, or `from--to`.
  Wiring the same template with identical endpoints twice now fails convene.
- `convene_team` member `task` is optional. With no task (omitted or `""`) a
  member convenes armed: model drawn, channels open, no session run and no
  tokens. `team_list` shows it as `idle (not started)`. The first
  `message_member` (or channel delivery) starts it and is its first input;
  `steer` on a never-started member behaves like a normal message. A
  whitespace-only task fails convene with a clear error.

## [0.2.0]
### Fixed
- The spend whitelist is a whitelist again. A model with no entry — or an
  entry that only names a cost — could draw for a spec that did not set
  `allowUnrated`, and did so on evidence left behind by earlier runs.
  Ratings (evidence) now only refine models you actually listed: an entry
  with `scores` in `models.yaml`, or a score override, is what makes a
  model rated. A cost-only model stays unrated, evidence on an unlisted
  model is inert until you list it, and `allowUnrated` still gambles on
  unknowns exactly as before. If you were relying on a model that had
  drifted into draws through evidence, either score it in `models.yaml`
  or set `allowUnrated` on the specs that may scout it.
- The empty-rated-pool error now says why: "no scores in models.yaml or
  overrides; evidence refines, it never admits".

### Added
- Cost always factors into draws: every suitability loses
  `costLambda * (1 - costScore)` before the softmax, with `costLambda`
  defaulting to 0.15, so a spec that forgets cost cannot be cost-blind.
  A model's total cost influence is its spec cost weight's term plus this
  fixed penalty. It is a penalty, not a gate — models that share a cost
  score keep their exact relative odds at any lambda, and equal-quality
  models no longer tie when one is cheaper. The knob lives in
  `authority.jsonc` (`matching.costLambda`; 0 restores the pre-0.2.0
  distribution). There is no per-spec opt-out; frontier stances belong in
  `minScores`.
- `minScores` spec filter: `filters: { minScores: { "reviewing-code": 0.75 } }`
  excludes candidates below the bar before the draw — a requirement
  rather than a weight tilt, so it reads the deterministic score stack
  (override, then `models.yaml`, then the evidence mean) and never the
  Thompson sample. A candidate with no score at all on a gated dimension
  fails the gate, and the run reports how many were excluded that way.
  An emptied pool errors naming the gate and its threshold. `minScores`
  rejects the `cost` key with a pointer to `minCostScore`.
- `scripts/verify-math.ts` asserts the cost penalty's arithmetic and
  `scripts/smoke-matcher.ts` asserts every acceptance case of both
  changes (unlisted-model admission, cost-only models, score floors,
  lambda 0, equal-cost odds).
- **The quartermaster is no longer pull-only.** Peer sessions no longer
  die unread: a report or a permission ask landing in the active team's
  record wakes the quartermaster on its own, with no user ping. A wake is
  a short digest — report ids, member, status and one summary line; ask
  id, member and the requested action, pointing at `pending_asks` /
  `resolve_ask` — never the payload: the record stays the blackboard and
  `read_channel` still holds the detail. A debounce window (default 2s)
  merges a burst into one notice. Mailbox traffic between members never
  wakes anything; `channels/*.jsonl` is not watched at all. Wakes arrive
  as follow-ups, so a running turn is never steered, and they never
  impersonate the user. Directory events are best-effort: a null filename
  drains anyway and a 30-second sweep drains unconditionally, so a missed
  event delays a notice instead of stranding an ask. The `wake` section of
  `authority.jsonc` switches `reports` and `asks` between `"immediate"` and
  `"off"` (both off is exactly the old pull-only behavior) and sets
  `debounceMs`.
- `scripts/smoke-wake.ts` drives the watcher against a fixture record:
  burst coalescing, digest content, channel traffic staying silent, the
  follow-up delivery shape, policy off, retargeting, sweep idempotence, and
  a loud report of unreadable record lines.

### Known boundaries and issues
- A project `models.yaml` entry replaces the user entry of the same name
  wholesale, so a project entry carrying only `cost:` also drops the
  user's `scores`. Under the new whitelist that entry no longer exists as
  far as rating is concerned, so the model drops out of non-`allowUnrated`
  draws entirely. Write project entries complete, or leave them to the user
  file.
- A gated dimension with no score anywhere excludes the candidate
  (absence is not a rating). The draw notes how many were excluded that
  way, but a model with no scores at all cannot satisfy a `minScores`
  spec — list it in `models.yaml` first.

## [0.1.1]
### Fixed
- Project configuration discovery stops at the git repository root. A
  repository without a `.pi` directory no longer walks up past its own
  root and mistakes the global agent directory for project configuration.
  `.git` counts as a directory or a file, so worktrees and submodules are
  roots too — see the boundaries note below.
- `require` in `models.yaml` is now enforced, as a veto rather than a
  claim. When an entry declares the input modalities it accepts, the
  effective input for a spec's capability filter is the model catalog's
  list intersected with the entry's: the file can remove a modality the
  catalog advertises, never add one the catalog omits. A malformed list
  (a scalar, an empty list, non-string entries) warns and is ignored,
  leaving the catalog input in force. Previously the field was loaded
  and ignored.
- Configuration warnings report why frontmatter failed to parse — the
  YAML parser's own reason (for example an indentation error with its
  line and column, or a missing closing fence) instead of a blanket
  "no frontmatter at line 1".

### Known boundaries and issues
- The discovery walk stops at a `.git` marker, so a worktree or submodule
  is its own configuration root: a superproject's `.pi` does not apply
  inside a submodule. A directory tree with no repository anywhere still
  walks to the filesystem root, so a session started in a non-repo
  directory under `$HOME` can still reach `~/.pi`.
- A project `models.yaml` entry replaces the user entry of the same name
  wholesale, so a project entry carrying only `cost:` also drops the
  user's `scores` and `require`. Pre-existing behaviour, unchanged here.

## [0.1.0]
### Added
- Engine scaffold: the full quartermaster tool surface, inert until configured.
- Configuration model and discovery, consolidated under pi's agent
  directory (relocated wholesale by PI_CODING_AGENT_DIR): agents and
  mailbox templates as markdown, models.yaml, authority.jsonc —
  validated with loud warnings, never throws on one bad file. No specs
  file: specs are inline in agent frontmatter or built on the fly.
- Matcher and evidence store: filter then softmax draw, Thompson
  posteriors from outcome-shaped ratings, machine-owned overrides.yaml
  for durable facts with provenance, unrated models excluded unless a
  spec scouts them.
- Fleet lifecycle: in-process child sessions through the pi SDK, one
  model drawn per convening, constitutional introduction assembled in
  code, the record as blackboard.
- Mailboxes and reports: preamble templates without endpoints — the
  convene wiring is the single authority, with ${from}/${to}
  substitution at delivery — busy-recipient queues, JSONL traffic
  logs, message_member with mid-run steering, tracking numbers on
  reports (r1, r2, ...) and messages (m1, m2, ...), everything
  readable on demand.
- Permissions: pre-approved tools, ask-the-quartermaster with a
  file-mediated wait, escalate-only categories that demand the user's
  confirmation, unresolved asks time out denied.
- Skills: team-setup (first-run configuration by interview) and
  teamwork (the quartermaster's standing orders, rate at return-time).
- refresh-scores.cjs: suggested cost priors from public catalog data;
  never writes your files.
