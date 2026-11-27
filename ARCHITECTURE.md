# Quartermaster — Architecture

Quartermaster is a pi package that lets one interactive pi session — the
**quartermaster** — convene, equip, and govern a team of persistent
sub-agents. The quartermaster is the orchestrator that talks to the user.
It provisions the team: which agents exist, which model each runs on, who
may talk to whom, and under what relationship. It does not command tactics
— the agents' own skills do that.

The name is the design: a quartermaster equips troops and watches the
supply lines, but does not tell the reviewer how to review.

**Status:** implemented (v0.1.0) — fleet, mailboxes, permissions,
matcher, evidence, and the two skills, built in the PR stack from
issues #1-#8. This document remains the design rationale; the README
carries day-to-day usage. Shaped by its review rounds: member-based rating, the channel
repository (convene wiring as the single authority for endpoints,
templates with ${from}/${to} substitution), message_member steering,
and tracking numbers on reports and messages.

---

## Principles

1. **Engine, not opinion.** The package ships code and two procedural
   skills — no models, no agents, no specs, no defaults. All configuration
   is user-owned. The package's audience is the agent that installs it,
   so it owes that agent legibility: documented schemas, informative empty
   states, validation feedback.
2. **Judgment is split by kind.** The quartermaster (an LLM, in context,
   seeing the task) makes qualitative choices: which agent, which spec,
   which relationships exist. The engine makes mechanical choices:
   which physical model, by filtering on auth, capability, cost, and
   evidence. Neither layer reaches into the other's domain.
3. **Visible is not in-context.** All team traffic is logged by default.
   Mailbox traffic reaches the quartermaster's context only on demand. The
   two exceptions are reports and permission asks, which arrive as
   debounced digests — ids and one-line summaries, never payloads —
   because a blocked member and a finished task cost more to miss than to
   deliver. Panopticon by persistence, not by flooding.
4. **Repos self-describe; teams stay personal.** Spawned children run in
   the repo's cwd with project trust, so they load that repo's AGENTS.md
   and skills. A generic designer agent becomes repo-smart inside any
   checkout. Nothing about the team is committed to the repos it works in.
5. **Chaos with a floor.** Model selection is stochastic — different
   models carry different failure modes, and a lower-scored model may
   still provide insight — but selection never crosses hard filters
   (auth, capability, cost ceiling), and temperature is per-spec.
