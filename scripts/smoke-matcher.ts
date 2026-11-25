/**
 * Matcher semantics smoke check, run against an isolated agent dir so
 * nothing touches the real configuration:
 *
 *   PI_CODING_AGENT_DIR=/tmp/qm-smoke npx tsx scripts/smoke-matcher.ts
 *
 * Two layers, both loud: distribution lines show the shape of each draw, and
 * every acceptance case from the admission and cost-gate issues is asserted.
 * The run exits non-zero on any failed assertion — a smoke check that only
 * prints is a smoke check that passes on a broken matcher.
 *
 * Everything here is synthetic: no real team record, no real models.yaml.
 */

process.env.PI_CODING_AGENT_DIR ??= "/tmp/qm-smoke-agent-dir";

import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, type QuartermasterConfig } from "../src/config/index.ts";
import type { SpecDef } from "../src/config/spec.ts";
import { validateSpec } from "../src/config/spec.ts";
import { recordOutcome, loadEvidence, type EvidenceStore } from "../src/matching/evidence.ts";
import { loadOverrides, type Overrides } from "../src/matching/overrides.ts";
import { drawForSpec, type Candidate, type DrawResult } from "../src/matching/matcher.ts";

const teamDir = path.join(process.env.PI_CODING_AGENT_DIR, "team");
fs.rmSync(teamDir, { recursive: true, force: true });
fs.mkdirSync(teamDir, { recursive: true });

// Score priors for the listed models; the cost-only entries exist to prove
// that knowing a price is not knowing a quality — and the ghost model is
// deliberately absent from the file, because absence is what the whitelist
// test is about.
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
		"fresh/cost-only-model:",
		"  cost: 0.7",
		"vetoed/multimodal-model:",
		"  require: [text]",
		"plain/multimodal-model:",
		"  cost: 0.5",
		"expanded/multimodal-model:",
		"  require: [text, image]",
		"cheap/tier-model:",
		"  scores:",
		"    reviewing-code: 0.8",
		"  cost: 0.9",
		"expensive/tier-model:",
		"  scores:",
		"    reviewing-code: 0.8",
		"  cost: 0.4",
		"tie/a-model:",
		"  scores:",
		"    reviewing-code: 0.85",
		"  cost: 0.5",
		"tie/b-model:",
		"  scores:",
		"    reviewing-code: 0.6",
		"  cost: 0.5",
		"gated/low-model:",
		"  scores:",
		"    reviewing-code: 0.3",
		"  cost: 0.5",
		"gated/high-model:",
		"  scores:",
		"    reviewing-code: 0.95",
		"  cost: 0.5",
	].join("\n"),
);

function candidate(modelId: string, provider: string, costPerMtok = 5): Candidate {
	return {
		modelId,
		name: modelId,
		provider,
		input: ["text"],
		catalogCostPerMtok: costPerMtok,
		hasAuth: true,
	};
}

const candidates: Candidate[] = [
	candidate("good/strong-model", "good", 15),
	candidate("cheap/weak-model", "cheap", 0.25),
	candidate("fresh/cost-only-model", "fresh", 2),
	{ ...candidate("noauth/model", "noauth", 1), hasAuth: false },
	{
		modelId: "vetoed/multimodal-model",
		name: "Vetoed",
		provider: "vetoed",
		input: ["text", "image"],
		catalogCostPerMtok: 5,
		hasAuth: true,
	},
];

const config = loadConfig(process.cwd());
const overrides = loadOverrides();
const evidence = loadEvidence();

/** A config with the cost penalty tuned — the same team, a different policy. */
function withLambda(lambda: number): QuartermasterConfig {
	return { ...config, authority: { ...config.authority, matching: { ...config.authority.matching, costLambda: lambda } } };
}

// --- Specs, built the two ways a quartermaster builds them: in memory.

const frontier: SpecDef = { weights: { "reviewing-code": 1.0 }, temperature: 0.5, filters: { require: ["text"] } };
const basic: SpecDef = { weights: { "reviewing-code": 0.6, cost: 0.4 }, temperature: 1.0 };
const scout: SpecDef = { weights: { "reviewing-code": 1.0 }, temperature: 0.5, filters: { allowUnrated: true } };

