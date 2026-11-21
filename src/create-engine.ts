/**
 * Engine assembly. Loads the configuration and machine-owned state once
 * per session and wires the operations that exist so far into the tool
 * surface. The permissions module is still ahead; pending and resolve
 * delegate to the composed fallback until it lands.
 */

import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import type {
	Ack,
	ConveneInput,
	MessageInput,
	PendingAsk,
	QuartermasterEngine,
	RateInput,
	ReadChannelInput,
	ReadChannelResult,
	ResolveAskInput,
	SetCostInput,
	SetOverrideInput,
	TeamStatus,
} from "./engine.ts";
import { composeEngine } from "./compose-engine.ts";
import { loadConfig, type QuartermasterConfig } from "./config/index.ts";
import { loadEvidence, recordOutcome, type EvidenceStore } from "./matching/evidence.ts";
import { loadOverrides, setCostOverride, setScoreOverride, type Overrides } from "./matching/overrides.ts";
import { Fleet } from "./fleet/fleet.ts";
import { appendResolution, classifyForDisplay, pendingAsks, readChannelLog, readReports } from "./fleet/record.ts";
import { classifyAsk } from "./config/authority.ts";

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

		readChannel: async (input: ReadChannelInput): Promise<ReadChannelResult> => {
			const tail = input.tail ?? 20;
			const recordPath = state.fleet?.record;
			if (!recordPath) {
				return {
					channel: input.channel,
					messages: [],
					warnings: [
						input.channel === "reports"
							? "no convened team — convene first, or read a previous record by naming a channel file"
							: "no convened team — channel logs exist per team record",
					],
				};
			}
			if (input.channel === "reports") {
				const entries = readReports(recordPath, tail);
				return {
					channel: "reports",
					messages: entries.map((e) => ({
						channel: `report ${e.id}`,
						ts: e.ts,
						body: `${e.status}: ${e.summary}${e.confidence !== undefined ? ` (confidence ${e.confidence})` : ""}`,
					})),
					warnings: [],
				};
			}
			const entries = readChannelLog(recordPath, input.channel, tail);
			return { channel: input.channel, messages: entries, warnings: [] };
		},

		message: async (input: MessageInput): Promise<Ack> => {
			const fleet = state.fleet;
			if (!fleet?.convened) {
				return { ok: false, message: "no convened team — message members after convening" };
			}
			const result = fleet.message(input.member, input.body, input.steer ?? false);
			return { ok: result.ok, message: result.message };
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

		pendingAsks: async (): Promise<PendingAsk[]> => {
			const recordPath = state.fleet?.record;
			if (!recordPath) return [];
			return pendingAsks(recordPath).map((ask) => {
				const classification = classifyAsk(ask.tool, ask.args, state.config.authority);
				return {
					id: ask.id,
					member: ask.member,
					tool: ask.tool,
					args: ask.args,
					status: "pending",
					resolution: classifyForDisplay(classification),
				};
			});
		},

		resolveAsk: async (input: ResolveAskInput): Promise<Ack> => {
			const recordPath = state.fleet?.record;
			if (!recordPath) {
				return { ok: false, message: "no convened team — asks come from members of a team" };
			}
			const ask = pendingAsks(recordPath).find((a) => a.id === input.id);
			if (!ask) {
				return { ok: false, message: `no pending ask with id ${input.id} — see pending_asks` };
			}

			const classification = classifyAsk(ask.tool, ask.args, state.config.authority);
			if (classification === "escalate" && !input.userConfirmed) {
				return {
					ok: false,
					message: `${ask.tool} ${ask.args} is an escalate-only category: quote the user's confirmation in userConfirmed before approving. Deny freely.`,
				};
			}

			appendResolution(recordPath, {
				ts: Date.now(),
				id: ask.id,
				approve: input.approve,
				by: "quartermaster",
				userConfirmed: input.userConfirmed,
			});
			return {
				ok: true,
				message: `ask ${ask.id} ${input.approve ? "approved" : "denied"} (${ask.member}: ${ask.tool} ${ask.args})`,
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
