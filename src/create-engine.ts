/**
 * Engine assembly. Loads the configuration and machine-owned state once
 * per session and wires the operations that exist so far into the tool
 * surface. Later PRs extend the parts: channel reads and permission
 * resolution.
 */

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type {
	Ack,
	ConveneInput,
	MessageInput,
	QuartermasterEngine,
	RateInput,
	SetCostInput,
	SetOverrideInput,
	TeamStatus,
} from "./engine.ts";
import { composeEngine } from "./compose-engine.ts";
import { loadConfig, type QuartermasterConfig } from "./config/index.ts";
import { loadEvidence, recordOutcome, type EvidenceStore } from "./matching/evidence.ts";
import { loadOverrides, setCostOverride, setScoreOverride, type Overrides } from "./matching/overrides.ts";
import { Fleet } from "./fleet/fleet.ts";

export interface EngineState {
	ctx: ExtensionToolContext;
	config: QuartermasterConfig;
	evidence: EvidenceStore;
	overrides: Overrides;
	/** Created on first convene; null until then. */
	fleet: Fleet | null;
}

export function createEngine(ctx: ExtensionToolContext): QuartermasterEngine {
	const state: EngineState = {
		ctx,
		config: loadConfig(ctx.cwd),
		evidence: loadEvidence(),
		overrides: loadOverrides(),
		fleet: null,
	};

	return composeEngine({
		status: async (): Promise<TeamStatus> => {
			if (state.fleet?.convened) {
				return state.fleet.status(configWarnings(state));
			}
			const { config } = state;
			return {
				convened: false,
				members: [],
				openMailboxes: [],
				pendingAsks: 0,
				unreadReports: 0,
				warnings: [
					`configured: ${config.agents.size} agent(s), ${config.mailboxes.size} mailbox(es), ${config.models.size} scored model(s)`,
					...(config.emptyState ? [config.emptyState] : configWarnings(state)),
				],
			};
		},

		convene: async (input: ConveneInput): Promise<TeamStatus> => {
			state.fleet = new Fleet(state.ctx, state.config, state.evidence, state.overrides);
			return state.fleet.convene(input);
		},

		dissolve: async (): Promise<TeamStatus> => {
			return state.fleet?.dissolve() ?? notConvened();
		},

		rate: async (input: RateInput): Promise<Ack> => {
			// Rating resolves by member: the member's spec says what its model
			// was drawn for, so the evidence lands on the drawn model weighted
			// by the spec's dimensions. The quartermaster never tracks models.
			const fleet = state.fleet;
			if (!fleet?.convened) {
				return {
					ok: false,
					message: `no convened team — rate members after convening (${input.member} was not rated)`,
				};
			}
			const resolution = fleet.memberForRating(input.member);
			if (!resolution) {
				return { ok: false, message: `no member named "${input.member}" — see team_list` };
			}
			const outcome = clamp01(input.outcome);
			for (const { dimension, weight } of resolution.dimensions) {
				recordOutcome(state.evidence, resolution.modelId, dimension, outcome, input.note, weight);
			}
			return {
				ok: true,
				message: `rated ${input.member} = ${outcome}${input.note ? ` (${input.note})` : ""}; evidence updated on ${resolution.modelId} for ${resolution.dimensions.map((d) => d.dimension).join(", ")}`,
			};
		},

		message: async (input: MessageInput): Promise<Ack> => {
			return {
				ok: false,
				message: `messaging arrives with the mailboxes module — ${input.member} cannot receive it yet`,
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

function notConvened(): TeamStatus {
	return {
		convened: false,
		members: [],
		openMailboxes: [],
		pendingAsks: 0,
		unreadReports: 0,
		warnings: ["nothing to dissolve"],
	};
}

function configWarnings(state: EngineState): string[] {
	return state.config.warnings.map((w) => `${w.file}: ${w.message}`);
}

function clamp01(value: number): number {
	return Math.max(0, Math.min(1, value));
}