// Give the weak model a hot streak on reviewing: evidence must be able to
// beat the prior when the trials pile up. This is refinement of a LISTED
// model — the legit half of evidence.
for (let i = 0; i < 40; i++) recordOutcome(evidence, "cheap/weak-model", "reviewing-code", 0.95);
for (let i = 0; i < 5; i++) recordOutcome(evidence, "good/strong-model", "reviewing-code", 0.3);

// The live failure shape: a model nobody listed carries a strong posterior
// left behind by earlier runs. Evidence alone must never admit it.
const ghostEvidence = new Map([["ghost/unlisted-model", new Map([["reviewing-code", { a: 8, b: 1 }]])]]);

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

function distribution(
	name: string,
	spec: SpecDef,
	pool: Candidate[],
	draws: number,
): Map<string, number> {
	const counts = new Map<string, number>();
	for (let i = 0; i < draws; i++) {
		const result = drawForSpec(pool, config, overrides, evidence, spec, name);
		if (!result.ok) {
			console.log(`${name.padEnd(16)} FAILED — ${result.error}`);
			return counts;
		}
		counts.set(result.modelId, (counts.get(result.modelId) ?? 0) + 1);
	}
	const line = [...counts.entries()]
		.map(([model, n]) => `${model} ${((n / draws) * 100).toFixed(0)}%`)
		.join("   ");
	console.log(`${name.padEnd(16)} ${line}`);
	return counts;
}

/** Draw-and-count against a specific pool/evidence/policy, for assertions. */
function share(
	spec: SpecDef,
	pool: Candidate[],
	draws: number,
	options: { config?: QuartermasterConfig; evidence?: EvidenceStore } = {},
): Map<string, number> {
	const counts = new Map<string, number>();
	const cfg = options.config ?? config;
	const store = options.evidence ?? evidence;
	for (let i = 0; i < draws; i++) {
		const result = drawForSpec(pool, cfg, overrides, store, spec, "assert");
		if (!result.ok) throw new Error(`unexpected draw failure: ${result.error}`);
		counts.set(result.modelId, (counts.get(result.modelId) ?? 0) + 1);
	}
	return counts;
}

function fraction(counts: Map<string, number>, modelId: string): number {
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	return total > 0 ? (counts.get(modelId) ?? 0) / total : 0;
}

console.log("--- draw distributions over 300 draws (weak-model hot streak, strong-model cold streak) ---");
distribution("review/frontier", frontier, candidates, 300);
distribution("review/basic", basic, candidates, 300);
distribution("review/scout", scout, candidates, 300);

// ---------------------------------------------------------------------------
// Issue #21 — rated pools are whitelist-only: evidence refines, never admits.
// ---------------------------------------------------------------------------

console.log("\n--- #21 rated pools are whitelist-only ---");

// Case 1 (the exact live failure shape): evidence on an unlisted model, a
// spec with no allowUnrated, and the model is excluded — not drawn as a
// long shot on its catalog cost.
const ghostPool = [candidate("ghost/unlisted-model", "ghost", 0.5), candidate("good/strong-model", "good", 15)];
const ghostOnly = drawForSpec(
	[candidate("ghost/unlisted-model", "ghost", 0.5)],
	config,
	overrides,
	ghostEvidence,
	frontier,
	"case1/ghost-only",
);
check(
	"case 1: evidence on an unlisted model is excluded from a rated pool",
	!ghostOnly.ok && ghostOnly.error.includes("unrated") && !ghostOnly.error.includes("cost floor"),
	ghostOnly.ok ? `it drew ${ghostOnly.modelId}` : `"${ghostOnly.error}"`,
);

// And it stays excluded over many draws, not just the first: the failure mode
// was a rare long shot winning the softmax dice.
const ghostDraws = share(frontier, ghostPool, 300, { evidence: ghostEvidence });
check(
	"case 1b: the unlisted model never wins across 300 rated draws",
	(ghostDraws.get("ghost/unlisted-model") ?? 0) === 0,
	[...ghostDraws.entries()].map(([m, n]) => `${m} ${n}`).join(", "),
);

