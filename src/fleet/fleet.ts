/**
 * The fleet: convene, observe, message, dissolve.
 *
 * Each member is a full child session created in-process through the pi
 * SDK — in-memory session manager, the tool allowlist from the agent
 * file, the crewman tools, and one model drawn at convening (never per
 * message, so a member's context and prompt cache stay warm across
 * follow-ups). The constitutional introduction is assembled here, in
 * code, single-sourced: it must not be possible for an agent file to
 * forget it or opt out.
 *
 * The channel repository is the convene call's wiring: mailbox
 * definitions are preamble templates without endpoints, and every
 * delivery resolves from/to through the wiring — the preamble's
 * ${from}/${to} placeholders are substituted at delivery, so a
 * role-voiced template cannot lie under arbitrary wiring.
 */

import {
	createAgentSession,
	type AgentSession,
	type ExtensionToolContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ConveneInput, ConveneMailboxInput, MemberStatus, SpecOverrideInput, TeamStatus } from "../engine.ts";
import type { QuartermasterConfig, AgentDef } from "../config/index.ts";
import type { MailboxDef } from "../config/mailboxes.ts";
import { validateSpec, type SpecDef } from "../config/spec.ts";
import { drawForSpec, type Candidate } from "../matching/matcher.ts";
import type { EvidenceStore } from "../matching/evidence.ts";
import type { Overrides } from "../matching/overrides.ts";
import { recordDir } from "../config/paths.ts";
import { crewmanTools, type CrewHooks, type SendReceipt } from "./crewman.ts";
import { appendAsk, appendChannel, askResolution, ensureRecord, pendingAsks, readReports } from "./record.ts";

/** Set around child session creation; quartermaster.ts stays inert under it. */
export const CHILD_MARKER = "QM_CHILD";

interface FleetMember {
	name: string;
	agent: AgentDef;
	/** The resolved spec this member was convened under. */
	spec?: SpecDef;
	modelId?: string;
	session?: AgentSession;
	state: MemberStatus["state"];
	note?: string;
	/** Messages waiting for this member's current run to finish. */
	pendingDelivery: Array<{ text: string }>;
}

/** A channel opened for this team: the template plus the wired endpoints. */
interface OpenChannel {
	name: string;
	template: MailboxDef;
	from: string;
	to: string;
}

/** Tools a member gets when its agent file grants none: read-only. */
const DEFAULT_TOOLS = ["read", "ls", "find", "grep"];

export class Fleet {
	private members = new Map<string, FleetMember>();
	private teamId?: string;
	private recordPath?: string;
	private channels = new Map<string, OpenChannel>();
	/** Serialized creation: the child marker is process-global. */
	private creationChain: Promise<void> = Promise.resolve();

	constructor(
		private ctx: ExtensionToolContext,
		private config: QuartermasterConfig,
		private evidence: EvidenceStore,
		private overrides: Overrides,
	) {}

	get convened(): boolean {
		return this.teamId !== undefined;
	}

	/** The team record path, when a team is convened. */
	get record(): string | undefined {
		return this.recordPath;
	}

	async convene(input: ConveneInput): Promise<TeamStatus> {
		if (this.convened) {
			return this.status(["a team is already convened — dissolve_team before convening another"]);
		}

		// An accidental whitespace-only task must fail, not silently start a
		// member with nothing to do. Empty or omitted means "convene armed".
		for (const request of input.members) {
			if (request.task !== undefined && request.task !== "" && request.task.trim() === "") {
				throw new Error(
					`member "${request.agent}": task is whitespace-only — give a real task, or omit it / pass "" to convene the member idle`,
				);
			}
		}

		const warnings: string[] = [];
		const mailboxes = input.mailboxes ?? [];

		// Members first: the channel wiring references them.
		this.teamId = `t${Date.now().toString(36)}`;
		this.recordPath = recordDir(this.teamId);
		ensureRecord(this.recordPath);

		for (const request of input.members) {
			const agent = this.config.agents.get(request.agent);
			if (!agent) {
				warnings.push(`agent "${request.agent}" is not defined — member skipped (see team_list for configured agents)`);
				continue;
			}
			if (this.members.has(agent.name)) {
				warnings.push(`member "${agent.name}" listed twice — second occurrence skipped`);
				continue;
			}
			await this.spawnMember(agent, request.spec, request.task?.trim() ?? "", warnings);
		}

		// The convene wiring is the single authority for endpoints. A channel
		// whose endpoints are not members cannot open, but the rest of the
		// team is not held hostage by one bad wire.
		for (const wiring of mailboxes) {
			warnings.push(...this.openChannel(wiring));
		}

		return this.status(warnings);
	}

