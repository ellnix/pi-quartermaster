# Agent files: reference

Read this when authoring or editing a file in `team/agents/` (or the
project's `.pi/agents/`). With no team convened, `team_list` shows each
configured agent's `description`, tools and spec; that is what you plan
a convene from. The file below is **one illustration**: a user's roles,
names, tools and score dimensions are their own, so copy the shape, not
the contents, and take dimension names from their `models.yaml`.

```markdown
---
name: reviewer
description: Reviews a changeset against the repo's review skill. Use
  before requesting merge on non-trivial work.
tools: read, ls, find, grep, bash
spec:
  weights: { review: 0.8, cost: 0.2 }
  temperature: 0.6
  filters: { require: [text], minCostScore: 0.3, minScores: { review: 0.7 } }
variants:
  reviewer: {}
  reviewer-frontier: { weights: { review: 0.9, cost: 0.1 }, temperature: 0.3, filters: { minScores: { review: 0.85 } } }
---
You are a code reviewer. Findings sorted by severity; for each, say the
conditions under which it manifests. Do not soften findings. Send
findings to the builder on your mailbox; report a verdict when done.
If you lack access to something you need, say so in a report instead
of guessing.
```

| Field | What it is | Changing it does |
|---|---|---|
| `name` | The definition id and, without `variants`, the member name | Renaming breaks wirings that name it |
| `description` | When to use this agent (shown by `team_list`) | Changes how you, the quartermaster, route; write a when-to-use sentence |
| `tools` | The pre-approved tool surface. A grant, not a suggestion | Adding `edit`/`write` makes a builder; omitting means read-only defaults. Anything outside it must be asked for via `request_permission` |
| `worktree` | Where members work: `shared` (the user's tree), `per-member` (its own git worktree and branch) or `attach` (another member's worktree, named at convene with `attachTo`) | Absent: per worktrees.jsonc — with `default: auto`, `per-member` for agents granted `edit`/`write` and `shared` otherwise; with `default: shared`, always `shared`. A convene's `worktree` argument overrides this. `attach` is for read-only agents and is refused for agents with `edit`/`write` |
| `model` | Pins one exact model and skips the draw | Use for a model that must not vary; otherwise leave it out and use a spec |
| `spec.weights` | Dimensions the draw optimises, each 0-1; `cost` weighs cheapness | Raising a dimension tilts draws to models scored high on it |
| `spec.temperature` | Draw posture, 0-5. Low trusts the scores; high gambles | 0 is deterministic best; 0.3 frontier; 0.5-0.8 normal; above 1 is deliberate chaos |
| `filters.require` | Input modalities a candidate must support (`text`, `image`) | `[image]` restricts the pool to vision models; a designer needs it |
| `filters.minCostScore` | Cheapness floor, 0-1, 1 = cheapest | Excludes expensive models before the draw |
| `filters.minScores` | A **requirement**: per-dimension floor | Excludes candidates below the bar before the draw. A frontier stance is a floor, not a higher weight |
| `filters.allowUnrated` | Lets models you never scored into the pool | A gamble on unknowns; fine for a scout, wrong for a builder |
| `variants` | Extra addressable agents sharing this file's prompt and tools | Each variant deep-merges its `weights`/`temperature`/`filters` over `spec`, is drawn independently and rated on its own |

`require` is capability, `minScores` is quality. Use `require` to say
"must see images", `minScores` to say "must be good at review".

## The prompt body

A short skeleton, in this order:

1. **Role**, one line: "You are a code reviewer."
2. **Boundaries**: what it must not do (a scout does not write; a
   reviewer does not fix).
3. **Output shape**: what a good result looks like (exact paths and line
   numbers; findings by severity).
4. **Reporting duty**: it reports at milestones and at completion; the
   engine adds the mechanics.
5. **When blocked**: say so in a report instead of guessing.

Keep it stable and generic. Task detail goes in the task, never here:
the file is reused across every convene.
