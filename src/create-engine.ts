/**
 * Engine assembly. Loads the configuration and machine-owned state once
 * per session and wires the operations that exist so far into the tool
 * surface. Later PRs extend the parts: fleet operations (convene,
 * dissolve), channel reads, and permission resolution.
 */

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type { Ack, MessageInput, QuartermasterEngine, RateInput, SetCostInput, SetOverrideInput, TeamStatus } from "./engine.ts";
import { composeEngine } from "./compose-engine.ts";
import { loadConfig, type QuartermasterConfig } from "./config/index.ts";
import { loadEvidence, type EvidenceStore } from "./matching/evidence.ts";
import { loadOverrides, setCostOverride, setScoreOverride, type OverridesFile } from "./matching/overrides.ts";

export interface EngineState {
	ctx: ExtensionToolContext;
	config: QuartermasterConfig;
	evidence: EvidenceStore;
	overrides: OverridesFile;
}

export function createEngine(ctx: ExtensionToolContext): QuartermasterEngine {
	const state: EngineState = {
		ctx,
		config: loadConfig(ctx.cwd),
		evidence: loadEvidence(),
		overrides: loadOverrides(),
	};

	return composeEngine({
		status: async (): Promise<TeamStatus> => {
			const { config } = state;
			const warnings = config.warnings.map((w) => `${w.file}: ${w.message}`);
			return {
				convened: false,
				members: [],
				openMailboxes: [],
				pendingAsks: 0,
				unreadReports: 0,
				warnings: [
					`configured: ${config.agents.size} agent(s), ${config.mailboxes.size} mailbox(es), ${config.specs.size} spec(s), ${config.models.size} scored model(s)`,
					...(config.emptyState ? [config.emptyState] : warnings),
				],
			};
		},

		rate: async (input: RateInput): Promise<Ack> => {
			// Rating resolves by member: the member's spec says what its model was
			// drawn for. Resolution needs the fleet, which arrives with the
			// lifecycle PR; until then there is nothing to rate.
			return {
				ok: false,
				message: `rating by member (${input.member}) arrives with the fleet - convene a team first`,
			};
		},

		message: async (input: MessageInput): Promise<Ack> => {
			return {
				ok: false,
				message: `messaging arrives with the fleet - no member named ${input.member} until a team convenes`,
			};
		},

		setCost: async (input: SetCostInput): Promise<Ack> => {
			const cost = clamp01(input.cost);
			setCostOverride(state.overrides, input.target, cost, input.reason);
			return {
				ok: true,
				message: `cost recorded for ${input.target}: ${cost} (1 = cheapest)${input.reason ? ` — ${input.reason}` : ""}`,
			};
		},

		setOverride: async (input: SetOverrideInput): Promise<Ack> => {
			const value = clamp01(input.value);
			setScoreOverride(state.overrides, input.model, input.dimension, value, input.reason);
			return {
				ok: true,
				message: `override recorded: ${input.model} / ${input.dimension} = ${value}${input.reason ? ` — ${input.reason}` : ""}`,
			};
		},
	});
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