	private openChannel(wiring: ConveneMailboxInput): string[] {
		const warnings: string[] = [];
		const template = this.config.mailboxes.get(wiring.name);
		if (!template) {
			return [`mailbox "${wiring.name}" is not defined — channel skipped`];
		}
		if (this.channels.has(wiring.name)) {
			return [`channel "${wiring.name}" listed twice — second occurrence skipped`];
		}
		const warningsFor: string[] = [];
		if (!this.members.has(wiring.from)) {
			warningsFor.push(`channel "${wiring.name}" wired from "${wiring.from}" who is not a member — channel will not open`);
		}
		if (!this.members.has(wiring.to)) {
			warningsFor.push(`channel "${wiring.name}" wired to "${wiring.to}" who is not a member — channel will not open`);
		}
		if (warningsFor.length > 0) return warningsFor;

		this.channels.set(wiring.name, { name: wiring.name, template, from: wiring.from, to: wiring.to });
		return warnings;
	}

	private async spawnMember(
		agent: AgentDef,
		specOverride: SpecOverrideInput | undefined,
		task: string,
		warnings: string[],
	): Promise<void> {
		// The child marker is process-global, so creations serialize.
		const creation = this.creationChain.then(async () => {
			// The convene override is built on the fly and wins; the agent's
			// own inline spec is the reusable form. Both are objects now. Its
			// validation warnings join the convene result: a spec the user
			// believes is enforced but silently dropped (a minScores key the
			// parser refuses, say) is worse than no spec at all.
			let spec: SpecDef | undefined = agent.spec;
			if (specOverride !== undefined) {
				const specWarnings: Array<{ file: string; message: string }> = [];
				spec = validateSpec(specOverride, `convene member ${agent.name}`, specWarnings) ?? undefined;
				for (const w of specWarnings) warnings.push(`${w.file}: ${w.message}`);
			}
			const member: FleetMember = {
				name: agent.name,
				agent,
				spec,
				state: "convening",
				pendingDelivery: [],
			};
			this.members.set(member.name, member);

			const draw = await this.resolveModel(member, warnings);
			if (!draw.ok) {
				member.state = "error";
				member.note = draw.error;
				return;
			}
			member.modelId = draw.modelId;

			const slash = draw.modelId.indexOf("/");
			const model =
				this.ctx.modelRegistry.find(draw.modelId.slice(0, slash), draw.modelId.slice(slash + 1)) ?? undefined;
			if (!model || !this.ctx.modelRegistry.hasConfiguredAuth(model)) {
				member.state = "error";
				member.note = `drawn model ${draw.modelId} is not usable in this session`;
				return;
			}

			process.env[CHILD_MARKER] = "1";
			let session: AgentSession;
			try {
				// The SDK's tools allowlist filters custom tools too, so the
				// crewman channels must be named in it explicitly. The agent
				// file's tools list governs built-ins; the engine always grants
				// the channels — a member cannot be stripped of reporting.
				const hooks: CrewHooks = {
					onSend: (mailbox, body) => this.routeSend(member, mailbox, body),
					onAsk: (tool, args, why) => this.registerAsk(member, tool, args, why),
				};
				const tools = crewmanTools(member.name, this.recordPath!, hooks);
				const allowlist = [...new Set([...(agent.tools ?? DEFAULT_TOOLS), ...tools.map((t) => t.name)])];
				const created = await createAgentSession({
					cwd: this.ctx.cwd,
					model,
					tools: allowlist,
					customTools: tools,
					sessionManager: SessionManager.inMemory(),
				});
				session = created.session;
			} catch (err) {
				member.state = "error";
				member.note = `child session failed to start: ${String(err)}`;
				return;
			} finally {
				delete process.env[CHILD_MARKER];
			}

			member.session = session;
			if (task === "") {
				// Armed: session, model and channels exist; no run, no tokens.
				// The first message starts it.
				member.state = "unstarted";
				return;
			}
			this.startMember(member, task);
		});
		this.creationChain = creation.catch(() => {});
		await creation;
	}