// Case 2: allowUnrated still gambles — scouting is unchanged. An unknown's
// suitability comes from its (empty) score vector and cost alone, so it takes
// a real but minority share against a listed model's prior (~17% here, at the
// pool's temperature). The assertion is a floor well below that: the claim is
// "it can still draw", not a specific share.
const scoutGhost = share(
	{ ...scout, weights: { "reviewing-code": 1.0 } },
	ghostPool,
	400,
	{ evidence: ghostEvidence },
);
const scoutGhostShare = fraction(scoutGhost, "ghost/unlisted-model");
check(
	"case 2: the same model draws under allowUnrated (scout unchanged)",
	(ghostDraws.get("ghost/unlisted-model") ?? 0) === 0 && scoutGhostShare > 0.08,
	`rated ghost share 0%, scout ghost share ${(scoutGhostShare * 100).toFixed(1)}%`,
);

// Case 3: a listed model keeps drawing, with evidence refining its scores.
const refineDraws = share(frontier, [candidate("cheap/weak-model", "cheap", 0.25), candidate("good/strong-model", "good", 15)], 400);
check(
	"case 3: a listed model's evidence still refines its dimensions (hot streak beats the better prior)",
	fraction(refineDraws, "cheap/weak-model") > 0.6,
	`weak-model share ${(fraction(refineDraws, "cheap/weak-model") * 100).toFixed(1)}%`,
);

// Case 4: cost-only knowledge is not a rating. Both spellings — a models.yaml
// cost and a set_cost override — leave the model unrated.
const costOnly = drawForSpec([candidate("fresh/cost-only-model", "fresh", 2)], config, overrides, evidence, frontier, "case4/yaml-cost");
check(
	"case 4: a models.yaml cost-only model is excluded from rated pools",
	!costOnly.ok && costOnly.error.includes("unrated"),
	costOnly.ok ? `it drew ${costOnly.modelId}` : `"${costOnly.error}"`,
);

const overrideCostOnly: Overrides = {
	costs: new Map([["overonly/model", { cost: 0.9, setAt: "2026-01-01", reason: "smoke fixture" }]]),
	scores: new Map(),
};
const overrideResult = drawForSpec(
	[candidate("overonly/model", "overonly", 9)],
	config,
	overrideCostOnly,
	evidence,
	frontier,
	"case4/override-cost",
);
check(
	"case 4b: a set_cost-only model is excluded from rated pools",
	!overrideResult.ok && overrideResult.error.includes("unrated"),
	overrideResult.ok ? `it drew ${overrideResult.modelId}` : `"${overrideResult.error}"`,
);

// A score override alone is score signal — the user's words, not evidence.
const overrideScore: Overrides = {
	costs: new Map(),
	scores: new Map([["overonly/model", [{ dimension: "reviewing-code", value: 0.9, setAt: "2026-01-01" }]]]),
};
const overrideScoreDraw = drawForSpec([candidate("overonly/model", "overonly", 9)], config, overrideScore, evidence, frontier, "case4/override-score");
check(
	"case 4c: a score override alone makes a model rated",
	overrideScoreDraw.ok && overrideScoreDraw.modelId === "overonly/model",
	overrideScoreDraw.ok ? `drew ${overrideScoreDraw.modelId}` : overrideScoreDraw.error,
);

// --- Issue #20: the always-on cost penalty --------------------------------

console.log("\n--- #20 cost always factors into draws ---");

// Case 1: a spec with no cost weight, equal quality, cost 0.9 vs 0.4. The
// penalty makes the cheap one win more than half; lambda 0 restores today.
const costBlindSpec: SpecDef = { weights: { "reviewing-code": 1.0 }, temperature: 0.1 };
const tierPool = [candidate("cheap/tier-model", "cheap", 0.2), candidate("expensive/tier-model", "expensive", 20)];
const penalized = share(costBlindSpec, tierPool, 4000);
const unpenalized = share(costBlindSpec, tierPool, 4000, { config: withLambda(0) });
const penalizedShare = fraction(penalized, "cheap/tier-model");
const unpenalizedShare = fraction(unpenalized, "cheap/tier-model");
check(
	"case 1: a cost-blind spec still prefers the cheap model (>50%)",
	penalizedShare > 0.55,
	`cheap share ${(penalizedShare * 100).toFixed(1)}%`,
);
check(
	"case 1b: lambda 0 restores a 50/50 draw for equal-quality, unequal-cost models",
	Math.abs(unpenalizedShare - 0.5) < 0.025,
	`cheap share ${(unpenalizedShare * 100).toFixed(1)}%`,
);

