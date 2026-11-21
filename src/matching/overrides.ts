/**
 * overrides.yaml: machine-owned durable facts, written by set_cost and
 * set_override with provenance.
 *
 * Provenance travels twice: as comments for humans reading the file, and
 * as underscore fields for the parser — because this file is re-serialized
 * from memory on every update, and comments alone would not survive the
 * round-trip. models.yaml (human-owned) is never touched by the engine;
 * this file is the engine's half of the configuration.
 *
 * Precedence everywhere: overrides beat models.yaml, which beats
 * evidence, which beats catalog-derived defaults.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import { teamDir } from "../config/paths.ts";

export interface CostOverride {
	cost: number;
	reason?: string;
	setAt: string;
}

export interface ScoreOverride {
	dimension: string;
	value: number;
	reason?: string;
	setAt: string;
}

export interface OverridesFile {
	/** By model id, and by "provider/<id>" for provider-wide cost facts. */
	costs: Map<string, CostOverride>;
	/** By model id. */
	scores: Map<string, ScoreOverride[]>;
}

const OVERRIDES_FILE = () => path.join(teamDir(), "overrides.yaml");

export function loadOverrides(): OverridesFile {
	const file: OverridesFile = { costs: new Map(), scores: new Map() };
	let raw: string;
	try {
		raw = fs.readFileSync(OVERRIDES_FILE(), "utf8");
	} catch {
		return file;
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(raw);
	} catch {
		return file; // machine-owned: unreadable means empty, not fatal
	}
	if (typeof parsed !== "object" || parsed === null) return file;

	for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "object" || value === null) continue;
		const obj = value as Record<string, unknown>;

		if (typeof obj.cost === "number" && Number.isFinite(obj.cost)) {
			file.costs.set(id, {
				cost: obj.cost,
				reason: typeof obj._reason === "string" ? obj._reason : undefined,
				setAt: typeof obj._set_at === "string" ? obj._set_at : "",
			});
		}

		if (typeof obj.scores === "object" && obj.scores !== null && !Array.isArray(obj.scores)) {
			const list: ScoreOverride[] = [];
			for (const [dim, v] of Object.entries(obj.scores as Record<string, unknown>)) {
				if (typeof v === "number" && Number.isFinite(v)) {
					list.push({
						dimension: dim,
						value: v,
						reason: typeof obj[`_${dim}-reason`] === "string" ? (obj[`_${dim}-reason`] as string) : undefined,
						setAt: typeof obj[`_${dim}-set-at`] === "string" ? (obj[`_${dim}-set-at`] as string) : "",
					});
				}
			}
			if (list.length > 0) file.scores.set(id, list);
		}
	}
	return file;
}

export function setCostOverride(overrides: OverridesFile, target: string, cost: number, reason?: string): void {
	overrides.costs.set(target, { cost, reason, setAt: new Date().toISOString().slice(0, 10) });
	saveOverrides(overrides);
}

export function setScoreOverride(
	overrides: OverridesFile,
	model: string,
	dimension: string,
	value: number,
	reason?: string,
): void {
	const existing = (overrides.scores.get(model) ?? []).filter((o) => o.dimension !== dimension);
	existing.push({ dimension, value, reason, setAt: new Date().toISOString().slice(0, 10) });
	overrides.scores.set(model, existing);
	saveOverrides(overrides);
}

/**
 * Serialize with provenance on both channels: the comment is the human
 * reading, the underscore field is what survives the next rewrite.
 */
function saveOverrides(overrides: OverridesFile): void {
	const lines: string[] = [
		"# Quartermaster overrides — machine-managed. Written by set_cost and",
		"# set_override with their provenance. Human priors belong in models.yaml;",
		"# this file may be rewritten by the engine at any time.",
	];

	const seen = new Set<string>();
	for (const [target, cost] of overrides.costs) {
		lines.push(`${target}:`);
		lines.push(`  cost: ${round(cost.cost)}  # set ${cost.setAt}${cost.reason ? `: ${cost.reason}` : ""}`);
		lines.push(`  _set_at: "${cost.setAt}"`);
		if (cost.reason) lines.push(`  _reason: "${cost.reason.replace(/"/g, "'")}"`);
		seen.add(target);
	}

	for (const [model, scores] of overrides.scores) {
		if (!seen.has(model)) {
			lines.push(`${model}:`);
			seen.add(model);
		}
		lines.push("  scores:");
		for (const s of scores) {
			lines.push(`    ${s.dimension}: ${round(s.value)}  # override ${s.setAt}${s.reason ? `: ${s.reason}` : ""}`);
			lines.push(`    _${s.dimension}-set-at: "${s.setAt}"`);
			if (s.reason) lines.push(`    _${s.dimension}-reason: "${s.reason.replace(/"/g, "'")}"`);
		}
	}

	fs.mkdirSync(teamDir(), { recursive: true });
	const tmp = `${OVERRIDES_FILE()}.tmp`;
	fs.writeFileSync(tmp, lines.join("\n") + "\n");
	fs.renameSync(tmp, OVERRIDES_FILE());
}

function round(value: number): number {
	return Math.round(value * 1000) / 1000;
}
