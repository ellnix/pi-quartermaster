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
import type {
	Ack,
	AddMemberInput,
	WorkspaceInput,
	WorktreesInput,
	CloseMailboxInput,
	OpenMailboxInput,
	ConveneInput,
	ConveneMailboxInput,
	MemberStatus,
	RemoveMemberInput,
	SpecOverrideInput,
	TeamStatus,
} from "../engine.ts";
import type { QuartermasterConfig, AgentDef } from "../config/index.ts";
import type { MailboxDef } from "../config/mailboxes.ts";
import { validateSpec, type SpecDef } from "../config/spec.ts";
import { drawForSpec, type Candidate } from "../matching/matcher.ts";
import type { EvidenceStore } from "../matching/evidence.ts";
import type { Overrides } from "../matching/overrides.ts";
import { recordDir } from "../config/paths.ts";
import { NotGitError, WorktreeManager, worktreesReport, type Placement } from "./worktrees.ts";
import { crewmanTools, type CrewHooks, type SendReceipt } from "./crewman.ts";
import { appendAsk, appendChannel, appendComposition, appendResolution, askResolution, ensureRecord, pendingAsks, readReports } from "./record.ts";

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
	addedAt?: number;
	removedAt?: number;
	removedReason?: string;
	/** Where the member works; absent means the user's own tree. */
	placement?: Placement;
	/** The worktree has been removed (or deliberately kept) and must not be handled again. */
	treeReleased?: boolean;
	/** Messages waiting for this member's current run to finish. */
	pendingDelivery: Array<{ text: string }>;
	/**
	 * Channel changes since the member last heard from the engine, delivered
	 * for free as a preface to its next incoming message (an unstarted member
	 * learns them from its standing instructions instead).
	 */
	notices: string[];
}

/**
 * A channel opened for this team: the template plus the wired endpoints.
 * Identity is the wiring, not the file. A template wired once keeps its own
 * name as the id (and its log file, so existing records need no migration);
 * a template wired more than once gets `<template>__<from>--<to>` per
 * pairing, so one template can back any number of pairings.
 */
interface OpenChannel {
	/** Unique channel id: the log's name and the key traffic is isolated by. */
	id: string;
	/** The template's name. */
	name: string;
	template: MailboxDef;
	from: string;
	to: string;
	/** Closed when an endpoint is removed: no delivery, log preserved. */
	closed?: boolean;
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
	private trees: WorktreeManager;
	/** The project's worktrees.jsonc declares setup or copy, but the project is not trusted: they are skipped. */
	private untrustedSetup: boolean;
	/** Reports the quartermaster has read (read_channel "reports"); the rest are "unread". */
	private reportsSeen = 0;

	constructor(
		private ctx: ExtensionToolContext,
		private config: QuartermasterConfig,
		private evidence: EvidenceStore,
		private overrides: Overrides,
	) {
		// `setup` is shell from the repository's own config. pi gates project
		// config on trust for exactly this reason; so does this: an untrusted
		// project's worktrees.jsonc still places members, but runs nothing.
		const wt = config.worktrees;
		this.untrustedSetup =
			wt.filePath !== undefined && (wt.setup.length > 0 || wt.copy.length > 0) && ctx.isProjectTrusted?.() === false;
		this.trees = new WorktreeManager(ctx.cwd, this.untrustedSetup ? { ...wt, setup: [], copy: [] } : wt);
	}

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

		// The same template wired twice with the same endpoints is a caller
		// mistake, not a legal multiplicity: fail before anything is drawn.
		const duplicate = this.duplicateWiring(mailboxes);
		if (duplicate) throw new Error(duplicate);

		const starts: Array<{ member: FleetMember; task: string }> = [];

		// Members first: the channel wiring references them.
		this.teamId = `t${Date.now().toString(36)}`;
		this.recordPath = recordDir(this.teamId);
		ensureRecord(this.recordPath);

		for (const request of input.members) {
			const resolved = this.resolveAgent(request.agent, request.name);
			if (!resolved.ok) {
				warnings.push(`${resolved.error} — member skipped`);
				continue;
			}
			const agent = resolved.agent;
			if (this.members.has(agent.name)) {
				warnings.push(`member "${agent.name}" listed twice — second occurrence skipped (give it a distinct \`name\` to launch the same agent again)`);
				continue;
			}
			const member = await this.spawnMember(agent, request.spec, request, warnings);
			if (member) starts.push({ member, task: request.task?.trim() ?? "" });
		}

