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
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createEngine } from "./create-engine.ts";
import { DEFAULT_WAKE } from "./config/authority.ts";
import {
	WAKE_CUSTOM_TYPE,
	WakeWatcher,
	syncWake,
	wakeMessage,
	type WakeDetails,
	type WakeNotice,
} from "./fleet/wake.ts";
import {
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
	type AddMemberInput,
	type WorktreesInput,
	type CloseMailboxInput,
	type OpenMailboxInput,
	type RemoveMemberInput,
	type RateInput,
	type TeamStatus,
} from "./engine.ts";

/** Set by the fleet around child session creation; see the header comment. */
const CHILD_MARKER = "QM_CHILD";

function text(body: string): { content: { type: "text"; text: string }[]; details: unknown } {
	return { content: [{ type: "text", text: body }], details: {} };
}

function ackText(ack: Ack): { content: { type: "text"; text: string }[]; details: unknown } {
	const body = `${ack.message}${ack.warnings?.length ? `\nwarnings: ${ack.warnings.join("; ")}` : ""}`;
	return text(body);
}

function teamText(status: TeamStatus): { content: { type: "text"; text: string }[]; details: unknown } {
	const lines: string[] = [];
	if (!status.convened) {
		lines.push("No team is convened.");
		const avail = status.available;
		if (avail && avail.agents.length > 0) {
			lines.push("", "Agents you can convene (pick by description; each has its own tools and spec):");
			for (const a of avail.agents) {
				lines.push(`- ${a.name}${a.definition ? ` (variant of ${a.definition})` : ""} — ${a.description}`);
				lines.push(`    tools: ${a.tools}; spec: ${a.pinnedModel ? `pinned to ${a.pinnedModel}` : a.spec}${a.worktree ? `; worktree: ${a.worktree}` : ""}`);
			}
		}
		if (avail && avail.mailboxes.length > 0) {
			lines.push("", "Mailbox templates you can wire (from/to are chosen at convene):");
			for (const m of avail.mailboxes) lines.push(`- ${m.name} — ${m.description}`);
		}
	} else {
		lines.push(`Team ${status.teamId ?? "?"} — ${status.members.length} member(s).`);
		for (const m of status.members) {
			const stamp = (t?: number) => (t ? new Date(t).toISOString() : "");
			const marker = m.removedAt
				? ` removed ${stamp(m.removedAt)}${m.removedReason ? `: ${m.removedReason}` : ""}`
				: m.addedAt
					? ` added ${stamp(m.addedAt)}`
					: "";
			lines.push(`- ${m.name}${m.definition ? ` (${m.definition})` : ""} [${m.state === "unstarted" ? "idle (not started)" : m.state}${marker}] ${m.model ? `on ${m.model}` : "(no model drawn)"} — ${m.description}${m.note ? ` (${m.note})` : ""}`);
			if (m.workspace) {
				lines.push(`    ${m.workspace.mode === "attach" ? `attached to ${m.workspace.attachedTo}'s worktree` : `worktree on ${m.workspace.branch}`} at ${m.workspace.path}`);
			}
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

const WORKSPACE_FIELDS = {
	worktree: Type.Optional(
		Type.Union([Type.Literal("shared"), Type.Literal("per-member"), Type.Literal("attach")], {
			description:
				"Where this member works. per-member: its own git worktree and branch (default for agents that can edit/write). " +
				"shared: the user's own tree, for members that must see uncommitted work. attach: placed in another member's worktree " +
				"(read-only agents only; needs attachTo). Omit to use the agent file's setting.",
		}),
	),
	attachTo: Type.Optional(Type.String({ description: "For worktree: attach, the member whose worktree to join. Convene the owner earlier in the list." })),
};

const SPEC_OVERRIDE = Type.Object(
							{
								weights: Type.Record(Type.String(), Type.Number(), {
									description: "Dimension weights; suitability = dot product with a model's scores.",
								}),
								temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 5, description: "Softmax temperature, 0 (deterministic) to 5." })),
								filters: Type.Optional(
									Type.Object({
										require: Type.Optional(Type.Array(Type.String(), { description: "Input modalities a candidate must support." })),
										minCostScore: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Minimum cost score (1 = cheapest)." })),
										minScores: Type.Optional(
											Type.Record(Type.String(), Type.Number({ minimum: 0, maximum: 1 }), {
												description: "Minimum deterministic score per dimension — candidates below the bar are excluded before the draw.",
											}),
										),
										allowUnrated: Type.Optional(Type.Boolean({ description: "Let unrated models into the pool." })),
									}),
								),
							},
							{ description: "A spec built on the fly, overriding the agent's own for this deployment." },
);

export default function quartermaster(pi: ExtensionAPI): void {
	// Child sessions created by the fleet load this extension too. Stay inert:
	// the crewman tools are passed to them as custom tools, and a quartermaster
	// surface inside a child would let it convene sub-teams of its own.
	if (process.env[CHILD_MARKER]) return;

	// The engine loads configuration and machine-owned state lazily, on the
	// first tool call, when the tool context is available. Each module that
	// lands (config, matcher, fleet) extends the parts; the tool surface
	// above is final and never changes shape.
	let engine: QuartermasterEngine | null = null;
	const getEngine = (ctx: ExtensionToolContext): QuartermasterEngine => {
		engine ??= createEngine(ctx);
		return engine;
	};

	// Wakes: the record watcher delivers digests as custom messages, never user
	// messages — machine traffic must not impersonate the user. `followUp` keeps
	// a running quartermaster unsteered; `triggerTurn` starts a turn when idle.
	const wake = new WakeWatcher(DEFAULT_WAKE, (notice: WakeNotice) => {
		const { message, options } = wakeMessage(notice);
		pi.sendMessage(message, options);
	});

	/**
	 * Point the watcher at the active team's record, or park it. Called after
	 * convene and dissolve — the only two operations that move the record path
	 * — and never polled, so the watcher cannot drift from the live team.
	 */
	const followTeam = (active: QuartermasterEngine | null): void => {
		if (!active) return;
		syncWake(wake, active.wakeSource());
	};

	pi.on("session_shutdown", () => {
		wake.stop();
	});

	// Wakes arrive without a user prompt, so they must be visible in the
	// transcript on their own: a custom message that only the model saw would
	// be an invisible turn in the user's session.
	pi.registerMessageRenderer(WAKE_CUSTOM_TYPE, (message, { expanded, outputPad }, theme) => {
		const details = message.details as WakeDetails | undefined;
		const heading = theme.fg("accent", "[wake]");
		let body = `${heading} ${message.content}`;
		if (expanded && details) {
			body += `\n${theme.fg("dim", `${details.reports.length} report(s), ${details.asks.length} ask(s) — ${details.recordPath}`)}`;
		}
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(body, 0, 0));
		return box;
	});

	pi.registerTool({
		name: "convene_team",
		label: "Convene team",
		description:
			"Convene a team of persistent sub-agents. Each member runs as a child session " +
			"with a model drawn once from its spec (temperature-bounded, filtered by auth, " +
			"capability, and cost). Agents carry their reusable specs; an override here is " +
			"built on the fly, not named. Members are persistent: the task is the initial " +
			"instruction (omit it, or pass an empty string, to convene a member armed: " +
			"drawn and wired but idle and not started, costing nothing until its first " +
			"message_member starts it), and you can guide a member step by step afterwards with " +
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
					agent: Type.String({ description: "Agent definition name (from the agent dir: team/agents/, or the project .pi/agents/)." }),
					spec: Type.Optional(SPEC_OVERRIDE),
					...WORKSPACE_FIELDS,
					task: Type.Optional(Type.String({ description: "The initial task for this member. Self-contained enough to start from. Omit or \"\" to convene idle (not started); the first message_member starts it. Whitespace-only is an error." })),
				}),
				{ minItems: 1 },
			),
			mailboxes: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Mailbox definition name (the template supplying the preamble, from the agent dir: team/mailboxes/, or the project .pi/team/mailboxes/)." }),
						from: Type.String({ description: "Sender member." }),
						to: Type.String({ description: "Recipient member." }),
					}),
					{ description: "The channel repository - the single authority for who talks to whom. Mailbox definitions are preamble templates and carry no endpoints." },
				),
			),
		}),
		execute: async (_id, params: ConveneInput, _sig, _up, ctx) => {
			const status = await getEngine(ctx).convene(params);
			followTeam(engine);
			return teamText(status);
		},
	});

	pi.registerTool({
		name: "team_list",
		label: "Team list",
		description:
			"List the convened team: members, live status, the model each was drawn on, their " +
			"descriptions and recommended use, pending permission asks, and unread reports.",
		parameters: Type.Object({}),
		execute: async (_id, _params, _sig, _up, ctx) => teamText(await getEngine(ctx).status()),
	});

	pi.registerTool({
		name: "read_channel",
		label: "Read channel",
		description:
			"Read logged team traffic on demand. channel is \"reports\", a mailbox template name " +
			"(all of its wirings), a channel id, or a pairing like \"builder--scout\". " +
			"All traffic is logged; nothing is pushed into your context. The logs are plain " +
			"JSONL files under the team record (team_list shows the path): read them with " +
			"your own tools and run any analysis you like.",
		parameters: Type.Object({
			channel: Type.String({ description: "\"reports\", a mailbox template name, a channel id, or a from--to pairing." }),
			tail: Type.Optional(Type.Number({ description: "How many recent messages to return. Default 20." })),
		}),
		execute: async (_id, params: ReadChannelInput, _sig, _up, ctx) => channelText(await getEngine(ctx).readChannel(params)),
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
		execute: async (_id, params: RateInput, _sig, _up, ctx) => ackText(await getEngine(ctx).rate(params)),
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
		execute: async (_id, params: SetCostInput, _sig, _up, ctx) => ackText(await getEngine(ctx).setCost(params)),
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
		execute: async (_id, params: SetOverrideInput, _sig, _up, ctx) => ackText(await getEngine(ctx).setOverride(params)),
	});

	pi.registerTool({
		name: "pending_asks",
		label: "Pending asks",
		description: "List pending permission asks from team members.",
		parameters: Type.Object({}),
		execute: async (_id, _params, _sig, _up, ctx) => asksText(await getEngine(ctx).pendingAsks()),
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
		execute: async (_id, params: ResolveAskInput, _sig, _up, ctx) => ackText(await getEngine(ctx).resolveAsk(params)),
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
			"for when the run finishes. A member that was convened without a task starts on its " +
			"first message, which is its first input; steer is then the same as a normal message. All messages are logged to the record like " +
			"mailbox traffic. Members are persistent: use this to guide step by step, " +
			"relay results of approved actions, or correct course mid-flight.",
		parameters: Type.Object({
			member: Type.String({ description: "Team member name (from team_list)." }),
			body: Type.String({ description: "The message body." }),
			steer: Type.Optional(Type.Boolean({ description: "True: interrupt the member's current run and steer it. False (default): queue as a follow-up." })),
		}),
		execute: async (_id, params: MessageInput, _sig, _up, ctx) => ackText(await getEngine(ctx).message(params)),
	});

	pi.registerTool({
		name: "add_member",
		label: "Add member",
		description:
			"Add a member to the live team: one draw now under the agent's (or variant's) spec, " +
			"the same gates as convening. A failed draw leaves the team unchanged. The task may be " +
			"omitted to add the member armed (idle, not started; its first message starts it). " +
			"mailboxes extends the channel graph; existing wiring is untouched, and members already " +
			"running are not told about new channels. Logged in the record's composition history.",
		parameters: Type.Object({
			agent: Type.String({ description: "Agent or variant name." }),
			spec: Type.Optional(SPEC_OVERRIDE),
			...WORKSPACE_FIELDS,
			task: Type.Optional(Type.String({ description: "Initial task. Omit or \"\" to add idle. Whitespace-only is an error." })),
			mailboxes: Type.Optional(
				Type.Array(
					Type.Object({
						name: Type.String({ description: "Mailbox template name." }),
						from: Type.String({ description: "Sender member." }),
						to: Type.String({ description: "Recipient member." }),
					}),
					{ description: "Channels to open for the new member, with endpoints." },
				),
			),
		}),
		execute: async (_id, params: AddMemberInput, _sig, _up, ctx) => ackText(await getEngine(ctx).addMember(params)),
	});

	pi.registerTool({
		name: "remove_member",
		label: "Remove member",
		description:
			"Remove a member from the live team. Refuses while the member is working or has pending " +
			"permission asks, reporting its state; force: true interrupts it and denies the asks with " +
			"a recorded note. Its channels close, its logs and reports stay readable, it stays in the " +
			"record as removed, and rate_member still works for it - rate it, or its evidence is lost.",
		parameters: Type.Object({
			member: Type.String({ description: "Team member name (from team_list)." }),
			reason: Type.Optional(Type.String({ description: "Why, recorded in the composition history." })),
			force: Type.Optional(Type.Boolean({ description: "Interrupt a working member and deny its pending asks." })),
		}),
		execute: async (_id, params: RemoveMemberInput, _sig, _up, ctx) => ackText(await getEngine(ctx).removeMember(params)),
	});

	pi.registerTool({
		name: "worktrees",
		label: "Worktrees",
		description:
			"List the git worktrees quartermaster created for this repository (team, member, branch, path, " +
			"clean or dirty, commits ahead, live or unclaimed), or prune the ones nobody claims. Members that can " +
			"write each get their own worktree and branch so they cannot disturb the user's tree or each other; " +
			"compare their work with git diff <base>...<branch>. Pruning needs a scope (team id, or all) because " +
			"another running session's trees look unclaimed from here. It keeps trees with uncommitted changes " +
			"unless discardDirty, and branches with commits are never deleted.",
		parameters: Type.Object({
			prune: Type.Optional(Type.Boolean({ description: "Remove unclaimed worktrees instead of listing." })),
			team: Type.Optional(Type.String({ description: "With prune: only this team id's trees." })),
			all: Type.Optional(Type.Boolean({ description: "With prune: every team's unclaimed trees." })),
			discardDirty: Type.Optional(Type.Boolean({ description: "With prune: also remove trees with uncommitted changes." })),
		}),
		execute: async (_id, params: WorktreesInput, _sig, _up, ctx) => ackText(await getEngine(ctx).worktrees(params)),
	});

	pi.registerTool({
		name: "open_mailbox",
		label: "Open mailbox",
		description:
			"Open a channel between two live members, from a mailbox template, on a running team. " +
			"The same wiring rules as convening: the endpoints must be active members, and the same " +
			"template with the same endpoints cannot be open twice (a closed one is reopened, log " +
			"intact). Members are not told; message them if they should know. Logged in the " +
			"composition history.",
		parameters: Type.Object({
			name: Type.String({ description: "Mailbox template name." }),
			from: Type.String({ description: "Sender member." }),
			to: Type.String({ description: "Recipient member." }),
		}),
		execute: async (_id, params: OpenMailboxInput, _sig, _up, ctx) => ackText(await getEngine(ctx).openMailbox(params)),
	});

	pi.registerTool({
		name: "close_mailbox",
		label: "Close mailbox",
		description:
			"Close a channel on a live team, e.g. one being abused or no longer needed. It stops " +
			"delivering immediately; the sender gets the ordinary \"no mailbox open\" refusal. The " +
			"log is preserved and stays readable, and open_mailbox can reopen it. Name it by channel " +
			"id, a from--to pairing, or its template when only one of that template's channels is open.",
		parameters: Type.Object({
			channel: Type.String({ description: "Channel id, from--to pairing, or template name." }),
			reason: Type.Optional(Type.String({ description: "Why, recorded in the composition history." })),
		}),
		execute: async (_id, params: CloseMailboxInput, _sig, _up, ctx) => ackText(await getEngine(ctx).closeMailbox(params)),
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
		execute: async (_id, _params, _sig, _up, ctx) => {
			const status = await getEngine(ctx).dissolve();
			followTeam(engine);
			return teamText(status);
		},
	});
}
