/**
 * Empirical verification of the evidence store's arithmetic — every
 * property the docblock claims, asserted with real numbers, so the
 * reviewer needs the assertions, not the algebra:
 *
 *   PI_CODING_AGENT_DIR=/tmp/qm-math npx tsx scripts/verify-math.ts
 *
 * Exits non-zero on any failure. Nothing here uses fixtures: the
 * store is created fresh in an isolated agent dir.
 */

process.env.PI_CODING_AGENT_DIR ??= "/tmp/qm-math-agent-dir";

import * as fs from "node:fs";
import { DEFAULT_MATCHING } from "../src/config/authority.ts";
import { evidenceMean, evidenceSample, loadEvidence, recordOutcome } from "../src/matching/evidence.ts";
import { costPenalty } from "../src/matching/matcher.ts";

fs.rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });

let failures = 0;
function check(name: string, got: number, want: number, tolerance: number): void {
	const ok = Math.abs(got - want) <= tolerance;
	console.log(`${ok ? "ok  " : "FAIL"} ${name}: got ${got.toFixed(4)}, want ${want.toFixed(4)} ± ${tolerance}`);
	if (!ok) failures += 1;
}

// --- Property 1: one 0.7 rating on a fresh model.
// Beta(1,1) prior + 0.7 -> a=1.7, b=1.3, mean = 1.7/3.
const store = loadEvidence();
recordOutcome(store, "fresh/model", "dim", 0.7, "single trial");
check("one 0.7 rating: posterior mean 1.7/3", evidenceMean(store, "fresh/model", "dim") ?? 0, 1.7 / 3, 0.0001);

// --- Property 2: counters only add — a 40-trial history absorbs a bad day.
for (let i = 0; i < 40; i++) recordOutcome(store, "stable/model", "dim", 0.95);
const beforeBad = evidenceMean(store, "stable/model", "dim") ?? 0;
recordOutcome(store, "stable/model", "dim", 0.0, "the bad day");
const afterBad = evidenceMean(store, "stable/model", "dim") ?? 0;
console.log(`ok   40 good trials: mean before bad day ${beforeBad.toFixed(4)}, after ${afterBad.toFixed(4)} (moved ${Math.abs(afterBad - beforeBad).toFixed(4)})`);
if (Math.abs(afterBad - beforeBad) > 0.03) {
	console.log("FAIL a single bad day must not move a stable model much");
	failures += 1;
}

// --- Property 3: weighted trials are fractional evidence.
recordOutcome(store, "weighted/model", "dim", 0.8, undefined, 0.5);
check("weight-0.5 trial: posterior mean 1.4/2.5", evidenceMean(store, "weighted/model", "dim") ?? 0, 1.4 / 2.5, 0.0001);
recordOutcome(store, "weighted/model", "dim", 0.8, undefined, 1.5);
check("a weight-1.5 trial moves 3x a weight-0.5 trial: mean (1.4+1.2)/(2.5+1.5)", evidenceMean(store, "weighted/model", "dim") ?? 0, 2.6 / 4, 0.0001);

// --- Property 4: Beta sampling is unbiased around the posterior mean.
// 20,000 samples of Beta(101, 101) should average ~0.50; Beta(181, 21) ~0.896.
const symStore = new Map([["s/model", new Map([["dim", { a: 101, b: 101 }]])]]);
const highStore = new Map([["s/model", new Map([["dim", { a: 181, b: 21 }]])]]);
let symSum = 0;
let highSum = 0;
const DRAWS = 20000;
for (let i = 0; i < DRAWS; i++) {
	symSum += evidenceSample(symStore, "s/model", "dim") ?? 0;
	highSum += evidenceSample(highStore, "s/model", "dim") ?? 0;
}
check(`Beta(101,101) sample mean ~0.5 over ${DRAWS} draws`, symSum / DRAWS, 0.5, 0.01);
check(`Beta(181,21) sample mean ~0.896 over ${DRAWS} draws`, highSum / DRAWS, 181 / 202, 0.01);

