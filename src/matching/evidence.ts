/**
 * The evidence store: Thompson posteriors per (model, dimension).
 *
 * The statistics, in plain language:
 *
 * - Anchoring: the Beta(1,1) in the next paragraphs is the story for a
 *   dimension the user never scored. When they did score it (models.yaml
 *   or an override), that score is the prior: k pseudo-trials of belief
 *   (`matching.priorStrength`, or `prior_strength` per model), so one
 *   rating moves the estimate but cannot invert a considered prior, and
 *   its influence fades as real evidence accrues. See `Prior`.
 * - Each (model, dimension) pair keeps two counters, a and b. Think of
 *   a as "accumulated quality" and b as "accumulated shortfall": a
 *   rating of 0.7 adds 0.7 to a and 0.3 to b; a rating of 0 adds 1 to b.
 * - The pair (a, b) defines a Beta distribution — the standard way to
 *   express "here is a belief about an unknown fraction, given this much
 *   evidence." Its mean is a / (a + b): after a Beta(1,1) prior (one
 *   pseudo-trial of "unknown quality") and a single 0.7 rating, the
 *   mean is 1.7 / 3 ≈ 0.567. Fractions are fine: a weighted trial just
 *   adds fractions to both counters, so a weight-0.6 rating moves the
 *   belief 60% as much as a full one.
 * - Why one bad day moves a model a little: counters only add. A model
 *   with 40 good trials has a ≈ 39; one bad trial moves its mean from
 *   ~0.95 to ~0.93, while the first trial ever recorded moves a fresh
 *   model from 0.5 to 0.7. Early evidence is loud; old evidence is
 *   stable — exactly the behavior a rating system should have.
 * - "Thompson sampling" is the draw rule: instead of comparing the
 *   means, each candidate SAMPLES its own Beta and the draw compares
 *   the samples. A model rated 0.9 sometimes samples 0.7; a model
 *   rated 0.6 sometimes samples 0.85. So a down-scored model still
 *   wins occasionally — the recovery path for wrongly-down-scored
 *   models is built into the arithmetic, not bolted on as policy.
 *
 * scripts/verify-math.ts asserts every property above empirically —
 * review the assertions, not the algebra.
 *
 * Machine-owned: this file is rewritten freely by the engine. Human
 * priors live in models.yaml; durable facts in overrides.yaml.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { teamDir } from "../config/paths.ts";

export interface BetaCounts {
	a: number;
	b: number;
}

export type EvidenceStore = Map<string, Map<string, BetaCounts>>;

const EVIDENCE_FILE = () => path.join(teamDir(), "evidence.json");
const EVIDENCE_LOG = () => path.join(teamDir(), "evidence-log.jsonl");

export function loadEvidence(): EvidenceStore {
	const store: EvidenceStore = new Map();
	let raw: string;
	try {
		raw = fs.readFileSync(EVIDENCE_FILE(), "utf8");
	} catch {
		return store;
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, Record<string, BetaCounts>>;
		for (const [model, dims] of Object.entries(parsed)) {
			const dimMap = new Map<string, BetaCounts>();
			for (const [dim, counts] of Object.entries(dims)) {
				if (typeof counts?.a === "number" && typeof counts?.b === "number") {
					dimMap.set(dim, { a: counts.a, b: counts.b });
				}
			}
			store.set(model, dimMap);
		}
	} catch {
		// Machine-owned file: unreadable means start fresh rather than fail.
	}
	return store;
}

export function saveEvidence(store: EvidenceStore): void {
	const out: Record<string, Record<string, BetaCounts>> = {};
	for (const [model, dims] of store) {
		const dimObj: Record<string, BetaCounts> = {};
		for (const [dim, counts] of dims) dimObj[dim] = counts;
		out[model] = dimObj;
	}
	fs.mkdirSync(teamDir(), { recursive: true });
	const tmp = `${EVIDENCE_FILE()}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(out, null, "\t") + "\n");
	fs.renameSync(tmp, EVIDENCE_FILE());
}

/**
 * The user's own score for a dimension, carried as pseudo-trials: `score`
 * is what they believe, `strength` (k) is how many trials that belief is
 * worth. Evidence refines it; it never replaces it.
 */
