/**
 * The matcher: filter, then draw.
 *
 * One draw per convened session — never per message. Selection is
 * two-layer chaos with a floor: every candidate's score on a dimension
 * is a Thompson sample from its evidence posterior when evidence exists
 * (the prior otherwise), then the softmax over suitabilities at the
 * spec's temperature decides. Hard filters — auth, capability, cost
 * floor — are crossed by nothing. Unknown models are "unrated": filtered
 * out unless the spec explicitly allows them, so a cheap spec can scout
 * new arrivals while a frontier spec never gambles on them.
 */

import type { ModelEntry, QuartermasterConfig, SpecDef } from "../config/index.ts";
import { evidenceSample, type EvidenceStore } from "./evidence.ts";
import type { OverridesFile } from "./overrides.ts";

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
	overrides: OverridesFile,
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

	const pool = withAuth.map((candidate) => {
		const entry = config.models.get(candidate.modelId);
		const costOverride = overrides.costs.get(candidate.modelId) ?? overrides.costs.get(`provider/${candidate.provider}`);
		const costScore =
			costOverride?.cost ??
			entry?.cost ??
			(logMax > logMin ? 1 - (Math.log(Math.max(0.01, candidate.catalogCostPerMtok)) - logMin) / (logMax - logMin) : 1);

		const rated = hasAnySignal(entry, overrides, evidence, candidate.modelId);
		const dims = scoreDimensions(candidate.modelId, entry, overrides, evidence);
		const suitability = dot(spec.weights, dims, costScore);
		return { candidate, costScore, dims, suitability, rated };
	});

	let eligible = pool;
	if (spec.filters?.require) {
		eligible = eligible.filter((p) => spec.filters!.require!.every((m) => p.candidate.input.includes(m)));
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
				error: "every candidate is unrated (no scores in models.yaml, overrides, or evidence) — score them or set allowUnrated on the spec",
				notes,
			};
		}
		if (before > eligible.length) {
			notes.push(`${before - eligible.length} unrated candidate(s) excluded — set allowUnrated to scout new models`);
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

function hasAnySignal(entry: ModelEntry | undefined, overrides: OverridesFile, evidence: EvidenceStore, modelId: string): boolean {
	if (entry?.scores && Object.keys(entry.scores).length > 0) return true;
	if (overrides.scores.has(modelId)) return true;
	if ((evidence.get(modelId)?.size ?? 0) > 0) return true;
	return false;
}

/**
 * Effective score per dimension: overrides beat models.yaml, which beats
 * a Thompson sample of the evidence posterior. Missing dimensions score 0.
 */
function scoreDimensions(
	modelId: string,
	entry: ModelEntry | undefined,
	overrides: OverridesFile,
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
