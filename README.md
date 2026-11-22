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
| `convene_team` | spawn members with drawn models; declare the channel wiring |
| `team_list` | members, states, open channels, pending asks, unread reports |
| `read_channel` | mailbox traffic or reports, on demand — plain JSONL, analyze freely |
| `message_member` | quartermaster-to-member guidance; `steer` interrupts mid-run |
| `rate_member` | outcome rating by member → weighted evidence (rate at return-time) |
| `set_cost` / `set_override` | durable facts with provenance |
| `pending_asks` / `resolve_ask` | permission asks; escalate-only needs the user's words |
| `dissolve_team` | collect, dispose, keep the record |

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
npx tsx scripts/smoke-matcher.ts          # draw distribution check
npx tsx scripts/smoke-wake.ts              # wake digest + debounce check
node scripts/refresh-scores.cjs            # prior suggestions
```

## License

MIT
