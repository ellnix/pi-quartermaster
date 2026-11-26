# pi-quartermaster

A pi package that lets your main pi session — the **quartermaster** —
convene, equip, and govern a team of sub-agents: different agents,
different models, drawn stochastically from pools you define, talking
through sanctioned mailboxes whose preambles you author.

The quartermaster equips the team. It does not command tactics — the
agents' own skills do that.

**Status:** v0.1.0 — engine implemented (fleet, mailboxes, permissions,
matcher, evidence, skills). Read [ARCHITECTURE.md](ARCHITECTURE.md) for
the design and its rationale.

## Install

```sh
pi install npm:pi-quartermaster
```

Installs at user level: active in every repo, no per-repo setup, nothing
committed to the repos it works in. Ships zero configuration — run the
`team-setup` skill to configure your team, your model priors, and your
mailboxes.

## Configure (once)

```
# everything under pi's agent dir, relocated wholesale by
# PI_CODING_AGENT_DIR:
team/agents/<name>.md            # members: description, tools, inline spec
team/mailboxes/<name>.md         # channel templates: preamble (no endpoints —
                                  # the convene wiring decides who talks to whom)
team/models.yaml                  # score priors + cost (yours, never machine-rewritten)
team/authority.jsonc              # which tool categories the quartermaster
                                  # may approve alone vs. must escalate
```

Project overrides live in `.pi/agents/` and `.pi/team/` — optional, and
fine to never use.

`node scripts/refresh-scores.cjs [provider ...]` prints suggested cost
priors from public catalog data. It never writes your files.

## Use

The `teamwork` skill carries the standing orders; the tools are the
surface:

| Tool | Purpose |
|---|---|
| `convene_team` | spawn members with drawn models (or one pinned per member); declare the channel wiring |
| `team_list` | with no team: the agents and mailbox templates you can convene; with one: members, states, workspaces, open channels, pending asks, unread reports |
| `add_member` / `remove_member` | change a live team without re-drawing everyone; removed members stay in the record and stay ratable |
| `open_mailbox` / `close_mailbox` | wire or shut a channel mid-flight; a closed channel keeps its log |
| `worktrees` | list or prune the git worktrees members work in |
| `read_channel` | mailbox traffic or reports, on demand — plain JSONL, analyze freely |
| `message_member` | quartermaster-to-member guidance; `steer` interrupts mid-run |
| `rate_member` | outcome rating by member → weighted evidence (rate at return-time) |
| `set_cost` / `set_override` | durable facts with provenance |
| `pending_asks` / `resolve_ask` | permission asks; escalate-only needs the user's words |
| `dissolve_team` | collect, dispose, keep the record |

Members that can write work in their own git worktree on their own
branch, so nothing overwrites anything, including your tree
(`.pi/team/worktrees.jsonc` declares what a fresh tree needs).

Each member's model is drawn once from its spec, or pinned by its agent
file. Naming `model` (a physical `provider/model-id`) on a convene member
or on `add_member` overrides both for that deployment: the choice is
checked against the catalog and configured auth instead of silently
falling back to a draw, `team_list` marks it `(explicit)`, and the
record keeps how every model was resolved.

Members get `report`, `send`, and `request_permission` — their only
channels. Reports carry tracking numbers (`r1, r2, ...`), messages too
(`m1, m2, ...`), so all three parties steer by reference. All traffic
is logged to the team record and readable on demand. Mailbox traffic
stays on demand; reports and permission asks also arrive as short wake
digests (ids and one-line summaries), so a blocked member or a finished
task is not missed while you are away. The `wake` section of
`authority.jsonc` turns that off.

## Development

```sh
npm run check                  # tsc --noEmit (strict)
pi -e .                        # load the package locally: extension + skills
npx tsx scripts/smoke-config.ts [cwd]     # config discovery check
npx tsx scripts/smoke-tools.ts            # tool surface check (explicit model field)
npx tsx scripts/smoke-members.ts          # dynamic membership + model choice check
npx tsx scripts/smoke-matcher.ts          # draw distribution check
npx tsx scripts/smoke-wake.ts              # wake digest + debounce check
node scripts/refresh-scores.cjs            # prior suggestions
```

## License

MIT
