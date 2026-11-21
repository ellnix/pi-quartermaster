/**
 * Whole-config load: discover and validate every layer, collecting
 * warnings instead of throwing. A single malformed file never takes
 * down the rest — the same tolerance the discovery loaders apply.
 */

import { loadAgents, type AgentDef, type DiscoveryWarning } from "./agents.ts";
import { loadMailboxes, type MailboxDef } from "./mailboxes.ts";
import { loadSpecs, type SpecDef } from "./specs.ts";
import { loadModels, type ModelEntry } from "./models.ts";
import { loadAuthority, type AuthorityConfig } from "./authority.ts";
import { projectAgentsDir, projectMailboxesDir, teamDir, USER_AGENTS_DIR, USER_MAILBOXES_DIR } from "./paths.ts";

export interface QuartermasterConfig {
	agents: Map<string, AgentDef>;
	mailboxes: Map<string, MailboxDef>;
	specs: Map<string, SpecDef>;
	models: Map<string, ModelEntry>;
	authority: AuthorityConfig;
	warnings: DiscoveryWarning[];
	/** Populated when every layer is empty — the informative empty state. */
	emptyState?: string;
}

export function loadConfig(cwd: string): QuartermasterConfig {
	const warnings: DiscoveryWarning[] = [];
	const agents = loadAgents(cwd, warnings);
	const mailboxes = loadMailboxes(cwd, warnings);
	const specs = loadSpecs(cwd, warnings);
	const models = loadModels(cwd, warnings);
	const authority = loadAuthority(warnings);

	// Cross-check: an agent referencing an unknown spec is a routing bug
	// waiting to happen — say it at load, not at convene time.
	for (const agent of agents.values()) {
		if (agent.spec && !specs.has(agent.spec) && !agent.model) {
			warnings.push({
				file: agent.filePath,
				message: `agent "${agent.name}" references spec "${agent.spec}" which is not defined, and pins no model — convening it will fail`,
			});
		}
	}

	const config: QuartermasterConfig = {
		agents,
		mailboxes,
		specs,
		models,
		authority,
		warnings,
	};

	if (agents.size === 0 && mailboxes.size === 0 && specs.size === 0 && models.size === 0) {
		const project = projectAgentsDir(cwd);
		config.emptyState = [
			"No Quartermaster configuration found. Expected any of:",
			`- agents: ${USER_AGENTS_DIR}/<name>.md${project ? ` or ${project}/<name>.md` : " or .pi/agents/<name>.md"}`,
			`- mailboxes: ${USER_MAILBOXES_DIR}/<name>.md`,
			`- specs: ${teamDir()}/specs.jsonc`,
			`- models: ${teamDir()}/models.yaml`,
			"Run the team-setup skill to interview the user and write these files.",
		].join("\n");
	}

	return config;
}

export type { AgentDef, MailboxDef, SpecDef, ModelEntry, AuthorityConfig, DiscoveryWarning };
