/**
 * models.yaml: human-owned score priors and per-account cost reality.
 *
 * Cost is a 0-1 score (1 = cheapest), not dollars, because effective
 * costs are per-account — promotions, credits, plan deals are the
 * developer's reality, not the catalog's list price. The file is
 * human-owned: the engine never rewrites it. Durable facts recorded
 * through the tools land in overrides.yaml instead, and the matcher
 * joins catalog cost, this file, and overrides with that precedence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { projectTeamDir, teamDir } from "./paths.ts";
import type { DiscoveryWarning } from "./agents.ts";

export interface ModelEntry {
	/** Score priors by dimension, 0-1. */
	scores?: Record<string, number>;
	/** Cost score, 0-1, 1 = cheapest. Overrides the catalog list cost. */
	cost?: number;
	/** Input modality override; the pi catalog is ground truth, this is a veto. */
	require?: string[];
}

export function loadModels(cwd: string, warnings: DiscoveryWarning[]): Map<string, ModelEntry> {
	const models = new Map<string, ModelEntry>();
	collectFile(path.join(teamDir(), "models.yaml"), models, warnings);
	const project = projectTeamDir(cwd);
	if (project) collectFile(path.join(project, "models.yaml"), models, warnings);
	return models;
}

function collectFile(filePath: string, models: Map<string, ModelEntry>, warnings: DiscoveryWarning[]): void {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return;
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch (err) {
		warnings.push({ file: filePath, message: `invalid YAML: ${String(err)}` });
		return;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push({ file: filePath, message: "expected an object of model id -> entry" });
		return;
	}

	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			warnings.push({ file: filePath, message: `model "${id}": entry must be an object — skipped` });
			continue;
		}
		const entry: ModelEntry = {};
		const obj = value as Record<string, unknown>;

		if (typeof obj.scores === "object" && obj.scores !== null && !Array.isArray(obj.scores)) {
			const scores: Record<string, number> = {};
			for (const [dim, score] of Object.entries(obj.scores as Record<string, unknown>)) {
				if (typeof score === "number" && Number.isFinite(score)) {
					scores[dim] = Math.max(0, Math.min(1, score));
				} else {
					warnings.push({ file: filePath, message: `model "${id}": score for "${dim}" is not a number — skipped` });
				}
			}
			if (Object.keys(scores).length > 0) entry.scores = scores;
		}

		if (typeof obj.cost === "number" && Number.isFinite(obj.cost)) {
			entry.cost = Math.max(0, Math.min(1, obj.cost));
		}

		if (Array.isArray(obj.require)) {
			const require = obj.require.filter((m): m is string => typeof m === "string");
			if (require.length > 0) entry.require = require;
		}

		models.set(id, entry);
	}
}