6. **One draw per session.** The model is drawn when a session is
   convened, never per message: a persistent child keeps its context and
   its prompt cache warm, and "search again" stays cheap. An explicit
   `model` on a convene member or on `add_member` replaces the draw for
   that deployment (and the agent file's pin); chaos is the default, not
   a mandate.
7. **No hidden live state.** Anything that happens mid-flight — a
   mailbox created on the fly, traffic, ratings — is persisted to the
   session record where it can be inspected. Coordination state that only
   exists in the moment is state that rots.
8. **Loud failure over silent coercion.** Unknown score dimensions warn
   at load. A spec that matches nothing falls back to the session default
   with an explanation, rather than erroring a spawn. Missing config
   reports itself.

---

## Shape

One pi package: extensions + a small library + two procedural skills.

```
pi-quartermaster/
├── extensions/
│   ├── fleet.ts        # persistent RPC children; spawn, lifecycle, wake
│   ├── mailboxes.ts    # channel definitions, routing, preamble assembly
│   ├── matcher.ts      # filter → draw; the selection policy
│   ├── db.ts           # join: pi catalog × models.yaml × evidence
│   ├── evidence.ts     # posterior store; ratings in, posteriors out
│   └── tools.ts        # the tool surface (below)
├── skills/
│   ├── team-setup/     # procedural: first-run configuration
│   └── teamwork/       # procedural: convening, routing, stewardship
├── scripts/
│   └── refresh-scores.cjs   # pull leaderboards → models.yaml suggestions
└── package.json        # pi manifest: { "extensions": [...], "skills": [...] }
```

Distribution: `pi install npm:pi-quartermaster` (or the git source).
Installs at user level (`~/.pi/agent/settings.json`), active in every repo,
no per-repo setup, no repo footprint.

---

## Configuration layers

| Layer | Location | Content | Owner |
|---|---|---|---|
| User | pi's agent dir (`getAgentDir()/team/`): `agents/*.md`, `mailboxes/*.md`, `models.yaml`, `authority.jsonc`, evidence, overrides, records | the team, the channels, the priors, the costs — one home, relocated wholesale by `PI_CODING_AGENT_DIR` | the user + their installing agent |
| Project (optional) | `.pi/agents/`, `.pi/team/` | repo-specific agent and spec overrides | the repo; may stay empty forever |
| Machine | evidence store, cost overrides | per-account reality (promotions are per-developer; effective costs cannot be shared) | each machine |

The package itself carries none of this.

---

## Team model

### Agents

Markdown files, frontmatter + body-as-system-prompt, discovered from
the agent dir (`team/agents/`, relocated by `PI_CODING_AGENT_DIR`)
and `.pi/agents/` (project, nearest ancestor within the git repository
root — when a repository root exists, the walk never reaches a `.pi`
outside it; with no repository at all it can reach the filesystem root):

```markdown
---
name: reviewer
description: Reviews a changeset against the repo's review skill. Use
  before requesting merge on non-trivial work.
tools: read, grep, bash
spec:
  weights: { reviewing-code: 1.0 }
  temperature: 0.7
  filters: { require: [text], minCostScore: 0.3 }
---
You are a code reviewer. Load the repo's code-review skill and follow it.
Sort findings by severity; be specific; report to the quartermaster.
```

`tools` is the pre-approved surface (see Permissions). The spec is
inline in the frontmatter — there is no specs file: reusable specs
live in agent definitions, and the quartermaster builds an override on
the fly at convene when a deployment genuinely differs.

### Specs

The quartermaster requests equipment; a spec says what that means: a
weight vector over score dimensions plus selection knobs. **There is no
specs file** — reusable specs are attached to agent definitions (the
frontmatter above), and an override at convene is built on the fly:

```jsonc
// inline at convene, or in an agent's frontmatter
{
  "weights": { "reviewing-code": 1.0 },
  "temperature": 0.7,
  "filters": {
    "require": ["text"],
    "minCostScore": 0.3,
    "minScores": { "reviewing-code": 0.75 }
  }
}
```

- Suitability of model *i* = (dot product of spec weights and the
  model's score vector) − λ·(1 − cost) — the cost weight's term plus the
  always-on cost penalty below.
- Selection = softmax over suitability at the spec's temperature —
  bounded chaos. τ near zero for paths where diversity is not worth the
  error rate (security review); τ high for insight-hunting roles.
- Hard filters — capability (`require`), the cost floor (`minCostScore`;
  cost is 0-1 with 1 = cheapest, so a floor is a minimum), the score
  floor (`minScores`), and auth — are crossed by nothing.
- **`minScores` is a requirement, not a tilt.** `{ "reviewing-code": 0.75 }`
  excludes every candidate below 0.75 on that dimension before the draw,
  reading the deterministic stack: overrides beat `models.yaml`, and where
  neither speaks the evidence posterior mean applies — never the Thompson
  sample, because requirements are stable and chaos lives in the draw. A
  candidate with no score anywhere on a gated dimension fails the gate
  (absence is not a rating; the run reports how many were excluded that
  way), and an emptied pool errors naming the gate and its threshold.
  Frontier stances are written this way rather than as quality tilts
  plus a cost weight.
- A spec weighting a dimension no candidate declares is reported when
  the draw runs.


### Mailboxes

Unidirectional, description-routed, nothing enforced. The reverse
direction is a wholly separate file, because the relationships are
unrelated — the builder asks, the reviewer dictates.

```markdown
# team/mailboxes/builder-to-reviewer.md
---
name: builder-to-reviewer
description: Use when the builder needs clarification mid-review — the
  scope of a finding, intent behind a change, context the diff omits.
  Not for relitigating findings.
---
THIS IS A MESSAGE FROM ${from}. BE ACCOMMODATING WHEN THEY ASK FOR
ADDITIONAL DETAILS AND CLARIFICATIONS, BUT DO NOT COMPROMISE THE
INTEGRITY OF YOUR REVIEW. REMEMBER THE NATURE OF YOUR RELATIONSHIP IS
ADVERSARIAL. THE QUARTERMASTER OBSERVES ALL TRAFFIC ON THIS CHANNEL.
```

Channel identity is the wiring, not the template file. A template wired
once keeps its own name as the channel id and its log
(`channels/<template>.jsonl`), so existing records need no migration. A
template wired more than once gets one channel per pairing, id
`<template>__<from>--<to>`, log `channels/<template>__<from>--<to>.jsonl`.
`read_channel` accepts the template name (all wirings, merged by time), a
channel id, or a `from--to` pairing. The same template wired twice with
identical endpoints fails convene.

Membership is dynamic: `add_member` / `remove_member` append `added` /
`removed` events to the record's `composition.jsonl`, carrying the resolved
model (and how it was resolved) plus the weighted dimensions so a removed member remains ratable. `open_mailbox` / `close_mailbox` change
channels the same way (`channel_opened` / `channel_closed` events); a
closed channel refuses delivery both ways, keeps its log, and reopens
under the same id. A
removed member stays in the roster as history; its channels are marked
closed (no delivery, logs kept) and its runtime session is disposed.

Workspaces: a member that can write is placed in its own `git worktree`
(`quartermaster/<team>/<member>`, from the configured base), and its
session's cwd is that path, so every tool is isolated with no change to
the tools themselves. Readers `attach` to an owner's path. Provisioning
(`copy`, `setup`) is declared once per repository in
`.pi/team/worktrees.jsonc` and run before the member starts; failure
removes the tree. The mechanics shell out to `git worktree` and let git
report its own errors. Invariants: the primary tree's HEAD, index and
branch are never touched; nothing is pushed; uncommitted work and
branches with commits are never destroyed silently.

Agent definitions are launched by name, not by file: `convene_team` and
`add_member` take an optional `name`, so one definition can be launched
any number of times as distinct crewmen. Each is its own member (own
draw, session, worktree, channels, rating), sharing the definition's
prompt, tools and spec; `definition` records the lineage. A convene's
`spec` override gives each launch its own stance.

The preamble is constitutional text: relationship framing that cannot
live in a skill (skills say *how* to review; the channel says what this
reviewer's relationship *to this builder* is). The orchestrator may
create mailboxes on the fly; a created mailbox is persisted to the
session record at creation time.

---

## Model selection

Three joined sources, one draw per convened session:

| Source | Truth it owns | Mutability |
|---|---|---|
| pi's model catalog | capabilities (`input: text/image`), context limits, reasoning, list costs | auto (pi + provider catalogs) |
| `models.yaml` (user) | score priors per dimension, effective costs, overrides | human + installing agent; provenance comments encouraged |
| evidence store (machine) | Thompson posteriors per (model, dimension) | rewritten freely by ratings |

```yaml
# ~/.pi/agent/team/models.yaml
anthropic/claude-opus-4-8:
  scores:
    writing-code: 0.72    # SWE-bench Verified percentile, 2026-11
    reviewing-code: 0.91  # hand-set prior
    design: 0.35
  cost: 0.15              # 0-1, 1 = cheapest; per-account:
                          #   promo credits through January
```

- **Filter → draw:** candidates = authenticated ∩ capability ∩ cost
  ceiling ∩ score floor; P(model) = softmax(suitability / τ); draw once
  at convening.
- **A named model is not drawn.** A convene member or `add_member` may
  carry `model` — a physical `provider/model-id` — which pins that
  member for the deployment, skipping the filters and the softmax. It
  wins over the agent file's own `model` pin; precedence is explicit
  choice → agent pin → draw. The id is still checked against the catalog
  and configured auth, and a bad one fails that member rather than
  falling back to a draw nobody asked for. Ratings still resolve to the
  chosen model through the spec's dimensions, and the composition record
  keeps how each model was resolved.
- **`models.yaml` is the spend whitelist.** A model is rated — eligible
  for a pool whose spec does not set `allowUnrated` — only when the user
  gave it score signal: an entry with `scores`, or a score override. A
  `cost`-only entry is price knowledge without a quality judgement and
  stays unrated. **Evidence refines, it never admits:** posteriors move a
  listed model's dimensions, but a model nobody listed cannot enter a
  rated pool on accumulated evidence alone. `allowUnrated` is the one
  explicit way to gamble on unknowns, and it is unchanged.
- **Cost always penalizes the draw.** Every suitability loses
  `λ·(1 − costScore)` before the softmax, with λ defaulting to 0.15 and
  applied independently of any spec cost weight: a model's total cost
  influence is the weight's cost term plus this fixed penalty, so a spec
  that never mentions cost cannot be cost-blind. The subtraction is
  additive on purpose — it cancels exactly in the odds between models of
  equal cost (their relative odds hold at any λ) and it still bites at
  temperature 0, where a multiplicative factor would only compress gaps.
  There is no per-spec opt-out; teams that want pure quality draws set
  `matching.costLambda` (0 restores the pre-0.2.0 distribution) in
  `authority.jsonc`.
- **Evidence refines the user's score; it does not replace it.** A
  `models.yaml` score (or override) is the beta prior, worth `k`
  pseudo-trials: `Beta(score·k, (1−score)·k)`, with `k` from
  `matching.priorStrength` (default 6) or the model's `prior_strength`.
  A single rating moves the estimate but cannot invert a considered
  prior, and distinct priors stay distinct after one trial each; the
  prior fades as real evidence accrues. Dimensions the user never scored
  start at Beta(1,1). Stored counts keep the Beta(1,1) baseline and the
  prior is swapped in at read time, so old evidence needs no migration.
- **Ratings are outcome-shaped.** `team rate` takes a 0–1 outcome per
  (model, dimension) and updates a posterior. One bad day moves a model
  a little; a pattern moves it a lot; temperature keeps drawing down-
  scored models occasionally — the recovery path for wrongly-down-scored
  models is built in.
- **Facts are config-shaped.** `team set-cost` / `team set-override`
  write durable truths to `overrides.yaml` — machine-owned, with
  provenance comments ("5× cheaper subscription, 2026-11"). The human-owned
  `models.yaml` is never machine-rewritten. Overrides beat any amount of
  posterior drift — the user is the veto layer.
- **Unknown models degrade, not fail:** no scores → tier "unrated" —
  selectable by cheap specs, never by frontier specs. Evidence on an
  unlisted model is inert until the user lists the model, informed by the
  record when the quartermaster reports a well-rated unknown.
- Prior data is thin for non-code dimensions (design, research). That
  is acceptable because the sampling architecture tolerates wrong
  priors — exploration corrects them. The refresh script suggests
  priors from public leaderboards; it never rewrites `models.yaml`.

---

## Communications

**Star for reports, mailboxes for clarifications.**

- Outcome-relevant material flows to the quartermaster: task reports,
  permission asks, digests on request. This keeps the ratings loop fed.
  An **unrecoverable run error** is outcome-relevant too: `AgentSession`
  `prompt()` resolves even when a run stops on an error (pi records the
  failure as the run's last assistant message — `stopReason: "error"`
  plus `errorMessage`), and it also resolves without starting a run at
  all when the input is queued into a busy session or deferred while one
  settles. So the fleet follows the session's own events — `agent_start`,
  `message_end`, `agent_settled` — and reads the run's last assistant
  message, which compaction cannot move out from under it. On an error it
  flips the member to `error` and appends an engine report with status
  `error` and the message. That is the notification: the ordinary wake
  path carries it, `team_list` shows the state and note, and the
  quartermaster can wake the member with a message, remove it, or do
  nothing. Aborted runs (removal, dissolve) and tool errors the agent
  recovered from are not reported. A spawn or session-start failure files
  no report: it never ran, and the convene or add_member result already
  says so synchronously.
- Clarification traffic flows through sanctioned mailboxes: prose
  between agents, off the quartermaster's context bus.

**Wake mechanics** — implemented in `src/fleet/wake.ts`, all pi primitives:

- The extension watches **only** the active team record's `reports.jsonl`
  and `asks.jsonl`. `channels/*.jsonl` is never watched and never wakes
  anything: inter-agent prose is the members' business, read on demand.
- A wake is a **digest**, never a payload: a report contributes its id,
  member, status and one summary line; an ask contributes its id, member
  and the requested action, plus pointers to `pending_asks` /
  `resolve_ask` and `read_channel "reports"`. The record stays the
  blackboard. Engine-filed `error` reports get their own `ERRORS` section
  with the three ways out (wake, remove, leave), so a stopped member is
  not buried in routine progress.
- Delivery is a custom message (`customType: "quartermaster-wake"`, with
  a registered TUI renderer) sent with `triggerTurn: true` and
  `deliverAs: "followUp"`: it starts a turn when the quartermaster is
  idle and queues after the current run when it is not — it never steers
  a running turn. `pi.sendUserMessage` is deliberately not used: machine
  traffic never impersonates the user.
- A **debounce window** merges a burst of entries into one notice. The
  window opens on the first entry and closes it; entries arriving after
  the flush open a new one, so sustained traffic wakes on a cadence
  rather than starving behind a resetting timer.
- Directory events are best-effort. Node may deliver a null filename ("not
  available" on some platforms) and events can be dropped, so a null
  filename drains anyway and a 30-second sweep drains unconditionally;
  the byte offsets make every drain catch up, so a lost event delays a
  notice instead of stranding an ask.
- History is not news: watching a record seeds the read offsets at the
  current file sizes, so a restart (or re-enabling a kind) does not
  replay the backlog. A newline-terminated line that will not parse is
  counted and reported in the next digest rather than dropped silently.
- Policy lives in `authority.jsonc`'s optional `wake` section —
  `reports`, `errors` and `asks` are `"immediate"` or `"off"`, plus
  `debounceMs` (default 2000) — and the three switches are independent:
  an errors-off policy silences the most decision-shaped news there is,
  so it is its own choice. Turning all three off is exactly the 0.1.0
  pull-only protocol.

- Idle child + mailbox message → the extension (RPC client) queues a
  prompt; the child's loop runs; its reply routes into the target
  mailbox. Busy child → queued, drained on idle.
- Children die with the parent process. Logs persist in the session
  record; reconvening is a fresh draw with the record as the blackboard.

**Lifecycle:** convene → work → report → rate → dissolve.
Dissolution-on-exit is a feature.

---

## Permissions

Three tiers, routed as messages:

1. **Pre-approved** — the agent file's `tools` list; never asks.
2. **Ask the quartermaster** — routed as a priority message; it decides
   in context (it knows the spec, the task, the repo).
3. **Escalate to the user** — when the quartermaster can't decide, or
   policy forbids it deciding alone.

The third rule is load-bearing: a quartermaster approving in the user's
name is delegated authority, and a persuadable orchestrator is a
privilege-escalation path. User config carries a **quartermaster
authority** section: categories it may approve alone (reads, tests,
builds) versus categories it must always escalate (destructive shell,
network, credentials, writes outside the worktree). The same file's
optional `matching` section tunes the draw (`costLambda`, `priorStrength`); absent
sections mean the documented defaults.

---

## Tool surface

Quartermaster-facing (the interactive session):

| Tool | Purpose |
|---|---|
| `convene` | form a team: draw a model per member (once) or pin one per member, spawn persistent RPC children, define mailboxes |
| `team list` | members, live status, their descriptions and recommended use |
| `read-channel` / `digest` | inspect mailbox traffic and reports on demand; reports, engine errors and asks also arrive as debounced wake digests |
| `rate` | outcome-shaped rating → evidence store, at return-time |
| `set-cost` / `set-override` | durable facts → models.yaml |
| `dissolve` | end the session; collect reports; children exit |

Child-facing (registered inside each spawned session):

| Tool | Purpose |
|---|---|
| `send` | mailbox message; lists only channels whose `from` matches |
| `report` | task report to the quartermaster (rater-friendly payload: final message, files touched, errors, confidence) |
| `request-permission` | the tier-2 ask |

Every child's spawn prompt is assembled with a constitutional
introduction, injected by the extension in code (single-sourced, not
configurable): *you operate within a team convened by the Quartermaster;
all mailbox traffic is visible to it; permission questions go to it;
reports go to it.*

---

## Skills

Procedural, not configuration — instructions the installing agent and
the orchestrator follow:

- **`team-setup`** — first-run: ask which providers the user can reach,
  which roles they want, write agent files and `models.yaml` priors,
  validate schemas, run the refresh script.
- **`teamwork`** — the orchestrator's standing orders: inventory the team
  before delegating; trivial tasks it does itself; non-trivial ones get
  members; spec choice by task complexity (the qualitative call stays
  with the quartermaster); escalations (auth/tenant/money diffs →
  security review at frontier; spec-bearing changes → business-logic
  review; view/CSS → designer); **rate at return-time**, catch unrated
  spawns before ending; when the user mentions access or pricing,
  `set-cost`; convening defines the relationship graph up front —
  mid-flight channel creation is a recorded decision, not entropy.

---

## Security posture

- The package is installed user-level and runs with the user's full
  trust; its highest-risk surface is the writing child's permission
  posture. The three-tier policy above is the mitigation; the authority
  bounds are user-authored.
- All traffic is logged to the session record; logs are rating evidence
  and audit trail. Retention follows the session's own lifecycle.
- Mailbox traffic is declared observed — and is, actually, observed. The
  declaration is honest because the logs are real.
- Children run headless: they cannot prompt the user directly; every
  question routes through the quartermaster or the policy.

## Non-goals (for now)

- Live steering of a running child — abort-and-respawn covers the value.
- Parallel builders in one checkout — needs git worktree isolation, a
  separate feature (read-only members parallelize freely today).
- Cross-harness agent-file portability — agent markdown is
  Quartermaster-shaped; the cross-harness world has no convention yet.
- Any committed configuration.
