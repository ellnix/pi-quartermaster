/**
 * Quartermaster extension entry.
 *
 * The quartermaster is the user's main interactive pi session. This extension
 * registers the tool surface it uses to convene, observe, equip, and govern a
 * team of sub-agents. Every tool delegates to a QuartermasterEngine; the
 * scaffold ships NotConfiguredEngine, and the composed engine takes over as
 * the config, matcher, and fleet modules land.
 *
 * When the fleet spawns child sessions in this process, this same extension
 * file is loaded inside them (the child's resource discovery sees user
 * settings). The guard below makes it inert there: children get the crewman
 * tools passed as custom tools instead, never the quartermaster surface.
 */

import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	NotConfiguredEngine,
	type Ack,
	type ConveneInput,
	type MessageInput,
	type PendingAsk,
	type QuartermasterEngine,
	type ReadChannelInput,
	type ReadChannelResult,
	type ResolveAskInput,
	type SetCostInput,
	type SetOverrideInput,
	type RateInput,
	type TeamStatus,
} from "./engine.ts";

/** Set by the fleet around child session creation; see the header comment. */
const CHILD_MARKER = "QM_CHILD";

function text(body: string): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: body }], details: {} };
}

function ackText(ack: Ack): { content: { type: "text"; text: string }[]; details: unknown } {
	const body = ack.ok ? ack.message : `${ack.message}${ack.warnings?.length ? `\nwarnings: ${ack.warnings.join("; ")}` : ""}`;
	return text(body);
}

function teamText(status: TeamStatus): { content: { type: "text"; text: string }[]; details: unknown } {
	const lines: string[] = [];
	if (!status.convened) {
		lines.push("No team is convened.");
	} else {
		lines.push(`Team ${status.teamId ?? "?"} — ${status.members.length} member(s).`);
		for (const m of status.members) {
			lines.push(`- ${m.name} [${m.state}] ${m.model ? `on ${m.model}` : "(no model drawn)"} — ${m.description}${m.note ? ` (${m.note})` : ""}`);
		}
		if (status.openMailboxes.length) {
			lines.push(`Open mailboxes: ${status.openMailboxes.join(", ")}`);
		}
		if (status.pendingAsks > 0) {
			lines.push(`${status.pendingAsks} pending permission ask(s) — resolve with resolve_ask.`);
		}
		if (status.unreadReports > 0) {
			lines.push(`${status.unreadReports} unread report(s) — read_channel "reports".`);
		}
	}
	for (const w of status.warnings) {
		lines.push(`warning: ${w}`);
	}
	return text(lines.join("\n"));
}

function asksText(asks: PendingAsk[]): { content: { type: "text"; text: string }[]; details: unknown } {
	if (!asks.length) return text("No pending asks.");
	return text(asks.map((a) => `- [${a.id}] ${a.member} asks to run ${a.tool} ${a.args}`).join("\n"));
}

function channelText(result: ReadChannelResult): { content: { type: "text"; text: string }[]; details: unknown } {
	const lines = result.messages.map(
		(m) => `[${m.channel}] ${new Date(m.ts).toISOString()}: ${m.body}`,
	);
	for (const w of result.warnings) lines.push(`warning: ${w}`);
	return text(lines.length ? lines.join("\n") : `No traffic on ${result.channel}.`);
}