// Case 2: equal cost scores keep their exact relative odds — the penalty is
// common to both, so it cancels in the softmax ratio.
const tiePool = [candidate("tie/a-model", "tie", 5), candidate("tie/b-model", "tie", 5)];
const tieSqueezed = fraction(share(costBlindSpec, tiePool, 3000), "tie/a-model");
const tiePlain = fraction(share(costBlindSpec, tiePool, 3000, { config: withLambda(0) }), "tie/a-model");
check(
	"case 2: equal-cost models keep their relative odds regardless of lambda",
	Math.abs(tieSqueezed - tiePlain) < 0.02,
	`a-model ${(tieSqueezed * 100).toFixed(1)}% at lambda 0.15 vs ${(tiePlain * 100).toFixed(1)}% at lambda 0`,
);

// --- Issue #20: minScores is a requirement --------------------------------

console.log("\n--- #20 minScores quality gates ---");

const gatedSpec: SpecDef = {
	weights: { "reviewing-code": 1.0 },
	temperature: 0.5,
	filters: { minScores: { "reviewing-code": 0.8 } },
};
const gatePool = [candidate("gated/low-model", "gated", 5), candidate("gated/high-model", "gated", 5)];
const gateDraws = share(gatedSpec, gatePool, 200);
check(
	"case 3: minScores excludes the below-bar model and passes the above-bar one",
	(gateDraws.get("gated/low-model") ?? 0) === 0 && (gateDraws.get("gated/high-model") ?? 0) === 200,
	[...gateDraws.entries()].map(([m, n]) => `${m} ${n}`).join(", "),
);

const gateEmpty = drawForSpec(
	gatePool,
	config,
	overrides,
	evidence,
	{ ...gatedSpec, filters: { minScores: { "reviewing-code": 0.99 } } },
	"case3/empty",
);
check(
	"case 3b: an empty gated pool names the gate and its threshold",
	!gateEmpty.ok && gateEmpty.error.includes("score floor") && gateEmpty.error.includes("reviewing-code >= 0.99"),
	gateEmpty.ok ? `it drew ${gateEmpty.modelId}` : `"${gateEmpty.error}"`,
);

// Case 4: an evidence-only model is gated on the posterior mean, and the
// gate is stable across draws at fixed evidence (no Thompson sample behind
// a requirement). a=8,b=1 -> mean 0.888...; a=2,b=8 -> mean 0.2.
const meanEvidence = new Map([["ghost/strong-posterior", new Map([["reviewing-code", { a: 8, b: 1 }]])]]);
const weakPosterior = new Map([["ghost/weak-posterior", new Map([["reviewing-code", { a: 2, b: 8 }]])]]);
const evidencePool = [candidate("ghost/strong-posterior", "ghost", 5)];
const evidenceWeakPool = [candidate("ghost/weak-posterior", "ghost", 5)];
const evidenceGate: SpecDef = {
	weights: { "reviewing-code": 1.0 },
	temperature: 0.5,
	filters: { allowUnrated: true, minScores: { "reviewing-code": 0.5 } },
};
let stablePasses = 0;
let stableFailures = 0;
for (let i = 0; i < 50; i++) {
	const pass = drawForSpec(evidencePool, config, overrides, meanEvidence, evidenceGate, "case4/strong");
	if (pass.ok) stablePasses += 1;
	const fail = drawForSpec(evidenceWeakPool, config, overrides, weakPosterior, evidenceGate, "case4/weak");
	if (!fail.ok) stableFailures += 1;
}
check(
	"case 4: an evidence-only model is gated on the posterior mean, stable across draws",
	stablePasses === 50 && stableFailures === 50,
	`strong posterior passed ${stablePasses}/50, weak posterior excluded ${stableFailures}/50`,
);

// Absence is not a rating: a gated dimension with no value anywhere fails
// closed, and the note says why.
const noValue = drawForSpec(
	[candidate("ghost/no-posterior", "ghost", 5)],
	config,
	overrides,
	new Map(),
	evidenceGate,
	"case4/no-value",
);
check(
	"case 4b: no score anywhere on a gated dimension fails closed, with a note",
	!noValue.ok && noValue.error.includes("score floor") && noValue.notes.some((n) => n.includes("no score on a gated dimension")),
	noValue.ok ? `it drew ${noValue.modelId}` : `"${noValue.error}"`,
);

