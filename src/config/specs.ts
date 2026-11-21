/**
 * Specs (pools.jsonc conventionally named specs.jsonc): what the
 * quartermaster requests when it asks for equipment. A spec is a weight
 * vector over score dimensions plus selection knobs — temperature bounds
 * the chaos, filters set floors no draw ever crosses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonc } from "./jsonc.ts";
import { projectTeamDir, teamDir } from "./paths.ts";
import type { DiscoveryWarning } from "./agents.ts";

export interface SpecFilters {
	/** Input modalities a candidate must support: "text", "image". */
	require?: string[];
	/** Maximum cost score of a candidate (cost: 0-1, 1 = cheapest). */
	maxCostScore?: number;
}

export interface SpecDef {
	/** Dimension weights; suitability = dot product with a model's scores. */
	weights: Record<string, number>;
	/** Softmax temperature. 0 = deterministic best; higher = more chaos. */
	temperature: number;
	filters?: SpecFilters;
}

export function loadSpecs(cwd: string, warnings: DiscoveryWarning[]): Map<string, SpecDef> {
	const specs = new Map<string, SpecDef>();
	collectFile(path.join(teamDir(), "specs.jsonc"), specs, warnings);
	const project = projectTeamDir(cwd);
	if (project) collectFile(path.join(project, "specs.jsonc"), specs, warnings);
	return specs;
}

function collectFile(filePath: string, specs: Map<string, SpecDef>, warnings: DiscoveryWarning[]): void {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return; // absent file: normal empty state
	}

	let parsed: unknown;
	try {
		parsed = parseJsonc(raw);
	} catch (err) {
		warnings.push({ file: filePath, message: `invalid JSONC: ${String(err)}` });
		return;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push({ file: filePath, message: "expected an object of spec name -> definition" });
		return;
	}

	for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
		const spec = validateSpec(name, value, filePath, warnings);
		if (spec) specs.set(name, spec);
	}
}

function validateSpec(
	name: string,
	value: unknown,
	filePath: string,
	warnings: DiscoveryWarning[],
): SpecDef | null {
	if (typeof value !== "object" || value === null) {
		warnings.push({ file: filePath, message: `spec "${name}": definition must be an object — skipped` });
		return null;
	}
	const obj = value as Record<string, unknown>;

	const weightsRaw = obj.weights;
	if (typeof weightsRaw !== "object" || weightsRaw === null || Array.isArray(weightsRaw)) {
		warnings.push({ file: filePath, message: `spec "${name}": weights must be an object — skipped` });
		return null;
	}
	const weights: Record<string, number> = {};
	for (const [dim, w] of Object.entries(weightsRaw as Record<string, unknown>)) {
		if (typeof w !== "number" || !Number.isFinite(w)) {
			warnings.push({ file: filePath, message: `spec "${name}": weight for "${dim}" is not a number — skipped dimension` });
			continue;
		}
		weights[dim] = w;
	}
	if (Object.keys(weights).length === 0) {
		warnings.push({ file: filePath, message: `spec "${name}": no valid weights — skipped` });
		return null;
	}

	const temperature = obj.temperature;
	if (temperature !== undefined && (typeof temperature !== "number" || temperature < 0 || temperature > 5)) {
		warnings.push({
			file: filePath,
			message: `spec "${name}": temperature must be a number in [0, 5] — using 1`,
		});
	}

	const filters: SpecFilters = {};
	if (typeof obj.filters === "object" && obj.filters !== null && !Array.isArray(obj.filters)) {
		const f = obj.filters as Record<string, unknown>;
		if (Array.isArray(f.require)) {
			filters.require = f.require.filter((m): m is string => typeof m === "string");
		}
		if (typeof f.maxCostScore === "number" && Number.isFinite(f.maxCostScore)) {
			filters.maxCostScore = f.maxCostScore;
		}
	}

	return {
		weights,
		temperature: typeof temperature === "number" && temperature >= 0 && temperature <= 5 ? temperature : 1,
		filters: Object.keys(filters).length > 0 ? filters : undefined,
	};
}