export default function quartermaster(pi: ExtensionAPI): void {
	// Child sessions created by the fleet load this extension too. Stay inert:
	// the crewman tools are passed to them as custom tools, and a quartermaster
	// surface inside a child would let it convene sub-teams of its own.
	if (process.env[CHILD_MARKER]) return;

	// Replaced by the composed engine when the config, matcher, and fleet
	// modules land. The tool surface above is final and never changes shape.
	const engine: QuartermasterEngine = new NotConfiguredEngine();

	pi.registerTool({
		name: "convene_team",
		label: "Convene team",
		description:
			"Convene a team of persistent sub-agents. Each member runs as a child session " +
			"with a model drawn once from its spec (temperature-bounded, filtered by auth, " +
			"capability, and cost). Agents carry their reusable specs; an override here is " +
			"built on the fly, not named. Members are persistent: the task is the initial " +
			"instruction, and you can guide a member step by step afterwards with " +
			"message_member. Declare the channel repository up front: every channel to open, " +
			"with its endpoints - this wiring is the single authority for who talks to whom.",
		promptSnippet: "Convene a team of sub-agents for parallel or multi-role work.",
		promptGuidelines: [
			"Convene defines the relationship graph up front; open a mailbox mid-flight only as a recorded decision.",
			"Members never see your conversation: give each task enough to start, then guide with message_member.",
		],
		parameters: Type.Object({
			members: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Agent definition name (from ~/.agents/agents/ or .pi/agents/)." }),
					spec: Type.Optional(
						Type.Object(
							{
								weights: Type.Record(Type.String(), Type.Number(), {
									description: "Dimension weights; suitability = dot product with a model's scores.",
								}),
								temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 5, description: "Softmax temperature, 0 (deterministic) to 5." })),
								filters: Type.Optional(
									Type.Object({
										require: Type.Optional(Type.Array(Type.String(), { description: "Input modalities a candidate must support." })),
										minCostScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Minimum cost score (1 = cheapest)." })),
										allowUnrated: Type.Optional(Type.Boolean({ description: "Let unrated models into the pool." })),
									}),
								),
							},
							{ description: "A spec built on the fly, overriding the agent's own for this deployment." },
						),
					),
					task: Type.String({ description: "The initial task for this member. Self-contained enough to start from." }),
				}),
				{ minItems: 1 },
			),
			mailboxes: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Mailbox definition name (the template supplying the preamble, from ~/.agents/mailboxes/ or .pi/team/mailboxes/)." }),
						from: Type.String({ description: "Sender member." }),
						to: Type.String({ description: "Recipient member." }),
					}),
					{ description: "The channel repository - the single authority for who talks to whom. Mailbox definitions are preamble templates and carry no endpoints." },
				),
			),
		}),
		execute: async (_id, params: ConveneInput) => teamText(await engine.convene(params)),
	});

	pi.registerTool({
		name: "team_list",
		label: "Team list",
		description:
			"List the convened team: members, live status, the model each was drawn on, their " +
			"descriptions and recommended use, pending permission asks, and unread reports.",
		parameters: Type.Object({}),
		execute: async () => teamText(await engine.status()),
	});

	pi.registerTool({
		name: "read_channel",
		label: "Read channel",
		description:
			"Read logged team traffic on demand. channel is a mailbox name or \"reports\". " +
			"All traffic is logged; nothing is pushed into your context. The logs are " +
			"newline-delimited JSON (JSONL - the same thing ndjson names) under the team " +
			"record (team_list shows the path): read them with your own tools and run " +
			"any analysis you like.",
		parameters: Type.Object({
			channel: Type.String({ description: "A mailbox name, or \"reports\"." }),
			tail: Type.Optional(Type.Number({ description: "How many recent messages to return. Default 20." })),
		}),
		execute: async (_id, params: ReadChannelInput) => channelText(await engine.readChannel(params)),
	});

	pi.registerTool({
		name: "rate_member",
		label: "Rate member outcome",
		description:
			"Rate a member's outcome at return-time, when your judgment is freshest. " +
			"outcome is 0 to 1 — a bad review means the member's model was bad at what " +
			"the member was convened to do. You never track models or dimensions: the " +
			"member's spec says what its model was drawn for, and the evidence updates " +
			"the drawn model on those dimensions. One bad day moves a model a little; a " +
			"pattern moves it a lot; down-scored models still draw occasionally — that " +
			"is the recovery path.",
		promptGuidelines: ["Rate each member at return-time; rate every member before dissolving."],
		parameters: Type.Object({
			member: Type.String({ description: "Team member name (from team_list)." }),
			outcome: Type.Number({ minimum: 0, maximum: 1, description: "Outcome quality, 0 to 1." }),
			note: Type.Optional(Type.String({ description: "Short reason, recorded with the rating." })),
		}),
		execute: async (_id, params: RateInput) => ackText(await engine.rate(params)),
	});

	pi.registerTool({
		name: "set_cost",
		label: "Set cost fact",
		description:
			"Record a durable cost fact. cost is 0 to 1 (1 = cheapest) and accounts for " +
			"promotions and plans — e.g. when the user says their new subscription makes a " +
			"provider 5x cheaper. target \"provider/<id>\" sets every model of that provider.",
		parameters: Type.Object({
			target: Type.String({ description: "A model id, or \"provider/<id>\"." }),
			cost: Type.Number({ minimum: 0, maximum: 1, description: "Cost score, 1 = cheapest." }),
			reason: Type.Optional(Type.String({ description: "Provenance, recorded with the override." })),
		}),
		execute: async (_id, params: SetCostInput) => ackText(await engine.setCost(params)),
	});

	pi.registerTool({
		name: "set_override",
		label: "Set score override",
		description:
			"Set a durable score override for a model on a dimension. Overrides beat " +
			"evidence and every posterior drift — use them for user-directed judgments. " +
			"The user is the veto layer.",
		parameters: Type.Object({
			model: Type.String({ description: "Physical model id." }),
			dimension: Type.String({ description: "Score dimension." }),
			value: Type.Number({ minimum: 0, maximum: 1, description: "The override value, 0 to 1." }),
			reason: Type.Optional(Type.String({ description: "Provenance, recorded with the override." })),
		}),
		execute: async (_id, params: SetOverrideInput) => ackText(await engine.setOverride(params)),
	});

	pi.registerTool({
		name: "pending_asks",
		label: "Pending asks",
		description: "List pending permission asks from team members.",
		parameters: Type.Object({}),
		execute: async () => asksText(await engine.pendingAsks()),
	});

	pi.registerTool({
		name: "resolve_ask",
		label: "Resolve ask",
		description:
			"Resolve a pending permission ask. Categories listed as escalate-only in " +
			"authority.jsonc require the user's confirmation, quoted in userConfirmed.",
		parameters: Type.Object({
			id: Type.String({ description: "The ask id from pending_asks." }),
			approve: Type.Boolean({ description: "Whether to allow the request." }),
			userConfirmed: Type.Optional(
				Type.String({ description: "Required for escalate-only categories: the user's confirmation, quoted." }),
			),
		}),
		execute: async (_id, params: ResolveAskInput) => ackText(await engine.resolveAsk(params)),
	});

	pi.registerTool({
		name: "message_member",
		label: "Message member",
		description:
			"Send a message to one member of the convened team, with the engine's " +
			"constitutional framing prefixed — your body is the only thing you wrote. " +
			"The member does not have to be idle to receive it: pi can steer a running " +
			"agent between its inputs. Set steer to interrupt the current run and steer " +
			"it with your message; leave it false and the message queues as a follow-up " +
			"for when the run finishes. All messages are logged to the record like " +
			"mailbox traffic. Members are persistent: use this to guide step by step, " +
			"relay results of approved actions, or correct course mid-flight.",
		parameters: Type.Object({
			member: Type.String({ description: "Team member name (from team_list)." }),
			body: Type.String({ description: "The message body." }),
			steer: Type.Optional(Type.Boolean({ description: "True: interrupt the member's current run and steer it. False (default): queue as a follow-up." })),
		}),
		execute: async (_id, params: MessageInput) => ackText(await engine.message(params)),
	});

	pi.registerTool({
		name: "dissolve_team",
		label: "Dissolve team",
		description:
			"Dissolve the team: collect final reports, dispose the child sessions. Best " +
			"practice: rate every member first (rate_member) — a dissolution without " +
			"ratings wastes the session's evidence. The record persists; reconvening " +
			"draws fresh models with the record as the blackboard.",
		parameters: Type.Object({}),
		execute: async () => teamText(await engine.dissolve()),
	});
}
