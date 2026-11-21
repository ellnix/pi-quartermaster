/**
 * Matcher distribution smoke check, run against an isolated agent dir so
 * nothing touches the real configuration:
 *
 *   PI_CODING_AGENT_DIR=/tmp/qm-smoke npx tsx scripts/smoke-matcher.ts
 *
 * Exercises the whole selection stack — filters, Thompson posteriors,
 * softmax — with synthetic candidates, specs constructed the way a
 * quartermaster builds them (in memory: specs live in agent definitions
 * or are built on the fly, never in a file).
 */

process.env.PI_CODING_AGENT_DIR ??= "/tmp/qm-smoke-agent-dir";

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/config/index.ts";
import type { SpecDef } from "../src/config/spec.ts";
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
		"vetoed/multimodal-model:",
		"  require: [text]",
		"plain/multimodal-model:",
		"  cost: 0.5",
		"expanded/multimodal-model:",
		"  require: [text, image]",
	].join("\n"),
);

// Specs as a quartermaster builds them: in memory, not in a file.
const frontier: SpecDef = { weights: { "reviewing-code": 1.0 }, temperature: 0.5, filters: { require: ["text"] } };
const basic: SpecDef = { weights: { "reviewing-code": 0.6, cost: 0.4 }, temperature: 1.0 };
const scout: SpecDef = { weights: { "reviewing-code": 1.0 }, temperature: 0.5, filters: { allowUnrated: true } };

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

function distribution(name: string, spec: SpecDef, draws: number): void {
	const counts = new Map<string, number>();
	for (let i = 0; i < draws; i++) {
		const result = drawForSpec(candidates, config, overrides, evidence, spec, name);
		if (!result.ok) {
			console.log(`${name}: FAILED — ${result.error}`);
			return;
		}
		counts.set(result.modelId, (counts.get(result.modelId) ?? 0) + 1);
	}
	const line = [...counts.entries()]
		.map(([model, n]) => `${model} ${((n / draws) * 100).toFixed(0)}%`)
		.join("   ");
	console.log(`${name.padEnd(16)} ${line}`);
}

console.log(`draw distribution over 300 draws (evidence: weak-model hot streak, strong-model cold streak):`);
distribution("review/frontier", frontier, 300);
distribution("review/basic", basic, 300);
distribution("review/scout", scout, 300);

// Frontier without rated candidates should fail loudly.
const noScoreConfig = loadConfig(process.cwd());
noScoreConfig.models.clear();
const result = drawForSpec(candidates.slice(0, 3), noScoreConfig, overrides, new Map(), frontier, "review/frontier");
console.log(`no-scores case: ${result.ok ? "UNEXPECTED SUCCESS" : result.error}`);

// A models.yaml `require` is a veto over the catalog's claimed input: the
// effective input is the catalog's list intersected with it. These three
// cases pin narrow, no-entry passthrough, and grant-denied.
const imageSpec: SpecDef = {
	weights: { "reviewing-code": 1.0 },
	temperature: 0,
	filters: { require: ["image"], allowUnrated: true },
};
const vetoedCandidate: Candidate = {
	modelId: "vetoed/multimodal-model",
	name: "Vetoed",
	provider: "vetoed",
	input: ["text", "image"],
	catalogCostPerMtok: 5,
	hasAuth: true,
};
const plainCandidate: Candidate = { ...vetoedCandidate, modelId: "plain/multimodal-model", name: "Plain", provider: "plain" };

const vetoed = drawForSpec([vetoedCandidate], config, overrides, evidence, imageSpec, "require/vetoed");
const catalogOnly = drawForSpec([plainCandidate], config, overrides, evidence, imageSpec, "require/catalog");

// A veto narrows, it never grants: the entry lists [text, image] over a
// catalog that claims [text] only, and the image spec still rejects it.
const expandedCandidate: Candidate = {
	...vetoedCandidate,
	modelId: "expanded/multimodal-model",
	name: "Expanded",
	provider: "expanded",
	input: ["text"],
};
const expanded = drawForSpec([expandedCandidate], config, overrides, evidence, imageSpec, "require/expanded");

const vetoExcluded = !vetoed.ok && vetoed.error.includes("input requirement image");
const catalogPassed = catalogOnly.ok && catalogOnly.modelId === "plain/multimodal-model";
const expansionBlocked = !expanded.ok && expanded.error.includes("input requirement image");
console.log(`require override, entry require [text] vs spec [image]: ${vetoExcluded ? "excluded (correct)" : "NOT excluded - WRONG"}`);
console.log(`require override, no entry, catalog [text,image] vs spec [image]: ${catalogPassed ? "passes (correct)" : "blocked - WRONG"}`);
console.log(`require override, entry require [text,image] vs catalog [text]: ${expansionBlocked ? "excluded (correct, a veto cannot grant)" : "GRANTED - WRONG"}`);
if (!vetoExcluded || !catalogPassed || !expansionBlocked) {
	throw new Error("models.yaml require does not narrow the catalog input list");
}