	/** Start a member's first run: standing instructions and channels, then the task. */
	private startMember(member: FleetMember, task: string): void {
		if (!member.session) return;
		member.state = "working";
		const prompt = assembleSpawnPrompt(member.name, member.agent, task, this.channelsForMember(member.name));
		void member.session
			.prompt(prompt)
			.then(() => {
				member.state = "idle";
				this.flushDeliveries(member);
			})
			.catch((err: unknown) => {
				member.state = "error";
				member.note = `run failed: ${String(err)}`;
			});
	}

	/**
	 * Route a send from a member through a sanctioned channel: validate the
	 * channel and the direction, log the traffic (the panopticon is real,
	 * which is what makes its declaration honest), then deliver.
	 */
	private routeSend(member: FleetMember, mailboxName: string, body: string): string | SendReceipt {
		const channel = this.channels.get(mailboxName);
		const recipient = channel ? this.members.get(channel.to) : undefined;
		// One uniform refusal: never reveal whether the channel exists, how it
		// is wired, or who it belongs to. Members learn only their own graph.
		if (!channel || channel.from !== member.name || !recipient || !recipient.session) {
			return `no mailbox "${mailboxName}" is open for you to send through`;
		}

		const entry = appendChannel(this.recordPath!, mailboxName, {
			channel: mailboxName,
			ts: Date.now(),
			from: channel.from,
			to: channel.to,
			body,
		});
		this.deliver(recipient, mailboxName, channel.from, channel.to, body, "followUp", entry.id);
		return { id: entry.id };
	}

	/**
	 * Quartermaster-to-member delivery: the steer flag says whether the
	 * message interrupts the member's current run (pi can steer a running
	 * agent between its inputs) or queues as a follow-up.
	 */
	message(memberName: string, body: string, steer: boolean): { ok: boolean; message: string } {
		const member = this.members.get(memberName);
		if (!member) {
			return { ok: false, message: `no member named "${memberName}" — see team_list` };
		}
		const entry = appendChannel(this.recordPath!, "quartermaster", {
			channel: "quartermaster",
			ts: Date.now(),
			from: "quartermaster",
			to: memberName,
			body,
		});
		this.deliver(member, "quartermaster", "quartermaster", memberName, body, steer ? "steer" : "followUp", entry.id);
		return { ok: true, message: `sent to ${memberName} as ${entry.id}${steer ? " (steering)" : ""}` };
	}

	private deliver(
		recipient: FleetMember,
		channel: string,
		from: string,
		to: string,
		body: string,
		behavior: "steer" | "followUp",
		id?: string,
	): void {
		if (!recipient.session) {
			recipient.note = `undeliverable message for ${recipient.name}: no session`;
			return;
		}

		// The preamble is the template with the wired endpoints substituted,
		// so role-voiced templates stay truthful under any wiring. Channels
		// without placeholders are used verbatim.
		const template = this.channels.get(channel)?.template;
		const preamble = template
			? template.preamble.replace(/\$\{from\}/g, from).replace(/\$\{to\}/g, to)
			: undefined;
		const framing = [
			`A message${id ? ` (${id})` : ""} arrives via ${channel === "quartermaster" ? "the Quartermaster" : `the ${channel} mailbox`} from ${from}.`,
			preamble ? `\n${preamble}\n` : "",
		].join("\n");
		const text = `${framing}\n${body}`;

		if (recipient.state === "unstarted") {
			// First input starts the member. There is nothing to steer, so
			// steer and follow-up behave identically here.
			this.startMember(recipient, text);
			return;
		}
		if (behavior === "steer" && recipient.state !== "working") {
			// Nothing to interrupt: a steer degrades to a plain prompt.
			void recipient.session.prompt(text).then(() => {
				recipient.state = "idle";
				this.flushDeliveries(recipient);
			}).catch((err: unknown) => {
				recipient.state = "error";
				recipient.note = `delivery failed: ${String(err)}`;
			});
			return;
		}
		if (behavior === "followUp" && (recipient.state === "working" || recipient.state === "convening")) {
			recipient.pendingDelivery.push({ text });
			return;
		}
		recipient.state = "working";
		void recipient.session
			.prompt(text, { streamingBehavior: behavior === "steer" ? "steer" : "followUp" })
			.then(() => {
				recipient.state = "idle";
				this.flushDeliveries(recipient);
			})
			.catch((err: unknown) => {
				recipient.state = "error";
				recipient.note = `delivery failed: ${String(err)}`;
			});
	}

