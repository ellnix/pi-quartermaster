# Changelog

## [0.1.0]
### Added
- Engine scaffold: the full quartermaster tool surface, inert until configured.
- Configuration model and discovery: agents and mailboxes as markdown,
  specs.jsonc, models.yaml, authority.jsonc — validated with loud warnings,
  never throws on one bad file.
- Matcher and evidence store: filter then softmax draw, Thompson
  posteriors from outcome-shaped ratings, machine-owned overrides.yaml
  for durable facts with provenance, unrated models excluded unless a
  spec scouts them.
- Fleet lifecycle: in-process child sessions through the pi SDK, one
  model drawn per convening, constitutional introduction assembled in
  code, the record as blackboard.
- Mailboxes and reports: unidirectional description-routed channels
  with preamble assembly, busy-recipient queues, JSONL traffic logs,
  reports on the star, everything readable on demand.
- Permissions: pre-approved tools, ask-the-quartermaster with a
  file-mediated wait, escalate-only categories that demand the user's
  confirmation, unresolved asks time out denied.
- Skills: team-setup (first-run configuration by interview) and
  teamwork (the quartermaster's standing orders, rate at return-time).
- refresh-scores.cjs: suggested cost priors from public catalog data;
  never writes your files.
