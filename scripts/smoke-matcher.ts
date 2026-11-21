/**
 * Matcher distribution smoke check, run against an isolated agent dir so
 * nothing touches the real configuration:
 *
 *   PI_CODING_AGENT_DIR=/tmp/qm-smoke npx tsx scripts/smoke-matcher.ts
 *
 * Exercises the whole selection stack — filters, Thompson posteriors,
 * softmax — with synthetic candidates and prints the draw distribution
 * so temperature behavior is visible at a glance.
 */

process.env.PI_CODING_AGENT_DIR ??= "/tmp/qm-smoke-agent-dir";

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config/index.ts";
import { recordOutcome, loadEvidence } from "../src/matching/evidence.ts";
import { loadOverrides } from "../src/matching/overrides.ts";
import { drawForSpec, type Candidate } from "../src/matching/matcher.ts";

const teamDir = path.join(process.env.PI_CODING_AGENT_DIR, "team");
fs.rmSync(teamDir, { recursive: true, force: true });
fs.mkdirSync(teamDir, { recursive: true });

// Score priors for two of three candidates; the third is unrated.
fs.writeFileSync(
	path.join(teamDir, "models.yaml"),
	[
		"good/strong-model:",
		"  scores:",
		"    reviewing-code: 0.9",
		"    writing-code: 0.8",
		"  cost: 0.3",
		"cheap/weak-model:",
		"  scores:",
		"    reviewing-code: 0.4",
		"    writing-code: 0.5",
		"  cost: 0.9",
		"fresh/unrated-model:",
		"  cost: 0.7",
	].join("\n"),
);
fs.writeFileSync(
	path.join(teamDir, "specs.jsonc"),
	JSON.stringify(
		{
			"review/frontier": { weights: { "reviewing-code": 1.0 }, temperature: 0.5, filters: { require: ["text"] } },
			"review/basic": { weights: { "reviewing-code": 0.6, cost: 0.4 }, temperature: 1.0 },
			"review/scout": { weights: { "reviewing-code": 1.0 }, temperature: 0.5, filters: { allowUnrated: true } },
		},
		null,
		"\t",
	),
);

const candidates: Candidate[] = [
	{ modelId: "good/strong-model", name: "Strong", provider: "good", input: ["text", "image"], catalogCostPerMtok: 15, hasAuth: true },
	{ modelId: "cheap/weak-model", name: "Weak", provider: "cheap", input: ["text"], catalogCostPerMtok: 0.25, hasAuth: true },
	{ modelId: "fresh/unrated-model", name: "Unrated", provider: "fresh", input: ["text"], catalogCostPerMtok: 2, hasAuth: true },
	{ modelId: "noauth/model", name: "NoAuth", provider: "noauth", input: ["text"], catalogCostPerMtok: 1, hasAuth: false },
];

const config = loadConfig(process.cwd());
const overrides = loadOverrides();

// Give the weak model a hot streak on reviewing: evidence must be able to
// beat the prior when the trials pile up.
const evidence = loadEvidence();
for (let i = 0; i < 40; i++) recordOutcome(evidence, "cheap/weak-model", "reviewing-code", 0.95);
for (let i = 0; i < 5; i++) recordOutcome(evidence, "good/strong-model", "reviewing-code", 0.3);

function distribution(specName: string, draws: number): void {
	const spec = config.specs.get(specName)!;
	const counts = new Map<string, number>();
	for (let i = 0; i < draws; i++) {
		const result = drawForSpec(candidates, config, overrides, evidence, spec, specName);
		if (!result.ok) {
			console.log(`${specName}: FAILED — ${result.error}`);
			return;
		}
		counts.set(result.modelId, (counts.get(result.modelId) ?? 0) + 1);
	}
	const line = [...counts.entries()]
		.map(([model, n]) => `${model} ${((n / draws) * 100).toFixed(0)}%`)
		.join("   ");
	console.log(`${specName.padEnd(16)} ${line}`);
}

console.log(`draw distribution over 300 draws (evidence: weak-model hot streak, strong-model cold streak):`);
distribution("review/frontier", 300);
distribution("review/basic", 300);
distribution("review/scout", 300);

// Frontier without ratings for the two scored models should fail loudly.
const noScoreConfig = loadConfig(process.cwd());
noScoreConfig.models.clear();
const frontier = noScoreConfig.specs.get("review/frontier")!;
const result = drawForSpec(candidates.slice(0, 3), noScoreConfig, overrides, new Map(), frontier, "review/frontier");
console.log(`no-scores case: ${result.ok ? "UNEXPECTED SUCCESS" : result.error}`);
