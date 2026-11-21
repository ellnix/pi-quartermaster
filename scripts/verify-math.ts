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
import { evidenceMean, evidenceSample, loadEvidence, recordOutcome } from "../src/matching/evidence.ts";

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

if (failures > 0) {
	console.error(`\n${failures} assertion(s) failed`);
	process.exit(1);
}
console.log("\nall arithmetic properties verified");
