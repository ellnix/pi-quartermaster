/**
 * Smoke check for the configuration loader. Read-only: discovers every
 * layer, prints what it found and every warning. Run against a fixture
 * directory to exercise validation paths:
 *
 *   npx tsx scripts/smoke-config.ts [cwd]
 */

import { loadConfig } from "../src/config/index.ts";

const cwd = process.argv[2] ?? process.cwd();
const config = loadConfig(cwd);

const lines: string[] = [];
lines.push(`config for ${cwd}`);
lines.push(`agents (${config.agents.size}):`);
for (const a of config.agents.values()) {
	lines.push(`  - ${a.name} [${a.source}] spec=${a.spec ?? "-"} model=${a.model ?? "-"} tools=${a.tools?.join(",") ?? "-"} :: ${a.description.split("\n")[0]}`);
}
lines.push(`mailboxes (${config.mailboxes.size}):`);
for (const m of config.mailboxes.values()) {
	lines.push(`  - ${m.name} [${m.source}] (template - endpoints wired at convene) :: ${m.description.split("\n")[0]}`);
}
lines.push(`specs (${config.specs.size}):`);
for (const [name, s] of config.specs) {
	lines.push(`  - ${name} τ=${s.temperature} weights=${JSON.stringify(s.weights)} filters=${JSON.stringify(s.filters ?? {})}`);
}
lines.push(`models (${config.models.size}):`);
for (const [id, m] of config.models) {
	lines.push(`  - ${id} cost=${m.cost ?? "-"} scores=${JSON.stringify(m.scores ?? {})}`);
}
lines.push(`authority: autoApprove=${JSON.stringify(config.authority.autoApprove)} escalate=${JSON.stringify(config.authority.escalate)}`);

if (config.emptyState) lines.push("", config.emptyState);
if (config.warnings.length) {
	lines.push("", `warnings (${config.warnings.length}):`);
	for (const w of config.warnings) lines.push(`  - ${w.file}: ${w.message}`);
}

console.log(lines.join("\n"));