export interface Prior {
	score: number;
	strength: number;
}

/**
 * The effective Beta for a stored count pair. Stored counts always carry the
 * legacy Beta(1,1) baseline (two pseudo-trials of "unknown"), so observed
 * mass is `counts - (1, 1)`. With a prior, the baseline is swapped for the
 * user's belief: a = observed_a + score*k, b = observed_b + (1-score)*k.
 * That is also the migration for evidence recorded before priors anchored
 * anything, done at read time: no stored data changes, and editing a score
 * or k takes effect on the next draw. Without a prior (a dimension the user
 * never scored) the baseline stays, exactly as before.
 */
function effective(counts: BetaCounts, prior?: Prior): BetaCounts {
	if (!prior) return counts;
	return {
		a: counts.a - 1 + prior.score * prior.strength,
		b: counts.b - 1 + (1 - prior.score) * prior.strength,
	};
}

/** Posterior mean of a model's score on a dimension, or undefined. */
export function evidenceMean(store: EvidenceStore, model: string, dimension: string, prior?: Prior): number | undefined {
	const stored = store.get(model)?.get(dimension);
	if (!stored) return undefined;
	const counts = effective(stored, prior);
	const total = counts.a + counts.b;
	if (total <= 0) return undefined;
	return counts.a / total;
}

/** Thompson sample of a model's score on a dimension, or undefined. */
export function evidenceSample(store: EvidenceStore, model: string, dimension: string, prior?: Prior): number | undefined {
	const stored = store.get(model)?.get(dimension);
	if (!stored) return undefined;
	const counts = effective(stored, prior);
	return sampleBeta(counts.a, counts.b);
}

/**
 * Record an outcome (0-1) on a dimension; fractional outcomes allowed.
 * weight multiplies the trial mass: a spec that weights a dimension
 * 0.6 records 0.6 of a trial, so strongly-weighted dimensions move
 * faster under the same evidence.
 */
export function recordOutcome(
	store: EvidenceStore,
	model: string,
	dimension: string,
	outcome: number,
	note?: string,
	weight = 1,
): void {
	let dims = store.get(model);
	if (!dims) {
		dims = new Map();
		store.set(model, dims);
	}
	// Start at Beta(1, 1): one prior trial of "unknown quality" so the
	// first real rating cannot run away with the estimate alone.
	const counts = dims.get(dimension) ?? { a: 1, b: 1 };
	const clamped = Math.max(0, Math.min(1, outcome));
	counts.a += clamped * weight;
	counts.b += (1 - clamped) * weight;
	dims.set(dimension, counts);
	saveEvidence(store);

	try {
		fs.mkdirSync(teamDir(), { recursive: true });
		fs.appendFileSync(
			EVIDENCE_LOG(),
			JSON.stringify({ ts: Date.now(), model, dimension, outcome, note: note ?? null }) + "\n",
		);
	} catch {
		// The log is provenance, not state: append failures must not fail the rating.
	}
}

/** Marsaglia-Tsang gamma sampling; Beta via two gammas. */
function sampleBeta(a: number, b: number): number {
	const x = sampleGamma(a);
	const y = sampleGamma(b);
	const total = x + y;
	return total > 0 ? x / total : 0.5;
}

function sampleGamma(shape: number): number {
	if (shape < 1) {
		return sampleGamma(1 + shape) * Math.pow(Math.random(), 1 / shape);
	}
	const d = shape - 1 / 3;
	const c = 1 / Math.sqrt(9 * d);
	for (;;) {
		let x: number;
		let v: number;
		do {
			x = gaussStandard();
			v = 1 + c * x;
		} while (v <= 0);
		v = v * v * v;
		const u = Math.random();
		if (u < 1 - 0.0331 * x * x * x * x) return d * v;
		if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
	}
}

function gaussStandard(): number {
	let u = 0;
	let v = 0;
	while (u === 0) u = Math.random();
	while (v === 0) v = Math.random();
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
