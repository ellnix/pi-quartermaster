/**
 * The evidence store: Thompson posteriors per (model, dimension).
 *
 * Ratings are outcome-shaped (0-1 per trial), so a single bad day moves a
 * model a little and a pattern moves it a lot — Beta pseudo-counts carry
 * that naturally. Down-scored models are still drawn occasionally: the
 * sampling itself is the recovery path for wrongly-down-scored models.
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

/** Posterior mean of a model's score on a dimension, or undefined. */
export function evidenceMean(store: EvidenceStore, model: string, dimension: string): number | undefined {
	const counts = store.get(model)?.get(dimension);
	if (!counts) return undefined;
	const total = counts.a + counts.b;
	if (total <= 0) return undefined;
	return counts.a / total;
}

/** Thompson sample of a model's score on a dimension, or undefined. */
export function evidenceSample(store: EvidenceStore, model: string, dimension: string): number | undefined {
	const counts = store.get(model)?.get(dimension);
	if (!counts) return undefined;
	return sampleBeta(counts.a, counts.b);
}

/** Record an outcome (0-1) on a dimension; fractional outcomes allowed. */
export function recordOutcome(
	store: EvidenceStore,
	model: string,
	dimension: string,
	outcome: number,
	note?: string,
): void {
	let dims = store.get(model);
	if (!dims) {
		dims = new Map();
		store.set(model, dims);
	}
	// Start at Beta(1, 1): one prior trial of "unknown quality" so the
	// first real rating cannot run away with the estimate alone.
	const counts = dims.get(dimension) ?? { a: 1, b: 1 };
	counts.a += Math.max(0, Math.min(1, outcome));
	counts.b += 1 - Math.max(0, Math.min(1, outcome));
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