// --- Property 5: sampling spreads — the chaos the design wants.
// Beta(101,101) samples should rarely exceed 0.7; Beta(2,8) (a poorly-
// rated model with little evidence) should sometimes exceed 0.5 — the
// recovery path.
let symHigh = 0;
let lowHigh = 0;
const lowStore = new Map([["s/model", new Map([["dim", { a: 2, b: 8 }]])]]);
for (let i = 0; i < DRAWS; i++) {
	if ((evidenceSample(symStore, "s/model", "dim") ?? 0) > 0.7) symHigh += 1;
	if ((evidenceSample(lowStore, "s/model", "dim") ?? 0) > 0.5) lowHigh += 1;
}
console.log(`ok   well-evidenced model (mean 0.5, 100 trials): ${(symHigh / DRAWS * 100).toFixed(1)}% of samples above 0.7 (should be rare)`);
if (symHigh / DRAWS > 0.05) {
	console.log("FAIL well-evidenced model's samples are too wild");
	failures += 1;
}
// Beta(2,8): mean 0.2, but P(sample > 0.5) is genuinely ~2-3% —
// the recovery path is rare by design, not dead by accident.
console.log(`ok   down-scored model with little evidence: ${(lowHigh / DRAWS * 100).toFixed(1)}% of samples above 0.5 (should be rare but alive)`);
if (lowHigh / DRAWS < 0.01 || lowHigh / DRAWS > 0.15) {
	console.log("FAIL recovery-path frequency out of the expected 1-15% band");
	failures += 1;
}

// --- Property 6: the always-on cost penalty is additive, not multiplicative.
// suitability -= lambda * (1 - costScore), before the softmax. The claims the
// draw relies on: the cheapest is never penalized, the penalty is monotone in
// cost, it leaves equal-cost odds exactly alone (it cancels in the odds
// ratio), and lambda 0 changes nothing at all.
//
// Scope note: the odds identities below are algebraic — they hold the form,
// not the plumbing, because this script subtracts the penalty itself. That
// drawForSpec actually applies it, and that the cancellation survives the real
// softmax over real candidates, is smoke-matcher's job (its cost cases assert
// measured shares over thousands of draws). Cite both, never this alone, for
// end-to-end coverage.
const lambda = DEFAULT_MATCHING.costLambda;
check("cost penalty at cost 1 (cheapest) is 0", costPenalty(1, lambda), 0, 0.0000001);
check("cost penalty at cost 0 is lambda", costPenalty(0, lambda), lambda, 0.0000001);
check("cost penalty at cost 0.4 is 0.6*lambda", costPenalty(0.4, lambda), 0.6 * lambda, 0.0000001);
console.log(
	`ok   cost penalty is monotone: cost 0.9 -> ${costPenalty(0.9, lambda).toFixed(4)}, cost 0.4 -> ${costPenalty(0.4, lambda).toFixed(4)}`,
);
if (!(costPenalty(0.9, lambda) < costPenalty(0.4, lambda))) {
	console.log("FAIL the cost penalty must be lighter for the cheaper model");
	failures += 1;
}

// Odds of a over b under softmax at temperature tau. Equal-cost models take
// the same penalty, which must cancel: odds(a - p, b - p) === odds(a, b).
function odds(a: number, b: number, tau: number): number {
	return Math.exp((a - b) / tau);
}
const penalty = costPenalty(0.5, lambda);
check("equal-cost odds are exactly preserved at tau 1", odds(0.8 - penalty, 0.6 - penalty, 1), odds(0.8, 0.6, 1), 0.0000001);
check("equal-cost odds are exactly preserved at tau 0.1", odds(0.8 - penalty, 0.6 - penalty, 0.1), odds(0.8, 0.6, 0.1), 0.0000001);
// With equal quality, the penalty tilts the odds to whichever model is
// cheaper — the shift is exactly the penalty difference, not a rescaling.
const equalQuality = odds(0.8 - costPenalty(0.9, lambda), 0.8 - costPenalty(0.4, lambda), 0.1);
console.log(
	`ok   equal-quality, unequal-cost odds: ${equalQuality.toFixed(4)} at tau 0.1 (1 = a coin flip; >1 favours the cost-0.9 model)`,
);
if (!(equalQuality > 1)) {
	console.log("FAIL the penalty must favour the cheaper model at equal quality");
	failures += 1;
}
for (const cost of [0, 0.25, 0.5, 0.75, 1]) {
	if (Math.abs(costPenalty(cost, 0)) > 0.0000001) {
		console.log(`FAIL lambda 0 must leave cost ${cost} untouched, got ${costPenalty(cost, 0)}`);
		failures += 1;
	}
}
console.log("ok   lambda 0 leaves every cost score untouched (today's distribution)");

