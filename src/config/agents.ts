/**
 * Agent definition discovery: markdown files with frontmatter, from the
 * user directory (~/.agents/agents) and the project directory (.pi/agents,
 * nearest ancestor). Project entries override user entries by name.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter, toList } from "./frontmatter.ts";
import { projectAgentsDir, USER_AGENTS_DIR } from "./paths.ts";

export interface AgentDef {
	name: string;
	description: string;
	/** Pre-approved tool surface; anything outside it must be asked for. */
	tools?: string[];
	/** Spec name (specs.jsonc) selecting the model policy. */
	spec?: string;
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
	collectFromDir(USER_AGENTS_DIR, "user", agents, warnings);
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
		if (!parsed) {
			warnings.push({
				file: filePath,
				message: "no frontmatter, or frontmatter does not start at line 1 — skipped",
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

		if (agents.has(name)) {
			// A project file with the same name replaces the user one; that is
			// the override rule, so only warn when both come from the same layer.
			const existing = agents.get(name)!;
			if (existing.source === source) {
				warnings.push({
					file: filePath,
					message: `duplicate agent name "${name}" (first definition: ${existing.filePath}) — skipped`,
				});
				continue;
			}
		}

		agents.set(name, {
			name,
			description,
			tools: toList(parsed.frontmatter.tools),
			spec: str(parsed.frontmatter.spec) || undefined,
			model: str(parsed.frontmatter.model) || undefined,
			systemPrompt: parsed.body,
			source,
			filePath,
		});
	}
}

function str(value: string | string[] | undefined): string {
	return typeof value === "string" ? value.trim() : "";
}
