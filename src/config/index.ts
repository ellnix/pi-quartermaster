/**
 * Whole-config load: discover and validate every layer, collecting
 * warnings instead of throwing. A single malformed file never takes
 * down the rest. Everything user-level lives under the pi agent
 * directory (relocated wholesale by PI_CODING_AGENT_DIR); the project
 * layer under .pi is optional and may stay empty forever.
 */

import { loadAgents, type AgentDef, type DiscoveryWarning } from "./agents.ts";
import { loadMailboxes, type MailboxDef } from "./mailboxes.ts";
import { loadModels, type ModelEntry } from "./models.ts";
import { loadWorktreeConfig, type WorktreeConfig } from "./worktrees.ts";
import { loadAuthority, type AuthorityConfig } from "./authority.ts";
import { projectAgentsDir, teamDir, userAgentsDir } from "./paths.ts";

export interface QuartermasterConfig {
	agents: Map<string, AgentDef>;
	mailboxes: Map<string, MailboxDef>;
	models: Map<string, ModelEntry>;
	authority: AuthorityConfig;
	/** How members are placed in git worktrees; project-level, defaults when absent. */
	worktrees: WorktreeConfig;
	warnings: DiscoveryWarning[];
	/** Populated when every layer is empty — the informative empty state. */
	emptyState?: string;
}

export function loadConfig(cwd: string): QuartermasterConfig {
	const warnings: DiscoveryWarning[] = [];
	const agents = loadAgents(cwd, warnings);
	const mailboxes = loadMailboxes(cwd, warnings);
	const models = loadModels(cwd, warnings);
	const authority = loadAuthority(warnings);
	const worktrees = loadWorktreeConfig(cwd, warnings);

	// Cross-check: an agent with neither spec nor model cannot be convened
	// — say it at load, not at convene time.
	for (const agent of agents.values()) {
		if (!agent.spec && !agent.model) {
			warnings.push({
				file: agent.filePath,
				message: `agent "${agent.name}" has neither spec nor model — convening it will fail`,
			});
		}
	}

	const config: QuartermasterConfig = {
		agents,
		mailboxes,
		models,
		authority,
		worktrees,
		warnings,
	};

	if (agents.size === 0 && mailboxes.size === 0 && models.size === 0) {
		const project = projectAgentsDir(cwd);
		config.emptyState = [
			"No Quartermaster configuration found. Expected any of:",
			`- agents: ${userAgentsDir()}/<name>.md${project ? ` or ${project}/<name>.md` : " or .pi/agents/<name>.md"}`,
			`- mailboxes: ${teamDir()}/mailboxes/<name>.md`,
			`- models: ${teamDir()}/models.yaml`,
			`- authority: ${teamDir()}/authority.jsonc (optional — defaults apply)`,
			"All of it lives under pi's agent directory, so PI_CODING_AGENT_DIR relocates the team wholesale.",
			"Run the team-setup skill to interview the user and write these files.",
		].join("\n");
	}

	return config;
}

export type { AgentDef, MailboxDef, ModelEntry, AuthorityConfig, DiscoveryWarning };
export type { SpecDef, SpecFilters } from "./spec.ts";
export type { WorktreeConfig } from "./worktrees.ts";
export type { MatchingPolicy, WakePolicy } from "./authority.ts";