// A candidate can fail one gated dimension for absence and another for a real
// bar. It must be counted once, under the concrete failure: a note claiming it
// was excluded for missing data would misdescribe a bar it failed on a score
// it did carry.
const mixedGate: SpecDef = {
	weights: { "reviewing-code": 1.0 },
	temperature: 0.5,
	filters: { minScores: { "absent-dim": 0.3, "reviewing-code": 0.99 } },
};
const mixed = drawForSpec(
	[candidate("gated/high-model", "gated", 5)],
	config,
	overrides,
	evidence,
	mixedGate,
	"case4/mixed-gate",
);
check(
	"a candidate failing a bar and missing another dimension is counted once, as below-bar",
	!mixed.ok &&
		mixed.notes.some((n) => n.includes("below a gated bar")) &&
		!mixed.notes.some((n) => n.includes("no score on a gated dimension")),
	mixed.notes.join(" | "),
);

// --- Spec frontmatter parsing of the new filters --------------------------

console.log("\n--- spec parsing ---");
const parseWarnings: Array<{ file: string; message: string }> = [];
const parsed = validateSpec(
	{
		weights: { "reviewing-code": 1 },
		filters: { minScores: { "reviewing-code": 0.75, cost: 0.4, broken: "high", "too-high": 1.5 } },
	},
	"smoke/spec",
	parseWarnings,
);
check(
	"minScores parses a valid per-dimension floor",
	parsed?.filters?.minScores?.["reviewing-code"] === 0.75,
	JSON.stringify(parsed?.filters?.minScores ?? null),
);
check(
	"minScores refuses `cost` with a pointer to minCostScore",
	parseWarnings.some((w) => w.message.includes("minCostScore")) && parsed?.filters?.minScores?.cost === undefined,
	parseWarnings.map((w) => w.message).join(" | "),
);
check(
	"minScores warns on and drops malformed floors",
	parseWarnings.some((w) => w.message.includes("minScores.broken")) &&
		parseWarnings.some((w) => w.message.includes("minScores.too-high")),
	`${parseWarnings.length} warning(s)`,
);

const badParse: Array<{ file: string; message: string }> = [];
validateSpec({ weights: { "reviewing-code": 1 }, filters: { minScores: [0.5] } }, "smoke/spec-bad", badParse);
check(
	"minScores that is not an object warns and is ignored",
	badParse.some((w) => w.message.includes("minScores must be an object")),
	badParse.map((w) => w.message).join(" | "),
);

// ---------------------------------------------------------------------------
// models.yaml `require` is a veto over the catalog's claimed input.
// ---------------------------------------------------------------------------

console.log("\n--- models.yaml require narrows the catalog input ---");

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

check(
	"require override, entry require [text] vs spec [image]: excluded",
	!vetoed.ok && vetoed.error.includes("input requirement image"),
	vetoed.ok ? `drew ${vetoed.modelId}` : "",
);
check(
	"require override, no entry, catalog [text,image] vs spec [image]: passes",
	catalogOnly.ok && catalogOnly.modelId === "plain/multimodal-model",
	catalogOnly.ok ? `drew ${catalogOnly.modelId}` : catalogOnly.error,
);
check(
	"require override, entry require [text,image] vs catalog [text]: excluded (a veto cannot grant)",
	!expanded.ok && expanded.error.includes("input requirement image"),
	expanded.ok ? "GRANTED" : "",
);

// A pool with no score signal anywhere still fails loudly.
const noScoreConfig: QuartermasterConfig = { ...config, models: new Map() };
const noScoreDraw: DrawResult = drawForSpec(candidates.slice(0, 3), noScoreConfig, overrides, new Map(), frontier, "no-scores");
check("a pool with no scores fails loudly", !noScoreDraw.ok && noScoreDraw.error.includes("unrated"), noScoreDraw.ok ? "" : `"${noScoreDraw.error}"`);

if (failures > 0) {
	console.error(`\n${failures} matcher assertion(s) failed`);
	process.exit(1);
}
console.log("\nall matcher assertions passed");
