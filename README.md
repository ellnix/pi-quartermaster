# pi-quartermaster

A pi package that lets your main pi session — the **quartermaster** —
convene, equip, and govern a team of persistent sub-agents: different
agents, different models, drawn stochastically from pools you define,
talking through sanctioned mailboxes whose preambles you author.

The quartermaster equips the team. It does not command tactics — the
agents' own skills do that.

**Status:** design-complete, implementation pending.
Read [ARCHITECTURE.md](ARCHITECTURE.md) — it is the full spec.

## Install (once implemented)

```sh
pi install npm:pi-quartermaster
```

Installs at user level: active in every repo, no per-repo setup, nothing
committed to the repos it works in. Ships zero configuration — your
installing agent configures your team, your model priors, and your
mailboxes with the shipped `team-setup` skill.

## License

MIT
