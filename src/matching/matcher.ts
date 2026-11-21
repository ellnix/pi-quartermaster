/**
 * The matcher: filter, then draw.
 *
 * One draw per convened session — never per message. Selection is
 * two-layer chaos with a floor: every candidate's score on a dimension
 * is a Thompson sample from its evidence posterior when evidence exists
 * (the prior otherwise), then the softmax over suitabilities at the
 * spec's temperature decides. Hard filters — auth, capability, cost
 * floor, score floor — are crossed by nothing. Unknown models are
 * "unrated": filtered out unless the spec explicitly allows them, so a
 * cheap spec can scout new arrivals while a frontier spec never gambles
 * on them.
 *
 * Two invariants worth stating outright, because each was once wrong:
 *
 * - **models.yaml and overrides are the spend whitelist.** A model is
 *   rated only when the user gave it score signal; evidence refines a
 *   listed model's dimensions but never admits an unlisted one. The
 *   pool for a spec without `allowUnrated` is exactly the set of models
 *   the user paid attention to.
 * - **Cost always penalizes the draw.** Suitability loses
 *   `lambda * (1 - costScore)` before the softmax, independently of the
 *   spec's weights. A model's total cost influence is therefore the spec
 *   weight's cost term plus this fixed penalty; because the penalty is a
 *   subtraction it cancels exactly in the odds between equal-cost models,
 *   so their relative odds hold at any lambda and any temperature.
 */

import type { ModelEntry, QuartermasterConfig, SpecDef } from "../config/index.ts";
import { evidenceMean, evidenceSample, type EvidenceStore } from "./evidence.ts";
import type { Overrides } from "./overrides.ts";

/** What the matcher needs to know about a candidate. */
export interface Candidate {
	modelId: string;
	name: string;
	provider: string;
	/** Input modalities: "text", "image". */
	input: string[];
	/** Catalog list cost, USD per million input tokens. */
	catalogCostPerMtok: number;
	hasAuth: boolean;
}

export interface DrawSuccess {
	ok: true;
	modelId: string;
	source: "pin" | "draw";
	suitability: number;
	notes: string[];
}

export interface DrawFailure {
	ok: false;
	error: string;
	notes: string[];
}

export type DrawResult = DrawSuccess | DrawFailure;

