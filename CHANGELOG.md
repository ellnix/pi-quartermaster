# Changelog

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