		// The convene wiring is the single authority for endpoints. A channel
		// whose endpoints are not members cannot open, but the rest of the
		// team is not held hostage by one bad wire.
		for (const wiring of mailboxes) {
			warnings.push(...this.openChannel(wiring, this.isMultiWired(wiring.name, mailboxes)));
		}

		// Runs begin only now: a member's standing instructions list the
		// team and the channels, which exist only once everyone is drawn.
		for (const { member, task } of starts) {
			this.logAdded(member, "convene");
			if (task !== "") this.startMember(member, task);
		}

		return this.status(warnings);
	}

	/**
	 * The agent to spawn, under the name it will go by in this team. The same
	 * definition can be launched any number of times under different names: the
	 * copy shares the definition's prompt, tools and spec, and `definition`
	 * keeps the lineage. Names are validated because they end up in branch
	 * names, channel ids and report attribution.
	 */
	private resolveAgent(agentName: string, asName?: string): { ok: true; agent: AgentDef } | { ok: false; error: string } {
		const base = this.config.agents.get(agentName);
		if (!base) return { ok: false, error: `agent "${agentName}" is not defined (see team_list for configured agents)` };
		if (asName === undefined) return { ok: true, agent: base };
		const name = asName.trim();
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.includes("--") || name.includes("__") || name.length > 48) {
			return {
				ok: false,
				error: `name "${asName}" is not usable: start with a letter or digit, then letters, digits, ".", "_" or "-" (no "--" or "__"), at most 48 characters`,
			};
		}
		if (name === "quartermaster") return { ok: false, error: `name "quartermaster" is reserved` };
		return { ok: true, agent: { ...base, name } };
	}

	/** A message when the batch wires one template to the same endpoints twice, or reopens an open wiring. */
	private duplicateWiring(wirings: ConveneMailboxInput[]): string | null {
		const seen = new Set<string>();
		for (const c of this.channels.values()) if (!c.closed) seen.add(JSON.stringify([c.name, c.from, c.to]));
		for (const w of wirings) {
			const key = JSON.stringify([w.name, w.from, w.to]);
			if (seen.has(key)) {
				return `mailbox "${w.name}" is wired twice from "${w.from}" to "${w.to}" — a duplicate wiring; wire each pairing once`;
			}
			seen.add(key);
		}
		return null;
	}

	/** One template backing several pairings (in this batch or with existing channels) gets pairing ids. */
	private isMultiWired(template: string, batch: ConveneMailboxInput[]): boolean {
		return batch.filter((w) => w.name === template).length > 1 || [...this.channels.values()].some((c) => c.name === template);
	}

	/** An active member: present and not removed. */
	private active(name: string): FleetMember | undefined {
		const member = this.members.get(name);
		return member && member.state !== "removed" ? member : undefined;
	}

	private logAdded(member: FleetMember, via: string): void {
		const rating = this.memberForRating(member.name);
		appendComposition(this.recordPath!, {
			type: "added",
			ts: member.addedAt ?? Date.now(),
			member: member.name,
			definition: member.agent.definition,
			model: member.modelId,
			dimensions: rating?.dimensions,
			via,
			worktree: member.placement && member.placement.mode !== "shared"
				? { mode: member.placement.mode, path: member.placement.path, branch: member.placement.branch, base: member.placement.base, attachedTo: member.placement.attachedTo }
				: undefined,
			by: "quartermaster",
		});
	}

	private openChannel(wiring: ConveneMailboxInput, multiWired: boolean): string[] {
		const warnings: string[] = [];
		const template = this.config.mailboxes.get(wiring.name);
		if (!template) {
			return [`mailbox "${wiring.name}" is not defined — channel skipped`];
		}
		const warningsFor: string[] = [];
		if (!this.active(wiring.from)) {
			warningsFor.push(`channel "${wiring.name}" wired from "${wiring.from}" who is not a member — channel will not open`);
		}
		if (!this.active(wiring.to)) {
			warningsFor.push(`channel "${wiring.name}" wired to "${wiring.to}" who is not a member — channel will not open`);
		}
		if (warningsFor.length > 0) return warningsFor;

		// Reopening a closed pairing revives its channel (same id, same log).
		const existing = [...this.channels.values()].find(
			(c) => c.name === wiring.name && c.from === wiring.from && c.to === wiring.to,
		);
		if (existing?.closed) {
			existing.closed = false;
			return warnings;
		}
		const id = multiWired ? `${wiring.name}__${wiring.from}--${wiring.to}` : wiring.name;
		if (this.channels.has(id)) return [`channel "${id}" already exists — skipped`];
		this.channels.set(id, { id, name: wiring.name, template, from: wiring.from, to: wiring.to });
		return warnings;
	}

	private async spawnMember(
		agent: AgentDef,
		specOverride: SpecOverrideInput | undefined,
		workspace: WorkspaceInput,
		warnings: string[],
		dropOnFailure = false,
	): Promise<FleetMember | undefined> {
		let result: FleetMember | undefined;
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
				notices: [],
			};
			this.members.set(member.name, member);

			const fail = (note: string): void => {
				member.state = "error";
				member.note = note;
				// A mid-flight add must leave the team unchanged on failure.
				if (dropOnFailure) this.members.delete(member.name);
			};

			const draw = await this.resolveModel(member, warnings);
			if (!draw.ok) {
				fail(draw.error);
				return;
			}
			member.modelId = draw.modelId;

			const slash = draw.modelId.indexOf("/");
			const model =
				this.ctx.modelRegistry.find(draw.modelId.slice(0, slash), draw.modelId.slice(slash + 1)) ?? undefined;
			if (!model || !this.ctx.modelRegistry.hasConfiguredAuth(model)) {
				fail(`drawn model ${draw.modelId} is not usable in this session`);
				return;
			}

			// Placement comes after the draw so a failed draw leaves no tree
			// behind, and before the session so its cwd can be the tree.
			let placement: Placement | undefined;
			try {
				placement = await this.place(member, workspace, warnings);
			} catch (err) {
				fail(err instanceof Error ? err.message : String(err));
				return;
			}
			member.placement = placement;

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
					isActive: () => member.state !== "removed" && member.state !== "dissolved",
					workspace: () =>
						member.placement && member.placement.mode !== "shared"
							? { branch: member.placement.branch, worktree: member.placement.path }
							: undefined,
				};
				const tools = crewmanTools(member.name, this.recordPath!, hooks);
				const allowlist = [...new Set([...(agent.tools ?? DEFAULT_TOOLS), ...tools.map((t) => t.name)])];
				const created = await createAgentSession({
					cwd: placement?.cwd ?? this.ctx.cwd,
					model,
					tools: allowlist,
					customTools: tools,
					sessionManager: SessionManager.inMemory(),
				});
				session = created.session;
			} catch (err) {
				fail(`child session failed to start: ${String(err)}`);
				// A tree made for a member that never started must not linger.
				if (placement?.mode === "per-member") {
					member.treeReleased = true;
					warnings.push(...(await this.trees.remove(placement, { discardDirty: true })));
				}
				return;
			} finally {
				delete process.env[CHILD_MARKER];
			}

			// Armed until started: session and model exist, no run, no tokens.
			// The caller starts it once the team's channels are open; with no
			// task, its first message does.
			member.session = session;
			member.state = "unstarted";
			result = member;
		});
		this.creationChain = creation.catch(() => {});
		await creation;
		return result;
	}

	/**
	 * Run a member's prompt, tracking its state. A removed or dissolved member
	 * stays so: a run settling after a forced removal must not resurrect it.
	 */
	private track(member: FleetMember, run: Promise<unknown>, what: string): void {
		const gone = () => member.state === "removed" || member.state === "dissolved";
		void run
			.then(() => {
				if (gone()) return;
				member.state = "idle";
				this.flushDeliveries(member);
			})
			.catch((err: unknown) => {
				if (gone()) return;
				member.state = "error";
				member.note = `${what} failed: ${String(err)}`;
			});
	}

	/**
	 * Decide and make a member's workspace. Mode precedence: the convene's own
	 * `worktree`, then the agent file's, then the project default (`auto`: its
	 * own tree if it can write, the user's tree if not). Returns undefined for
	 * the user's tree. Throws to fail the spawn: a half-provisioned or refused
	 * placement must never become a member quietly running in the wrong place.
	 */
	private async place(member: FleetMember, ws: WorkspaceInput, warnings: string[]): Promise<Placement | undefined> {
		const agent = member.agent;
		const writes = (agent.tools ?? DEFAULT_TOOLS).some((t) => t === "edit" || t === "write");
		const defaults = this.config.worktrees?.default ?? "auto";
		const mode = ws.worktree ?? agent.worktree ?? (defaults === "auto" && writes ? "per-member" : "shared");

		if (ws.attachTo !== undefined && mode !== "attach") {
			warnings.push(`${member.name}: attachTo is only used with worktree "attach" — ignored`);
		}
		if (mode === "shared") return undefined;

		if (mode === "attach") {
			if (writes) {
				throw new Error(
					`${member.name} is granted edit or write, so it may not attach to another member's worktree; use a read-only tool grant, or give it its own (worktree: per-member)`,
				);
			}
			if (!ws.attachTo) {
				throw new Error(`${member.name} is set to attach but names no owner: pass attachTo with the member whose worktree it joins`);
			}
			const owner = this.active(ws.attachTo);
			if (!owner) {
				throw new Error(`attachTo "${ws.attachTo}" is not an active member (list the owner before the members that attach to it)`);
			}
			const tree = owner.placement;
			if (tree?.mode !== "per-member") {
				throw new Error(`"${ws.attachTo}" has no worktree of its own to attach to (it works in the shared tree or is itself attached)`);
			}
			return { ...tree, mode: "attach", attachedTo: owner.name, provisioned: undefined };
		}

		if (this.untrustedSetup) {
			warnings.push(
				`${member.name}: .pi/team/worktrees.jsonc declares setup/copy, but this project is not trusted, so nothing was run or copied and its tree is bare. Trust the project in pi to enable provisioning.`,
			);
		}
		try {
			return await this.trees.create(this.teamId!, member.name);
		} catch (err) {
			if (err instanceof NotGitError) {
				warnings.push(
					`${member.name} runs in the SHARED tree: ${err.message}, so there is nothing to isolate it from. Its edits land directly in your working directory.`,
				);
				return undefined;
			}
			throw err;
		}
	}

	/** Remove a member's own worktree (never an attached view of someone else's), once. */
	private async releaseTree(member: FleetMember, opts: { discardDirty?: boolean } = {}): Promise<string[]> {
		const tree = member.placement;
		if (!tree || tree.mode !== "per-member" || member.treeReleased) return [];
		member.treeReleased = true;
		return this.trees.remove(tree, opts);
	}

	/** The standing instructions' WORKSPACE section; empty when the member works in the user's tree. */
	private workspaceLines(member: FleetMember): string[] {
		const tree = member.placement;
		if (!tree || tree.mode === "shared") return [];
		if (tree.mode === "attach") {
			return [
				"YOUR WORKSPACE:",
				`- Your working directory is ${tree.cwd}, the worktree of ${tree.attachedTo} (branch ${tree.branch}). You are attached to read it. Do not modify anything in it: ${tree.attachedTo} is still working there.`,
				"- You may read, run tests and inspect git history. If something needs changing, say so to its owner or in a report.",
			];
		}
		const setup = tree.provisioned;
		const bare = this.untrustedSetup || ((this.config.worktrees?.setup.length ?? 0) === 0 && (setup?.copied.length ?? 0) === 0);
		return [
			"YOUR WORKSPACE:",
			`- You work in your own git worktree, ${tree.cwd}, on branch ${tree.branch} (started from ${tree.base?.slice(0, 9)}). It is isolated: the user's working tree and other members' trees are separate, so do not reach into them.`,
			"- Commit your work to your branch. Never push, and never switch branches or change the base. Anything you leave uncommitted stays only in this tree.",
			"- Your report should state your branch and what is committed on it; the Quartermaster compares branches with git diff.",
			bare
				? "- No setup is declared for this repository (.pi/team/worktrees.jsonc), so this tree is bare: dependencies (vendor/, node_modules/) and untracked files such as .env are NOT present. Install what you need or say so in a report."
				: `- Provisioned before you started: ${[...(setup?.copied.length ? [`copied ${setup.copied.join(", ")}`] : []), ...(setup?.setup ?? []).map((c) => `ran "${c}"`)].join("; ")}.`,
		];
	}

	/** The `worktrees` tool: list this repository's quartermaster trees, or prune the unclaimed ones. */
	async worktrees(input: WorktreesInput): Promise<Ack> {
		const live = this.convened ? this.liveBranches() : new Set<string>();
		const result = await worktreesReport(this.trees, live, input);
		return result;
	}

	/** Branches of this session's active per-member trees: the janitor never prunes these. */
	liveBranches(): Set<string> {
		const live = new Set<string>();
		for (const m of this.members.values()) {
			if (m.state !== "removed" && m.state !== "dissolved" && m.placement?.mode === "per-member" && m.placement.branch) {
				live.add(m.placement.branch);
			}
		}
		return live;
	}

	/** Start a member's first run: standing instructions and channels, then the task. */
	private startMember(member: FleetMember, task: string): void {
		if (!member.session) return;
		member.state = "working";
		member.notices = [];
		const team = [...this.members.values()]
			.filter((m) => m.state !== "removed" && m.name !== member.name)
			.map((m) => ({ name: m.name, description: m.agent.description.split("\n")[0] }));
		const prompt = assembleSpawnPrompt(
			member.name,
			member.agent,
			task,
			this.channelsForMember(member.name),
			team,
			this.workspaceLines(member),
		);
		this.track(member, member.session.prompt(prompt), "run");
	}

	/**
	 * Route a send from a member through a sanctioned channel: validate the
	 * channel and the direction, log the traffic (the panopticon is real,
	 * which is what makes its declaration honest), then deliver.
	 */
	private routeSend(member: FleetMember, mailboxName: string, body: string): string | SendReceipt {
		const channel = this.resolveOutbound(member.name, mailboxName);
		const recipient = channel ? this.active(channel.to) : undefined;
		// One uniform refusal: never reveal whether the channel exists, how it
		// is wired, or who it belongs to. Members learn only their own graph.
		if (!channel || channel.from !== member.name || !recipient || !recipient.session) {
			return `no mailbox "${mailboxName}" is open for you to send through`;
		}

		const entry = appendChannel(this.recordPath!, channel.id, {
			channel: channel.id,
			ts: Date.now(),
			from: channel.from,
			to: channel.to,
			body,
		});
		this.deliver(recipient, channel.id, channel.from, channel.to, body, "followUp", entry.id);
		const back = [...this.channels.values()].find((c) => !c.closed && c.from === channel.to && c.to === member.name);
		return { id: entry.id, replyChannel: back?.id };
	}

	/**
	 * A sender's channel by id, or by template name when that names exactly
	 * one of the sender's outbound channels. Ambiguity resolves to nothing:
	 * the member must name the pairing's id.
	 */
	private resolveOutbound(sender: string, name: string): OpenChannel | undefined {
		const byId = this.channels.get(name);
		if (byId) return byId.closed ? undefined : byId;
		const matches = [...this.channels.values()].filter((c) => c.name === name && c.from === sender && !c.closed);
		return matches.length === 1 ? matches[0] : undefined;
	}

	/**
	 * The log ids a read_channel name denotes: a channel id, a template name
	 * (every wiring of it), or a pairing `from--to` (every channel between
	 * them). Unknown names pass through, so logs of earlier records stay
	 * readable by file name.
	 */
	channelLogIds(name: string): string[] {
		const byTemplate = [...this.channels.values()].filter((c) => c.name === name);
		if (byTemplate.length > 0) return byTemplate.map((c) => c.id);
		if (this.channels.has(name)) return [name];
		const byPair = [...this.channels.values()].filter((c) => `${c.from}--${c.to}` === name);
		if (byPair.length > 0) return byPair.map((c) => c.id);
		return [name];
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
		if (member.state === "removed") {
			return { ok: false, message: `${memberName} was removed from the team — it can no longer receive messages` };
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
		const channelLabel = this.channels.get(channel)?.name ?? channel;
		const preamble = template
			? template.preamble.replace(/\$\{from\}/g, from).replace(/\$\{to\}/g, to)
			: undefined;
		const framing = [
			`A message${id ? ` (${id})` : ""} arrives via ${channel === "quartermaster" ? "the Quartermaster" : `the ${channelLabel} mailbox`} from ${from}.`,
			preamble ? `\n${preamble}\n` : "",
		].join("\n");
		// Channel changes ride along with the next message for free. An unstarted
		// member gets the whole current picture in its standing instructions.
		const notices = recipient.notices.splice(0);
		const preface = notices.length > 0 && recipient.state !== "unstarted"
			? `CHANNEL CHANGES since you last heard from the Quartermaster:\n${notices.map((n) => `- ${n}`).join("\n")}\n\n`
			: "";
		const text = `${preface}${framing}\n${body}`;

		if (recipient.state === "unstarted") {
			// First input starts the member. There is nothing to steer, so
			// steer and follow-up behave identically here.
			this.startMember(recipient, text);
			return;
		}
		if (behavior === "steer" && recipient.state !== "working") {
			// Nothing to interrupt: a steer degrades to a plain prompt.
			this.track(recipient, recipient.session.prompt(text), "delivery");
			return;
		}
		if (behavior === "followUp" && (recipient.state === "working" || recipient.state === "convening")) {
			recipient.pendingDelivery.push({ text });
			return;
		}
		recipient.state = "working";
		this.track(
			recipient,
			recipient.session.prompt(text, { streamingBehavior: behavior === "steer" ? "steer" : "followUp" }),
			"delivery",
		);
	}

	private flushDeliveries(member: FleetMember): void {
		const next = member.pendingDelivery.shift();
		if (!next || !member.session) return;
		member.state = "working";
		this.track(member, member.session.prompt(next.text), "delivery");
	}

	/**
	 * Add a member to a live team. One draw, same matcher and gates; a failed
	 * draw leaves the team exactly as it was. Existing members are not
	 * disturbed, and their standing instructions are not rewritten.
	 */
	async addMember(input: AddMemberInput): Promise<Ack> {
		if (input.task !== undefined && input.task !== "" && input.task.trim() === "") {
			return { ok: false, message: `task is whitespace-only — give a real task, or omit it / pass "" to add ${input.agent} idle` };
		}
		const resolved = this.resolveAgent(input.agent, input.name);
		if (!resolved.ok) return { ok: false, message: resolved.error };
		const agent = resolved.agent;
		if (this.members.has(agent.name)) {
			const gone = this.members.get(agent.name)!.state === "removed";
			return {
				ok: false,
				message: gone
					? `"${agent.name}" was removed from this team earlier and its name stays in the record — add it again under another \`name\``
					: `"${agent.name}" is already a member — give this one a distinct \`name\` to launch ${input.agent} again`,
			};
		}
		const wirings = input.mailboxes ?? [];
		const duplicate = this.duplicateWiring(wirings);
		if (duplicate) return { ok: false, message: duplicate };

		const warnings: string[] = [];
		const member = await this.spawnMember(agent, input.spec, input, warnings, true);
		if (!member) {
			return { ok: false, message: `${agent.name} was not added; the team is unchanged`, warnings };
		}
		member.addedAt = Date.now();
		const before = new Set(this.channels.keys());
		for (const wiring of wirings) {
			warnings.push(...this.openChannel(wiring, this.isMultiWired(wiring.name, wirings)));
		}
		for (const channel of this.channels.values()) {
			if (!before.has(channel.id)) this.noteChannel(channel, "opened");
		}
		this.logAdded(member, "add_member");
		const task = input.task?.trim() ?? "";
		if (task !== "") this.startMember(member, task);
		return {
			ok: true,
			// Several draws can raise the same note; one line each.
			warnings: [...new Set(warnings)],
			message: `added ${member.name} on ${member.modelId}${task === "" ? " (idle, not started — its first message starts it)" : ""}. Existing members hear of any new channels at their next message.`,
		};
	}

	/**
	 * Open a channel on a live team: the same wiring rules as convene. An
	 * identical open wiring is refused; a closed one is revived.
	 */
	async openMailbox(input: OpenMailboxInput): Promise<Ack> {
		const wiring = { name: input.name, from: input.from, to: input.to };
		const duplicate = this.duplicateWiring([wiring]);
		if (duplicate) return { ok: false, message: duplicate };
		const before = new Set(this.channels.keys());
		const revived = [...this.channels.values()].find(
			(c) => c.closed && c.name === wiring.name && c.from === wiring.from && c.to === wiring.to,
		);
		const warnings = this.openChannel(wiring, this.isMultiWired(wiring.name, [wiring]));
		// openChannel reports refusals (unknown template, inactive endpoint) as
		// warnings; success is a new channel, or the revived one now open.
		const channel = revived && !revived.closed ? revived : [...this.channels.values()].find((c) => !before.has(c.id));
		if (!channel) return { ok: false, message: `mailbox not opened: ${warnings.join("; ") || "unknown reason"}` };
		this.noteChannel(channel, "opened");
		appendComposition(this.recordPath!, {
			type: "channel_opened",
			ts: Date.now(),
			channel: channel.id,
			template: channel.name,
			from: channel.from,
			to: channel.to,
			by: "quartermaster",
		});
		return {
			ok: true,
			message: `${revived ? "reopened" : "opened"} ${channel.id} (${channel.from} -> ${channel.to}). Both members are told at their next message (a member not yet started learns it from its standing instructions).`,
			warnings,
		};
	}

	/**
	 * Close a channel on a live team: it stops delivering in both
	 * directions (senders get the uniform "no mailbox" refusal), its log is
	 * preserved, and it can be reopened. Admin lever for an abused channel.
	 */
	async closeMailbox(input: CloseMailboxInput): Promise<Ack> {
		const all = [...this.channels.values()];
		// An exact id wins when it is open. A closed id falls through, because a
		// single-wired template's id is its name and may now also name others.
		let matches = all.filter((c) => c.id === input.channel && !c.closed);
		if (matches.length === 0) matches = all.filter((c) => `${c.from}--${c.to}` === input.channel && !c.closed);
		if (matches.length === 0) matches = all.filter((c) => c.name === input.channel && !c.closed);
		if (matches.length === 0) {
			const already = all.find((c) => c.id === input.channel);
			if (already) return { ok: false, message: `${already.id} is already closed` };
			return { ok: false, message: `no channel "${input.channel}" — open ones: ${all.filter((c) => !c.closed).map((c) => c.id).join(", ") || "none"}` };
		}
		if (matches.length > 1) {
			return { ok: false, message: `"${input.channel}" names ${matches.length} channels (${matches.map((c) => c.id).join(", ")}) — close one by id` };
		}
		const channel = matches[0];
		if (channel.closed) return { ok: false, message: `${channel.id} is already closed` };
		channel.closed = true;
		this.noteChannel(channel, "closed");
		appendComposition(this.recordPath!, {
			type: "channel_closed",
			ts: Date.now(),
			channel: channel.id,
			template: channel.name,
			from: channel.from,
			to: channel.to,
			reason: input.reason,
			by: "quartermaster",
		});
		return { ok: true, message: `closed ${channel.id} (${channel.from} -> ${channel.to}); its log is kept and it can be reopened with open_mailbox` };
	}

	/**
	 * Remove a member from a live team. Refuses while it works or has pending
	 * asks unless forced; force interrupts and auto-denies those asks with a
	 * recorded note. The member stays on the roster as history, its channels
	 * close with logs preserved, and it can still be rated.
	 */
	async removeMember(input: RemoveMemberInput): Promise<Ack> {
		const member = this.members.get(input.member);
		if (!member) return { ok: false, message: `no member named "${input.member}" — see team_list` };
		if (member.state === "removed") return { ok: false, message: `${input.member} was already removed` };

		const busy = member.state === "working" || member.state === "convening";
		const asks = pendingAsks(this.recordPath!).filter((a) => a.member === member.name);
		if (!input.force && (busy || asks.length > 0)) {
			const why = [
				busy ? `it is ${member.state}` : "",
				asks.length > 0 ? `${asks.length} permission ask(s) are pending (${asks.map((a) => a.id).join(", ")})` : "",
			].filter(Boolean);
			return {
				ok: false,
				message: `${input.member} was not removed: ${why.join(" and ")}. Wait, resolve the asks, or pass force: true to interrupt it and deny its asks.`,
			};
		}

		const readers = [...this.members.values()].filter(
			(m) => m.state !== "removed" && m.placement?.mode === "attach" && m.placement.attachedTo === member.name,
		);
		if (readers.length > 0) {
			return {
				ok: false,
				message: `${input.member} was not removed: ${readers.map((m) => m.name).join(", ")} ${readers.length > 1 ? "are" : "is"} attached to its worktree. Remove ${readers.length > 1 ? "them" : "it"} first.`,
			};
		}

		for (const ask of asks) {
			appendResolution(this.recordPath!, {
				ts: Date.now(),
				id: ask.id,
				approve: false,
				by: "quartermaster",
				note: `denied: ${member.name} was removed from the team`,
			});
		}
		const session = member.session;
		member.session = undefined;
		member.state = "removed";
		member.removedAt = Date.now();
		member.removedReason = input.reason;
		member.pendingDelivery = [];
		const warnings: string[] = [];
		if (session) {
			try {
				if (busy) await session.abort();
			} catch (err) {
				warnings.push(`interrupting ${member.name} failed: ${String(err)}`);
			}
			try {
				session.dispose();
			} catch (err) {
				warnings.push(`disposing ${member.name} failed: ${String(err)}`);
			}
		}
		for (const channel of this.channels.values()) {
			if (channel.from === member.name || channel.to === member.name) channel.closed = true;
		}
		// Its tree goes with it unless it holds uncommitted work or commits, which are kept.
		warnings.push(...(await this.releaseTree(member)));
		const rating = this.memberForRating(member.name);
		appendComposition(this.recordPath!, {
			type: "removed",
			ts: member.removedAt,
			member: member.name,
			definition: member.agent.definition,
			model: member.modelId,
			dimensions: rating?.dimensions,
			reason: input.reason,
			forced: input.force ? true : undefined,
			by: "quartermaster",
		});
		return {
			ok: true,
			message: `removed ${member.name}${asks.length ? `, denying ${asks.length} pending ask(s)` : ""}; its channels are closed and its record kept. rate_member still works for it.`,
			warnings,
		};
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
			if (channel.closed) continue;
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
			definition: m.agent.definition !== m.name ? m.agent.definition : undefined,
			description: m.agent.description.split("\n")[0],
			spec: m.spec ? `τ${m.spec.temperature} ${Object.keys(m.spec.weights).join(",")}` : undefined,
			model: m.modelId,
			state: m.state,
			note: m.note,
			workspace:
				m.placement && m.placement.mode !== "shared"
					? { mode: m.placement.mode, path: m.placement.path, branch: m.placement.branch, attachedTo: m.placement.attachedTo }
					: undefined,
			addedAt: m.addedAt,
			removedAt: m.removedAt,
			removedReason: m.removedReason,
		}));
		return {
			convened: this.convened,
			teamId: this.teamId,
			members,
			openMailboxes: [...this.channels.values()].filter((c) => !c.closed).map((c) => `${c.id} (${c.from} -> ${c.to})`),
			pendingAsks: this.recordPath ? pendingAsks(this.recordPath).length : 0,
			unreadReports: this.recordPath ? Math.max(0, readReports(this.recordPath).length - this.reportsSeen) : 0,
			// The same warning from several members (an exclusion note, say) is one warning.
			warnings: [...new Set(extraWarnings)],
		};
	}

	/** The quartermaster has read the reports so far; "unread" counts only newer ones. */
	markReportsRead(): void {
		if (this.recordPath) this.reportsSeen = readReports(this.recordPath).length;
	}

	/** Tell both ends of a channel what changed, at their next message. */
	private noteChannel(channel: OpenChannel, what: "opened" | "closed"): void {
		const from = this.active(channel.from);
		const to = this.active(channel.to);
		if (what === "opened") {
			from?.notices.push(`You can now send to ${channel.to} through the mailbox ${channel.id} (send tool).`);
			to?.notices.push(`${channel.from} may now send you messages through the mailbox ${channel.id}.`);
		} else {
			from?.notices.push(`The mailbox ${channel.id} to ${channel.to} is closed; sends through it are refused.`);
			to?.notices.push(`The mailbox ${channel.id} from ${channel.from} is closed; nothing more will arrive on it.`);
		}
	}

	async dissolve(): Promise<TeamStatus> {
		const warnings: string[] = [];
		for (const member of this.members.values()) {
			if (member.state === "removed") continue;
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
		// Trees after every session is down. Removed members already released theirs.
		for (const member of this.members.values()) {
			if (member.placement?.mode !== "per-member" || member.treeReleased) continue;
			if (this.config.worktrees?.keepOnDissolve) {
				member.treeReleased = true;
				warnings.push(`kept worktree ${member.placement.path} (branch ${member.placement.branch}): keepOnDissolve is set`);
				continue;
			}
			warnings.push(...(await this.releaseTree(member)));
		}
		for (const channel of this.channels.values()) channel.closed = true;
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
	team: Array<{ name: string; description: string }> = [],
	workspace: string[] = [],
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
	if (team.length > 0) {
		lines.push("", "THE TEAM RIGHT NOW (besides you):");
		for (const m of team) lines.push(`- ${m.name}: ${m.description}`);
	}
	if (channels.outbound.length > 0) {
		lines.push("", "CHANNELS YOU CAN SEND THROUGH (with the send tool):");
		for (const ch of channels.outbound) {
			lines.push(`- ${ch.id} -> ${ch.to}`);
		}
		lines.push(
			"These mailboxes are sanctioned by the Quartermaster: you are expected to use them, and doing so lightens its load. " +
				"When you need a clarification, a finding relayed, or context a crewmate holds, send it straight to them rather than waiting on the Quartermaster or guessing. " +
				"The recipient already knows who you are and is ready for your messages; do not introduce yourself, just say what you need.",
		);
	}
	if (channels.inbound.length > 0) {
		lines.push("", "CHANNELS THAT MAY DELIVER TO YOU:");
		for (const ch of channels.inbound) {
			lines.push(`- ${ch.id} <- ${ch.from}`);
		}
	}
	if (workspace.length > 0) lines.push("", ...workspace);
	lines.push("", "YOUR TASK:", task);
	return lines.join("\n");
}