export function drawForSpec(
	candidates: Candidate[],
	config: QuartermasterConfig,
	overrides: Overrides,
	evidence: EvidenceStore,
	spec: SpecDef,
	specName: string,
): DrawResult {
	const notes: string[] = [];
	const withAuth = candidates.filter((c) => c.hasAuth);
	if (withAuth.length === 0) {
		return { ok: false, error: "no candidate models have configured auth", notes };
	}

	// Catalog-derived default cost score: log-scale among candidates,
	// 1 = cheapest. Only used when neither overrides nor models.yaml
	// speak for a model — the user's reality always wins.
	const catalogCosts = withAuth.map((c) => Math.max(0.01, c.catalogCostPerMtok));
	const logMin = Math.log(Math.min(...catalogCosts));
	const logMax = Math.log(Math.max(...catalogCosts));

	const lambda = config.authority.matching.costLambda;

	const pool = withAuth.map((candidate) => {
		const entry = config.models.get(candidate.modelId);
		const costOverride = overrides.costs.get(candidate.modelId) ?? overrides.costs.get(`provider/${candidate.provider}`);
		const costScore =
			costOverride?.cost ??
			entry?.cost ??
			(logMax > logMin ? 1 - (Math.log(Math.max(0.01, candidate.catalogCostPerMtok)) - logMin) / (logMax - logMin) : 1);

		const rated = hasScoreSignal(entry, overrides, candidate.modelId);
		const dims = scoreDimensions(candidate.modelId, entry, overrides, evidence);
		// Cost's total influence is the weights' cost term plus this fixed
		// penalty: additive, so it cannot skew models of equal cost against each
		// other and it still bites at temperature 0, where a multiplicative
		// factor on suitability would compress the gaps instead of shifting them.
		const suitability = dot(spec.weights, dims, costScore) - costPenalty(costScore, lambda);
		// models.yaml `require` is a veto, not a grant: effective input is the
		// catalog's list intersected with it. It can remove a modality the
		// catalog claims, never add one the catalog omits.
		const input = entry?.require
			? candidate.input.filter((m) => entry.require!.includes(m))
			: candidate.input;
		return { candidate, entry, input, costScore, dims, suitability, rated };
	});

	let eligible = pool;
	if (spec.filters?.require) {
		eligible = eligible.filter((p) => spec.filters!.require!.every((m) => p.input.includes(m)));
		if (eligible.length === 0) {
			return { ok: false, error: `no authenticated model satisfies input requirement ${spec.filters!.require!.join("+")}`, notes };
		}
	}
	if (spec.filters?.minCostScore !== undefined) {
		const before = eligible.length;
		eligible = eligible.filter((p) => p.costScore >= spec.filters!.minCostScore!);
		if (eligible.length === 0) {
			return { ok: false, error: `no model meets the cost floor (cost score >= ${spec.filters!.minCostScore})`, notes };
		}
		if (before > eligible.length) {
			notes.push(`cost floor filtered ${before - eligible.length} candidate(s)`);
		}
	}
	if (!specAllowsUnrated(spec)) {
		const before = eligible.length;
		eligible = eligible.filter((p) => p.rated);
		if (eligible.length === 0) {
			return {
				ok: false,
				error: "every candidate is unrated (no scores in models.yaml or overrides; evidence refines, it never admits) — score them or set allowUnrated on the spec",
				notes,
			};
		}
		if (before > eligible.length) {
			notes.push(`${before - eligible.length} unrated candidate(s) excluded — set allowUnrated to scout new models`);
		}
	}
	const scoreGate = spec.filters?.minScores;
	if (scoreGate && Object.keys(scoreGate).length > 0) {
		const before = eligible.length;
		let unknown = 0;
		eligible = eligible.filter((p) => {
			const gated = scoreGateAbove(p.candidate.modelId, p.entry, scoreGate, overrides, evidence);
			if (!gated.known) unknown += 1;
			return gated.passes;
		});
		if (before > eligible.length) {
			notes.push(`score floor filtered ${before - eligible.length} candidate(s)`);
		}
		if (unknown > 0) {
			notes.push(
				`score floor excluded ${unknown} candidate(s) with no score on a gated dimension — a requirement is met by evidence, not by absence`,
			);
		}
		if (eligible.length === 0) {
			const gates = Object.entries(scoreGate)
				.map(([dim, floor]) => `${dim} >= ${floor}`)
				.join(", ");
			return { ok: false, error: `no model meets the score floor (${gates})`, notes };
		}
	}

	if (eligible.length === 0) {
		return { ok: false, error: "empty candidate pool", notes };
	}

	const chosen = softmaxDraw(eligible.map((p) => ({ id: p.candidate.modelId, suitability: p.suitability })), spec.temperature);
	const winner = eligible.find((p) => p.candidate.modelId === chosen.id)!;
	return {
		ok: true,
		modelId: winner.candidate.modelId,
		source: "draw",
		suitability: round(winner.suitability),
		notes,
	};
}

function specAllowsUnrated(spec: SpecDef): boolean {
	return Boolean(spec.filters?.allowUnrated);
}

/**
 * Whether a model carries score signal — the spend whitelist test.
 *
 * Only the user's own words count: a `models.yaml` entry with scores, or a
 * score override. Evidence deliberately does not: it accumulates from smoke
 * checks and `allowUnrated` scout gambles, so counting it as a rating let an
 * unlisted model into a rated pool the user never authorized — and, because
 * `scoreDimensions` seeds dimensions only from the files, that admission
 * contributed nothing to suitability.
 */
function hasScoreSignal(
	entry: ModelEntry | undefined,
	overrides: Overrides,
	modelId: string,
): boolean {
	if (entry?.scores && Object.keys(entry.scores).length > 0) return true;
	if (overrides.scores.has(modelId)) return true;
	return false;
}

