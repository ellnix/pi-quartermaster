/**
 * Agent definition discovery: markdown files with frontmatter, from the
 * user directory (~/.agents/agents) and the project directory (.pi/agents,
 * nearest ancestor). Project entries override user entries by name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, toList } from "./frontmatter.ts";
import { projectAgentsDir, userAgentsDir } from "./paths.ts";
import { validateSpec, type SpecDef } from "./spec.ts";

export type WorktreeMode = "shared" | "per-member" | "attach";

export const WORKTREE_MODES: readonly WorktreeMode[] = ["shared", "per-member", "attach"];

export interface AgentDef {
	/** The addressable agent name: the file's name, or a variant's name. */
	name: string;
	/** The definition (file) this agent came from; differs from `name` for variants. */
	definition: string;
	description: string;
	/** Pre-approved tool surface; anything outside it must be asked for. */
	tools?: string[];
	/** The model policy, carried inline. Reusable specs live here, in agent definitions. */
	spec?: SpecDef;
	/**
	 * Where this agent works: `shared` (the user's tree), `per-member` (its own
	 * git worktree and branch), or `attach` (placed in another member's
	 * worktree, for readers). Absent: per-member for agents that can write,
	 * shared otherwise; see worktrees.jsonc `default`.
	 */
	worktree?: WorktreeMode;
	/** Direct physical model pin; skips the draw when present. */
	model?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface DiscoveryWarning {
	file: string;
	message: string;
}

export function loadAgents(cwd: string, warnings: DiscoveryWarning[]): Map<string, AgentDef> {
	const agents = new Map<string, AgentDef>();
	collectFromDir(userAgentsDir(), "user", agents, warnings);
	const project = projectAgentsDir(cwd);
	if (project) collectFromDir(project, "project", agents, warnings);
	return agents;
}

function collectFromDir(
	dir: string,
	source: "user" | "project",
	agents: Map<string, AgentDef>,
	warnings: DiscoveryWarning[],
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // directory absent: normal empty state
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch (err) {
			warnings.push({ file: filePath, message: `unreadable: ${String(err)}` });
			continue;
		}

		const parsed = parseFrontmatter(content);
		if (!parsed.ok) {
			warnings.push({
				file: filePath,
				message: `${parsed.reason} — skipped`,
			});
			continue;
		}

		const name = str(parsed.frontmatter.name);
		const description = str(parsed.frontmatter.description);
		if (!name || !description) {
			warnings.push({
				file: filePath,
				message: `missing required frontmatter field (${!name ? "name" : "description"}) — skipped`,
			});
			continue;
		}

		let worktree: WorktreeMode | undefined;
		if (parsed.frontmatter.worktree !== undefined) {
			const mode = str(parsed.frontmatter.worktree);
			if ((WORKTREE_MODES as readonly string[]).includes(mode)) worktree = mode as WorktreeMode;
			else warnings.push({ file: filePath, message: `worktree must be one of ${WORKTREE_MODES.join(", ")} — ignored` });
		}

		const variants = parseVariants(parsed.frontmatter.variants, filePath, warnings);
		// Each addressable agent: scaffolding (prompt, tools, model pin) is
		// shared; stance (the spec) is the definition's, deep-merged with the
		// variant's own overrides. No variants block: one agent, the file's.
		const expanded: Array<{ name: string; spec: SpecDef | undefined }> = [];
		if (variants) {
			for (const [variantName, override] of variants) {
				const merged = deepMerge(parsed.frontmatter.spec, override);
				const hasSpec = typeof merged === "object" && merged !== null && Object.keys(merged).length > 0;
				const spec = hasSpec ? validateSpec(merged, `${filePath} (variant ${variantName})`, warnings) : null;
				expanded.push({ name: variantName, spec: spec ?? undefined });
			}
		} else {
			const spec =
				parsed.frontmatter.spec !== undefined
					? validateSpec(parsed.frontmatter.spec, filePath, warnings)
					: undefined;
			expanded.push({ name, spec: spec ?? undefined });
		}

		for (const agent of expanded) {
			if (agents.has(agent.name)) {
				// A project file with the same name replaces the user one; that is
				// the override rule, so only warn when both come from the same layer.
				const existing = agents.get(agent.name)!;
				if (existing.source === source) {
					warnings.push({
						file: filePath,
						message: `duplicate agent name "${agent.name}" (first definition: ${existing.filePath}) — skipped`,
					});
					continue;
				}
			}

			agents.set(agent.name, {
				name: agent.name,
				definition: name,
				description,
				tools: toList(parsed.frontmatter.tools),
				spec: agent.spec,
				model: str(parsed.frontmatter.model) || undefined,
				worktree,
				systemPrompt: parsed.body,
				source,
				filePath,
			});
		}
	}
}

const VARIANT_KEYS = new Set(["weights", "temperature", "filters"]);

/**
 * Read the `variants` block: addressable agent name -> spec overrides
 * (weights, temperature, filters, written flat). Null when absent or
 * unusable, in which case the file is one agent named after itself.
 */
function parseVariants(
	value: unknown,
	file: string,
	warnings: DiscoveryWarning[],
): Array<[string, Record<string, unknown>]> | null {
	if (value === undefined) return null;
	if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length === 0) {
		warnings.push({ file, message: "variants must be a non-empty object of name -> spec overrides — ignored" });
		return null;
	}
	const out: Array<[string, Record<string, unknown>]> = [];
	for (const [variantName, raw] of Object.entries(value as Record<string, unknown>)) {
		if (raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
			warnings.push({ file, message: `variant "${variantName}" must be an object (use {} to inherit) — skipped` });
			continue;
		}
		const override: Record<string, unknown> = {};
		for (const [key, v] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
			if (!VARIANT_KEYS.has(key)) {
				warnings.push({
					file,
					message: `variant "${variantName}": unknown key "${key}" ignored (variants override weights, temperature, filters)`,
				});
				continue;
			}
			override[key] = v;
		}
		out.push([variantName, override]);
	}
	return out.length > 0 ? out : null;
}

/** Deep-merge plain objects, the override winning; anything else is replaced. */
function deepMerge(base: unknown, over: unknown): unknown {
	if (!isPlain(base) || !isPlain(over)) return over === undefined ? base : over;
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
	return out;
}

function isPlain(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