	private flushDeliveries(member: FleetMember): void {
		const next = member.pendingDelivery.shift();
		if (!next || !member.session) return;
		member.state = "working";
		void member.session
			.prompt(next.text)
			.then(() => {
				member.state = "idle";
				this.flushDeliveries(member);
			})
			.catch((err: unknown) => {
				member.state = "error";
				member.note = `delivery failed: ${String(err)}`;
			});
	}

	/**
	 * Resolve a member for rating: its drawn model and the dimensions its
	 * spec weights (excluding cost, which is a fact, not an outcome). The
	 * quartermaster rates members; the engine translates to evidence.
	 */
	memberForRating(memberName: string): { modelId: string; dimensions: Array<{ dimension: string; weight: number }> } | null {
		const member = this.members.get(memberName);
		if (!member?.modelId) return null;
		const spec = member.spec;
		const dimensions: Array<{ dimension: string; weight: number }> = [];
		if (spec) {
			for (const [dimension, weight] of Object.entries(spec.weights)) {
				if (dimension !== "cost" && weight > 0) dimensions.push({ dimension, weight });
			}
		}
		return { modelId: member.modelId, dimensions };
	}

	/**
	 * A child asked for a tool outside its granted set. The ask lands in the
	 * record; the child waits while the quartermaster resolves it through
	 * resolve_ask, which appends the resolution here. File-mediated, so the
	 * waiting and the resolution never depend on shared live state.
	 */
	private registerAsk(member: FleetMember, tool: string, args: string, why: string): Promise<{ approve: boolean; note: string }> {
		const id = `${Date.now().toString(36)}-${member.name}`;
		appendAsk(this.recordPath!, { id, ts: Date.now(), member: member.name, tool, args, why });
		const recordPath = this.recordPath!;
		return new Promise((resolve) => {
			const started = Date.now();
			const poll = setInterval(() => {
				const resolution = askResolution(recordPath, id);
				if (resolution) {
					clearInterval(poll);
					const note = resolution.approve
						? `approved by the Quartermaster${resolution.userConfirmed ? ` (user confirmed: ${resolution.userConfirmed})` : ""}`
						: `denied by the Quartermaster${resolution.userConfirmed ? ` (user: ${resolution.userConfirmed})` : ""}`;
					resolve({ approve: resolution.approve, note });
					return;
				}
				if (Date.now() - started > 11 * 60 * 1000) {
					clearInterval(poll);
					resolve({ approve: false, note: "unresolved" });
				}
			}, 1000);
		});
	}

	/** The channels a member may send through, and those that may deliver to it. */
	private channelsForMember(memberName: string): { outbound: OpenChannel[]; inbound: OpenChannel[] } {
		const outbound: OpenChannel[] = [];
		const inbound: OpenChannel[] = [];
		for (const channel of this.channels.values()) {
			if (channel.from === memberName) outbound.push(channel);
			if (channel.to === memberName) inbound.push(channel);
		}
		return { outbound, inbound };
	}