/**
 * The always-on cost penalty: cheaper is better, structurally.
 *
 * An additive subtraction before the softmax — the model's total cost
 * influence is the spec weight's cost term plus `lambda * (1 - costScore)`.
 * Additive rather than multiplicative because multiplying suitability by
 * `1 - lambda * (1 - costScore)` shrinks the gaps between equal-cost models
 * too: it changes their odds instead of leaving them alone. A subtraction
 * cancels exactly in the odds ratio, and it keeps cost active at temperature
 * 0, where the draw is deterministic. `lambda` of 0 reproduces the
 * distribution that predates this penalty; 1 (cheapest) is never penalized.
 */
export function costPenalty(costScore: number, lambda: number): number {
	return lambda * (1 - costScore);
}

/**
 * Evaluate a candidate against the spec's score floor.
 *
 * The stack is the deterministic one — overrides beat models.yaml, and where
 * neither speaks the evidence posterior mean applies. Never the Thompson
 * sample: requirements are stable, chaos lives in the softmax draw. A
 * dimension with no value anywhere fails the gate, because absence is not a
 * rating; `known: false` lets the caller say so in a note.
 */
function scoreGateAbove(
	modelId: string,
	entry: ModelEntry | undefined,
	gate: Record<string, number>,
	overrides: Overrides,
	evidence: EvidenceStore,
): { passes: boolean; known: boolean } {
	let known = true;
	for (const [dimension, floor] of Object.entries(gate)) {
		const value = deterministicScore(modelId, entry, overrides, evidence, dimension);
		if (value === undefined) {
			known = false;
			continue;
		}
		if (value < floor) return { passes: false, known };
	}
	return { passes: known, known };
}

/** The deterministic score stack: override, then models.yaml, then posterior mean. */
function deterministicScore(
	modelId: string,
	entry: ModelEntry | undefined,
	overrides: Overrides,
	evidence: EvidenceStore,
	dimension: string,
): number | undefined {
	let overridden: number | undefined;
	for (const o of overrides.scores.get(modelId) ?? []) {
		if (o.dimension === dimension) overridden = o.value;
	}
	if (overridden !== undefined) return overridden;
	const listed = entry?.scores?.[dimension];
	if (listed !== undefined) return listed;
	return evidenceMean(evidence, modelId, dimension);
}

/**
 * Effective score per dimension: overrides beat models.yaml, which beats
 * a Thompson sample of the evidence posterior. Missing dimensions score 0.
 */
function scoreDimensions(
	modelId: string,
	entry: ModelEntry | undefined,
	overrides: Overrides,
	evidence: EvidenceStore,
): Map<string, number> {
	const dims = new Map<string, number>();
	for (const [dim, value] of Object.entries(entry?.scores ?? {})) {
		dims.set(dim, value);
	}
	for (const o of overrides.scores.get(modelId) ?? []) {
		dims.set(o.dimension, o.value);
	}
	for (const [dim] of dims) {
		const sample = evidenceSample(evidence, modelId, dim);
		if (sample !== undefined) dims.set(dim, sample);
	}
	return dims;
}

function dot(weights: Record<string, number>, dims: Map<string, number>, costScore: number): number {
	let sum = 0;
	for (const [dim, weight] of Object.entries(weights)) {
		if (dim === "cost") {
			sum += weight * costScore;
		} else {
			sum += weight * (dims.get(dim) ?? 0);
		}
	}
	return sum;
}

function softmaxDraw(items: Array<{ id: string; suitability: number }>, temperature: number): { id: string } {
	if (temperature <= 0) {
		return items.reduce((best, item) => (item.suitability > best.suitability ? item : best), items[0]);
	}
	const max = Math.max(...items.map((i) => i.suitability));
	const weights = items.map((i) => Math.exp((i.suitability - max) / temperature));
	const total = weights.reduce((a, b) => a + b, 0);
	let roll = Math.random() * total;
	for (let i = 0; i < items.length; i++) {
		roll -= weights[i];
		if (roll <= 0) return items[i];
	}
	return items[items.length - 1];
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
