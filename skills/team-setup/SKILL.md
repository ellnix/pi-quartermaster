---
name: team-setup
description: >-
  Use this skill to configure Quartermaster on first run: interview the
  user, write their agent definitions, model priors, authority bounds,
  and mailbox templates, then validate the configuration.
---

# Team setup

Quartermaster ships zero configuration — this skill writes all of it.
The user's answers, not defaults, decide the team.

## Steps

1. **Discover the current state.** Run the configuration smoke check
   from the package root (`npx tsx scripts/smoke-config.ts`) and read
   what exists. Missing everything is normal on first run.
2. **Interview the user.** Ask, in one pass:
   - Which providers and models they can actually reach (their keys and
     plans, not the catalog's list).
   - Which roles they want. Suggest the working taxonomy: a read-only
     **scout** for repo exploration, a **builder** for fully-specified
     implementation, a **reviewer** against the repo's review skill, a
     **designer** on vision-capable models for view/CSS changes, plus
     escalation reviewers (security, business logic) if the repo
     handles money, tenancy, or auth.
   - Which relationships should exist between members (who may ask whom
     for what) — these become mailbox templates.
3. **Write the agent files** to the agent dir (`team/agents/`,
     relocated wholesale by `PI_CODING_AGENT_DIR`; project overrides in
     `.pi/agents/`):

   ```markdown
   ---
   name: reviewer
   description: Reviews a changeset against the repo's review skill. Use
     before requesting merge on non-trivial work.
   tools: read, grep, bash
   spec:
     weights: { reviewing-code: 1.0 }
     temperature: 0.7
     filters: { require: [text], minCostScore: 0.3, minScores: { reviewing-code: 0.75 } }
   ---
   You are a code reviewer. Load the repo's code-review skill and follow it.
   ```

   **Variants.** One file can declare several addressable agents that
   share the prompt and tools but differ in stance — for racing two
   implementations, a second-opinion reviewer, or a cheap and a thorough
   instance of one role:

   ```yaml
   variants:
     builder: {}                                  # inherits the spec
     builder-cheap: { weights: { cost: 0.7 } }    # deep-merged over spec
     builder-independent: { temperature: 0.9 }
   ```

   A variant may override `weights`, `temperature` and `filters`
   (merged key by key over the file's `spec`); anything else warns and is
   ignored. Each variant is drawn independently, is its own member with
   its own session, channels and rating, and shows in `team_list` as
   `builder-cheap (builder)`. Use them only when the instructions are the
   same and the model economics differ; otherwise write separate files.
   No `variants` block means one agent named after the file. Variants
   should name the variants, not rely on positions: if the file's own
   `name` should stay addressable, list it too.

   Rules: `tools` is the pre-approved surface — grant `edit` and `write`
   only to builders; absence means read-only defaults. Every agent needs
   a spec (inline in frontmatter — weights, temperature, filters) or a
   direct `model` pin. There is no specs file: reusable specs live in
   agent definitions, and the quartermaster builds overrides on the fly
   at convene. Weights are 0-1. `filters.minScores: {dimension: 0-1}` is
   a **requirement**: candidates below the bar are excluded before the
   draw (it reads overrides, then models.yaml, then the evidence mean),
   so write frontier stances as a score floor rather than as a quality
   tilt. Every draw also subtracts an always-on cost penalty from each
   candidate's suitability, so the cheap side of a close call wins a
   little more often — mention `matching.costLambda` (0 disables it) only
   if the user wants pure quality draws. The description is what the
   quartermaster routes on — write it as a when-to-use statement.
4. **Write the model priors** to `team/models.yaml`. Cost is a 0-1 score
   (1 = cheapest), per-account: ask about promotions and plans, not list
   prices. Scores are priors — set them from what the user knows, mention
   `scripts/refresh-scores.cjs` for cost suggestions, and note that
   ratings gathered by the quartermaster refine them over time. This file
   Scores are a **prior belief with weight**, not a fallback: ratings
   refine them as `k` pseudo-trials of your belief (`matching.priorStrength`
   in `authority.jsonc`, default 6), so one rating moves a score without
   overturning it. A model that should move fast (a new arrival) can set
   `prior_strength: 2`; one you hold steady (a considered frontier
   prior), `prior_strength: 12`. This file is also the **spend whitelist**: a model is rated for non-scout specs
   only when it has `scores` here (or a score override), so every model
   the user is willing to pay for needs at least a rough score. A
   `cost`-only entry is price knowledge with no quality judgement and
   stays unrated; evidence never admits a model the user did not list.
5. **Write the mailbox templates** to `team/mailboxes/<name>.md` —
   `name` and `description` in frontmatter, the preamble as the body.
   Templates carry **no endpoints**: the convene call's channel wiring
   decides who talks to whom. Preambles may reference `${from}` and
   `${to}`, which the engine substitutes at delivery, so role-voiced
   text stays truthful under any wiring. Adversarial review pairs
   should say so explicitly. One template can back any number of
   pairings (`builder -> scout` and `reviewer -> scout` from the same
   file), so write one generic template per relationship kind, not one
   per pair. Wiring the same template with the same endpoints twice is
   an error.
6. **Optionally write `team/authority.jsonc`** — which tool categories
   the quartermaster may approve alone versus which always escalate, plus
   the optional `matching` section (`costLambda`, default 0.15; `priorStrength`, default 6) and
   `wake` section (`reports` / `asks` as `"immediate"` or `"off"`,
   `debounceMs`).
   The defaults are conservative; only loosen them on the user's
   explicit instruction.
7. **Validate.** Re-run the smoke check. Every warning is a real defect
   or a real decision to record. Then verify with `team_list` in a live
   session: it should report the configured counts.

Never invent access the user did not confirm. A spec that draws models
the user cannot reach fails at convening with a clear error — the
interview is where that is prevented.
