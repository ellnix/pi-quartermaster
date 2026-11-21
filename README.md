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
~/.agents/agents/<name>.md      # team members: description, tools, spec
~/.agents/mailboxes/<name>.md   # channels: from, to, preamble
~/.pi/agent/team/specs.jsonc     # pools: weight vectors, temperature, filters
~/.pi/agent/team/models.yaml     # score priors + cost (yours, never machine-rewritten)
~/.pi/agent/team/authority.jsonc # which tool categories the quartermaster
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
| `convene_team` | spawn members with drawn models, open mailboxes |
| `team_list` | members, states, pending asks, unread reports |
| `read_channel` | mailbox traffic or reports, on demand |
| `rate_member` | outcome rating → evidence posterior (rate at return-time) |
| `set_cost` / `set_override` | durable facts with provenance |
| `pending_asks` / `resolve_ask` | permission asks; escalate-only needs the user's words |
| `dissolve_team` | collect, dispose, keep the record |

Members get `report`, `send`, and `request_permission` — their only
channels. All traffic is logged to the team record and readable on
demand; nothing is pushed into your context.

## Development

```sh
npm run check                  # tsc --noEmit (strict)
pi -e .                        # load the package locally: extension + skills
npx tsx scripts/smoke-config.ts [cwd]     # config discovery check
npx tsx scripts/smoke-matcher.ts          # draw distribution check
node scripts/refresh-scores.cjs            # prior suggestions
```

## License

MIT