	private async resolveModel(
		member: FleetMember,
		warnings: string[],
	): Promise<{ ok: true; modelId: string } | { ok: false; error: string }> {
		if (member.agent.model) {
			return { ok: true, modelId: member.agent.model };
		}

		const spec = member.spec;
		if (!spec) {
			return { ok: false, error: "no spec and no model pin — the agent file must set one" };
		}

		const candidates: Candidate[] = this.ctx.modelRegistry
			.getAvailable()
			.map((model) => ({
				modelId: `${model.provider}/${model.id}`,
				name: model.name,
				provider: String(model.provider),
				input: model.input as string[],
				catalogCostPerMtok: model.cost?.input ?? 1,
				hasAuth: this.ctx.modelRegistry.hasConfiguredAuth(model),
			}));

		const result = drawForSpec(candidates, this.config, this.overrides, this.evidence, spec, "member spec");
		warnings.push(...result.notes);
		if (!result.ok) return { ok: false, error: result.error };
		return { ok: true, modelId: result.modelId };
	}

	status(extraWarnings: string[] = []): TeamStatus {
		const members: MemberStatus[] = [...this.members.values()].map((m) => ({
			name: m.name,
			description: m.agent.description.split("\n")[0],
			spec: m.spec ? `τ${m.spec.temperature} ${Object.keys(m.spec.weights).join(",")}` : undefined,
			model: m.modelId,
			state: m.state,
			note: m.note,
		}));
		return {
			convened: this.convened,
			teamId: this.teamId,
			members,
			openMailboxes: [...this.channels.values()].map((c) => `${c.name} (${c.from} -> ${c.to})`),
			pendingAsks: this.recordPath ? pendingAsks(this.recordPath).length : 0,
			unreadReports: this.recordPath ? readReports(this.recordPath).length : 0,
			warnings: extraWarnings,
		};
	}

	async dissolve(): Promise<TeamStatus> {
		const warnings: string[] = [];
		for (const member of this.members.values()) {
			if (member.session) {
				try {
					member.session.dispose();
				} catch (err) {
					warnings.push(`member "${member.name}" failed to dispose cleanly: ${String(err)}`);
				}
			}
			member.session = undefined;
			member.state = "dissolved";
		}
		const dissolved = this.status(warnings);
		// The record persists: a reconvened team reads it as its blackboard.
		this.members.clear();
		this.teamId = undefined;
		this.recordPath = undefined;
		this.channels.clear();
		return dissolved;
	}
}

/**
 * Constitutional spawn assembly. Injected in code, single-sourced: no
 * agent file can forget it, and no member convenes sub-teams. The
 * channel listings name both directions: what the member may send
 * through, and what may arrive unsolicited.
 */
function assembleSpawnPrompt(
	memberName: string,
	agent: AgentDef,
	task: string,
	channels: { outbound: OpenChannel[]; inbound: OpenChannel[] },
): string {
	const lines = [
		`You are ${memberName}, a member of a team convened by the Quartermaster.`,
		"",
		agent.systemPrompt,
		"",
		"OPERATING RULES:",
		"- The Quartermaster is the orchestrating session that speaks with the user. You never see its conversation.",
		"- All traffic between members is visible to the Quartermaster. Nothing you send is private.",
		"- Report results to the Quartermaster with the report tool at meaningful milestones and at completion. The report number it echoes back can be cited to steer you.",
		"- Permission questions about actions outside your granted tools go to the Quartermaster via request-permission.",
		"- Your task below is the whole of what the Quartermaster delegated. If it is incomplete or ambiguous, say so in a report instead of guessing.",
	];
	if (channels.outbound.length > 0) {
		lines.push("", "CHANNELS YOU CAN SEND THROUGH (with the send tool):");
		for (const ch of channels.outbound) {
			lines.push(`- ${ch.name} -> ${ch.to}`);
		}
	}
	if (channels.inbound.length > 0) {
		lines.push("", "CHANNELS THAT MAY DELIVER TO YOU:");
		for (const ch of channels.inbound) {
			lines.push(`- ${ch.name} <- ${ch.from}`);
		}
	}
	lines.push("", "YOUR TASK:", task);
	return lines.join("\n");
}
