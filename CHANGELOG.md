# Changelog

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
- `scripts/verify-math.ts` asserts the cost factor's arithmetic and
  `scripts/smoke-matcher.ts` asserts every acceptance case of both
  changes (unlisted-model admission, cost-only models, score floors,
  lambda 0, equal-cost odds).

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