// --- Property 7: evidence refines the user's prior; it never replaces it.
// A score is k pseudo-trials of belief (default k from DEFAULT_MATCHING), and
// stored counts keep the legacy Beta(1,1) baseline, which anchoring swaps out
// at read time: mean = (observed_a + s*k) / (observed_total + k).
const k = DEFAULT_MATCHING.priorStrength;
for (const [name, prior] of [["opus", 0.9], ["sonnet", 0.75], ["haiku", 0.7]] as const) {
	// One maximal rating at weight 0.9 on a model the user scored.
	const st = new Map();
	recordOutcome(st, `anchor/${name}`, "dim", 1, undefined, 0.9);
	const mean = evidenceMean(st, `anchor/${name}`, "dim", { score: prior, strength: k }) ?? 0;
	check(`one maximal rating on prior ${prior}: mean (${prior}*k + 0.9)/(k + 0.9)`, mean, (prior * k + 0.9) / (k + 0.9), 0.0001);
	if (mean < prior) {
		console.log(`FAIL a maximal rating pulled ${name} below its prior`);
		failures += 1;
	}
}
// Distinct priors stay distinct after one trial each (the issue's flattening).
{
	const means = [0.9, 0.75, 0.8].map((score, i) => {
		const st = new Map();
		recordOutcome(st, `flat/${i}`, "dim", 0.9, undefined, 0.8);
		return evidenceMean(st, `flat/${i}`, "dim", { score, strength: k }) ?? 0;
	});
	const spread = Math.max(...means) - Math.min(...means);
	console.log(`ok   three priors 0.90/0.75/0.80 after one 0.9 rating: ${means.map((m) => m.toFixed(3)).join(" / ")} (spread ${spread.toFixed(3)})`);
	if (spread < 0.08) {
		console.log("FAIL one rating flattened distinct priors");
		failures += 1;
	}
}
// A maximal rating cannot invert a prior at any sensible strength.
for (const strength of [2, 4, 6, 8]) {
	const st = new Map();
	recordOutcome(st, "invert/model", "dim", 0, undefined, 1);
	const mean = evidenceMean(st, "invert/model", "dim", { score: 0.9, strength }) ?? 0;
	if (mean < 0.5) {
		console.log(`FAIL a single worst rating at k=${strength} dragged a 0.9 prior to ${mean.toFixed(3)}`);
		failures += 1;
	}
}
console.log("ok   a single worst rating never drags a 0.9 prior below 0.5 at k in 2..8");
// The prior fades: with lots of evidence the mean follows the evidence.
{
	const st = new Map();
	for (let i = 0; i < 60; i++) recordOutcome(st, "fade/model", "dim", 0.4);
	check("60 trials of 0.4 against a 0.9 prior: mean near the evidence", evidenceMean(st, "fade/model", "dim", { score: 0.9, strength: k }) ?? 0, (0.9 * k + 24) / (k + 60), 0.0001);
}
// Backwards compatible: no prior means the old Beta(1,1) arithmetic, unchanged;
// and legacy counts migrate at read time (observed mass survives, baseline swaps).
check("no prior: legacy Beta(1,1) mean unchanged", evidenceMean(store, "fresh/model", "dim") ?? 0, 1.7 / 3, 0.0001);
check("legacy counts re-anchored on read: (0.7 + 0.5*k)/(1 + k)", evidenceMean(store, "fresh/model", "dim", { score: 0.5, strength: k }) ?? 0, (0.7 + 0.5 * k) / (1 + k), 0.0001);
// k = 1 with the prior at 0.5 is exactly Beta(1,1): the old behaviour is a point on the dial.
check("k=1 at score 0.5 reproduces Beta(1,1)", evidenceMean(store, "fresh/model", "dim", { score: 0.5, strength: 2 }) ?? 0, 1.7 / 3, 0.0001);
// Sampling stays unbiased around the anchored mean.
{
	const st = new Map();
	recordOutcome(st, "s/model", "dim", 1, undefined, 0.9);
	const target = evidenceMean(st, "s/model", "dim", { score: 0.75, strength: k }) ?? 0;
	let sum = 0;
	for (let i = 0; i < DRAWS; i++) sum += evidenceSample(st, "s/model", "dim", { score: 0.75, strength: k }) ?? 0;
	check("anchored Beta sample mean matches the anchored posterior mean", sum / DRAWS, target, 0.01);
}

if (failures > 0) {
	console.error(`\n${failures} assertion(s) failed`);
	process.exit(1);
}
console.log("\nall arithmetic properties verified");
