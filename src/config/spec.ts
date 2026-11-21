/**
 * Spec shape: what an agent's frontmatter carries inline, and what the
 * quartermaster builds on the fly at convene. There is no specs file —
 * reusable specs are attached to agent definitions, overrides are built
 * where they are used, and this module is the single definition of the
 * shape both places produce.
 */

export interface SpecFilters {
	/** Input modalities a candidate must support: "text", "image". */
	require?: string[];
	/** Minimum cost score of a candidate (cost: 0-1, 1 = cheapest). */
	minCostScore?: number;
	/** Let unrated models (no scores anywhere) into the pool. Default false. */
	allowUnrated?: boolean;
}

export interface SpecDef {
	/** Dimension weights; suitability = dot product with a model's scores. */
	weights: Record<string, number>;
	/** Softmax temperature. 0 = deterministic best; higher = more chaos. */
	temperature: number;
	filters?: SpecFilters;
}

/**
 * Validate a raw frontmatter/convene value as a spec. Returns the
 * normalized spec, or null with a reason pushed to warnings — the
 * caller decides whether a null spec skips the agent or fails a member.
 */
export function validateSpec(
	value: unknown,
	context: string,
	warnings: Array<{ file: string; message: string }>,
): SpecDef | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		warnings.push({ file: context, message: "spec must be an object — ignored" });
		return null;
	}
	const obj = value as Record<string, unknown>;

	const weightsRaw = obj.weights;
	if (typeof weightsRaw !== "object" || weightsRaw === null || Array.isArray(weightsRaw)) {
		warnings.push({ file: context, message: "spec.weights must be an object — spec ignored" });
		return null;
	}
	const weights: Record<string, number> = {};
	for (const [dim, w] of Object.entries(weightsRaw as Record<string, unknown>)) {
		if (typeof w !== "number" || !Number.isFinite(w)) {
			warnings.push({ file: context, message: `spec weight for "${dim}" is not a number — skipped dimension` });
			continue;
		}
		weights[dim] = w;
	}
	if (Object.keys(weights).length === 0) {
		warnings.push({ file: context, message: "spec has no valid weights — spec ignored" });
		return null;
	}

	let temperature = 1;
	if (obj.temperature !== undefined) {
		if (typeof obj.temperature !== "number" || obj.temperature < 0 || obj.temperature > 5) {
			warnings.push({ file: context, message: "spec.temperature must be a number in [0, 5] — using 1" });
		} else {
			temperature = obj.temperature;
		}
	}

	const filters: SpecFilters = {};
	if (typeof obj.filters === "object" && obj.filters !== null && !Array.isArray(obj.filters)) {
		const f = obj.filters as Record<string, unknown>;
		if (Array.isArray(f.require)) {
			filters.require = f.require.filter((m): m is string => typeof m === "string");
		}
		if (typeof f.minCostScore === "number" && Number.isFinite(f.minCostScore)) {
			filters.minCostScore = f.minCostScore;
		}
		if (typeof f.allowUnrated === "boolean") {
			filters.allowUnrated = f.allowUnrated;
		}
	}

	return {
		weights,
		temperature,
		filters: Object.keys(filters).length > 0 ? filters : undefined,
	};
}
