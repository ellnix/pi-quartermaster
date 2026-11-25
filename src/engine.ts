/**
 * The engine contract: what the quartermaster tools call.
 *
 * The tool surface in quartermaster.ts is final — it delegates every call to
 * this interface. Later modules (config discovery, the matcher, the fleet)
 * implement the operations; the scaffold ships an engine that reports its
 * not-configured state so the surface is callable from the first commit.
 */

import type { WakePolicy } from "./config/authority.ts";
import type { WorktreeMode } from "./config/agents.ts";

/**
 * A spec built on the fly by the quartermaster. The persistent form —
 * what an agent file references — lives in the config module's specs;
 * this inline form exists so an override never has to be named and
 * saved just to be used once.
 */
export interface SpecOverrideInput {
	/** Dimension weights; suitability = dot product with a model's scores. */
	weights: Record<string, number>;
	/** Softmax temperature, 0 (deterministic) to 5 (maximum chaos). */
	temperature?: number;
	filters?: {
		/** Input modalities a candidate must support: "text", "image". */
		require?: string[];
		/** Minimum cost score of a candidate (0-1, 1 = cheapest). */
		minCostScore?: number;
		/** Minimum deterministic score per dimension (0-1) — a requirement of the draw. */
		minScores?: Record<string, number>;
		/** Let unrated models (no scores anywhere) into the pool. */
		allowUnrated?: boolean;
	};
}

/** Where a member works; see AgentDef.worktree. */
export type WorktreeModeInput = "shared" | "per-member" | "attach";

/** Workspace placement, shared by convene members and add_member. */
export interface WorkspaceInput {
	/**
	 * Override where this member works for this deployment: `shared` (the
	 * user's tree), `per-member` (its own git worktree and branch) or
	 * `attach` (placed in another member's worktree; needs `attachTo`, and
	 * the agent must not be granted edit or write). Absent: the agent file's
	 * `worktree`, else per-member for agents that can write and shared for
	 * the rest.
	 */
	worktree?: WorktreeModeInput;
	/** For `attach`: the member that owns the worktree. It must already exist. */
	attachTo?: string;
}

export interface ConveneMemberInput extends WorkspaceInput {
	/** Agent definition name (the `name` in an agent .md file). */
	agent: string;
	/**
	 * Overrides the agent's spec for this deployment, built on the fly.
	 * Reusable specs are attached to agent definitions; an override that
	 * must be named is a spec that belongs in a file, not here.
	 */
	spec?: SpecOverrideInput;
	/**
	 * The complete, self-contained task for this member. Optional: with no
	 * task (omitted or "") the member convenes idle and not started — no run,
	 * no tokens — and its first message starts it. Whitespace-only fails.
	 */
	task?: string;
}

/**
 * One channel in the team's channel repository. This wiring is the
 * single authority for from and to: mailbox definitions are preamble
 * templates and carry no endpoints, and every other structure resolves
 * them through this repository rather than carrying its own copy.
 *
 * Because a template can be wired to any pair of members, a preamble
 * written in role terms ("FROM THE BUILDER WHOSE CODE YOU ARE
 * REVIEWING") would lie under different wiring. Templates may
 * therefore reference ${from} and ${to}; the engine substitutes the
 * wired endpoints into the preamble at delivery. A preamble without
 * placeholders is used verbatim and should be written generically.
 */
export interface ConveneMailboxInput {
	/** Mailbox definition name (the template supplying the preamble). */
	name: string;
	/** Sender member. */
	from: string;
	/** Recipient member. */
	to: string;
}

export interface AddMemberInput extends WorkspaceInput {
	/** Agent or variant name. */
	agent: string;
	spec?: SpecOverrideInput;
	/** Optional: omit or "" to add the member armed (idle, not started). */
	task?: string;
	/** Channels to open, extending the graph; existing wiring is untouched. */
	mailboxes?: ConveneMailboxInput[];
}

export interface WorktreesInput {
	/** Remove quartermaster worktrees not claimed by this session's live members. */
	prune?: boolean;
	/** Prune only this team's trees (a team id from the listing). */
	team?: string;
	/** Prune every team's unclaimed trees. Another running session's trees look unclaimed here; prefer `team`. */
	all?: boolean;
	/** Also remove trees with uncommitted changes. Branches with commits are still kept. */
	discardDirty?: boolean;
}

export interface OpenMailboxInput {
	/** Mailbox template name. */
	name: string;
	from: string;
	to: string;
}

export interface CloseMailboxInput {
	/** A channel id, a `from--to` pairing, or a template name when only one of its channels is open. */
	channel: string;
	reason?: string;
}

export interface RemoveMemberInput {
	member: string;
	reason?: string;
	/** Interrupt a working member and deny its pending asks, then remove. */
	force?: boolean;
}

export interface ConveneInput {
	members: ConveneMemberInput[];
	/** The team's relationship graph: channels to open, with endpoints. */
	mailboxes?: ConveneMailboxInput[];
}

export interface MemberStatus {
	/** Member name in this team (the agent definition name). */
	name: string;
	/** The agent definition (file) this member came from, when it is a variant. */
	definition?: string;
	description: string;
	spec?: string;
	model?: string;
	/** Where the member works, when it is isolated or attached; absent = the user's tree. */
	workspace?: { mode: "per-member" | "attach"; path: string; branch?: string; attachedTo?: string };
	/** Set on members added mid-flight (add_member). */
	addedAt?: number;
	/** Set once removed; the member stays on the roster as history. */
	removedAt?: number;
	removedReason?: string;
	/**
	 * A union of string literals rather than an enum: the TypeScript
	 * idiom. It is compile-time-checked everywhere the value is read or
	 * written, serializes as plain strings, and adds no runtime object.
	 */
	state: "convening" | "unstarted" | "working" | "idle" | "removed" | "dissolved" | "error";
	note?: string;
}

/** What the user's configuration offers, shown while planning a convene. */
export interface AvailableConfig {
	agents: Array<{ name: string; definition?: string; description: string; tools: string; spec: string; pinnedModel?: string; worktree?: WorktreeMode }>;
	mailboxes: Array<{ name: string; description: string }>;
}

export interface TeamStatus {
	/** Configured agents and mailboxes; present when no team is convened. */
	available?: AvailableConfig;
	convened: boolean;
	teamId?: string;
	members: MemberStatus[];
	openMailboxes: string[];
	pendingAsks: number;
	unreadReports: number;
	warnings: string[];
}

export interface ChannelMessage {
	/** The channel this traveled on: a mailbox name, "reports", or "quartermaster". */
	channel: string;
	ts: number;
	body: string;
}

export interface ReadChannelInput {
	/** A mailbox name, or "reports". */
	channel: string;
	/** How many recent messages to return. Default 20. */
	tail?: number;
}

export interface ReadChannelResult {
	channel: string;
	messages: ChannelMessage[];
	warnings: string[];
}

export interface RateInput {
	/** Team member name; the spec it was convened under says what its model was drawn for. */
	member: string;
	/** Outcome quality, 0 to 1. */
	outcome: number;
	note?: string;
}

export interface MessageInput {
	/** Team member name. */
	member: string;
	/** Message body. */
	body: string;
	/** True: interrupt the member's current run and steer it. False: queue a follow-up. */
	steer?: boolean;
}

export interface SetCostInput {
	/** A model id, or "provider/<id>" for every model of a provider. */
	target: string;
	/** Cost score, 0 to 1, 1 = cheapest. */
	cost: number;
	reason?: string;
}

export interface SetOverrideInput {
	model: string;
	dimension: string;
	/** The override value, 0 to 1. Overrides beat evidence. */
	value: number;
	reason?: string;
}

export interface PendingAsk {
	id: string;
	member: string;
	tool: string;
	args: string;
	status: "pending" | "resolved";
	resolution?: string;
}

export interface ResolveAskInput {
	id: string;
	approve: boolean;
	/** Required for escalate-only categories: the user's confirmation, quoted. */
	userConfirmed?: string;
}

export interface Ack {
	ok: boolean;
	message: string;
	warnings?: string[];
}

/**
 * Where wakes come from: the active team's record dir and the policy that
 * governs them. The extension watches for these two files only, so the shape
 * deliberately names a directory rather than a set of files — channel logs
 * are never a wake source.
 */
export interface WakeSource {
	/** The active team's record directory. */
	recordPath: string;
	/** Whether and how reports and asks wake the quartermaster. */
	policy: WakePolicy;
}

/** Everything the quartermaster tools need from the implementation. */
export interface QuartermasterEngine {
	convene(input: ConveneInput): Promise<TeamStatus>;
	status(): Promise<TeamStatus>;
	readChannel(input: ReadChannelInput): Promise<ReadChannelResult>;
	rate(input: RateInput): Promise<Ack>;
	message(input: MessageInput): Promise<Ack>;
	setCost(input: SetCostInput): Promise<Ack>;
	setOverride(input: SetOverrideInput): Promise<Ack>;
	pendingAsks(): Promise<PendingAsk[]>;
	resolveAsk(input: ResolveAskInput): Promise<Ack>;
	dissolve(): Promise<TeamStatus>;
	addMember(input: AddMemberInput): Promise<Ack>;
	removeMember(input: RemoveMemberInput): Promise<Ack>;
	/** List quartermaster worktrees of this repository, or prune the unclaimed ones. */
	worktrees(input: WorktreesInput): Promise<Ack>;
	openMailbox(input: OpenMailboxInput): Promise<Ack>;
	closeMailbox(input: CloseMailboxInput): Promise<Ack>;
	/**
	 * The active team's record directory and wake policy, or null when no team
	 * is convened. Synchronous on purpose: it is read after every convene and
	 * dissolve, and a watcher must never be pointed at a promise.
	 */
	wakeSource(): WakeSource | null;
}

/**
 * The scaffold engine: every operation reports what it will do and which
 * configuration it is waiting for. Replaced by the composed engine as the
 * config, matcher, and fleet modules land.
 */
export class NotConfiguredEngine implements QuartermasterEngine {
	async convene(_input: ConveneInput): Promise<TeamStatus> {
		return this.team("convening waits on agent definitions in the agent dir (team/agents/) or the project .pi/agents/");
	}

	async status(): Promise<TeamStatus> {
		return this.team("no team is convened; agent definitions load from the agent dir (team/agents/) or the project .pi/agents/");
	}

	async readChannel(input: ReadChannelInput): Promise<ReadChannelResult> {
		return {
			channel: input.channel,
			messages: [],
			warnings: [
				"no record to read: channels are logged once a team convenes and members send through mailboxes",
			],
		};
	}

	async rate(input: RateInput): Promise<Ack> {
		return this.ack(`rating arrives with the fleet: rate members once a team is convened (${input.member} = ${input.outcome})`);
	}

	async message(input: MessageInput): Promise<Ack> {
		return this.ack(`messaging arrives with the fleet: no member named ${input.member} until a team convenes`);
	}

	async setCost(input: SetCostInput): Promise<Ack> {
		return this.ack(`cost recording writes ~/.pi/agent/team/overrides.yaml once the config module lands: ${input.target} = ${input.cost}`);
	}

	async setOverride(input: SetOverrideInput): Promise<Ack> {
		return this.ack(`score overrides write ~/.pi/agent/team/overrides.yaml once the config module lands: ${input.model}/${input.dimension} = ${input.value}`);
	}

	async pendingAsks(): Promise<PendingAsk[]> {
		return [];
	}

	async resolveAsk(_input: ResolveAskInput): Promise<Ack> {
		return this.ack("permission resolution arrives with the permissions module");
	}

	async dissolve(): Promise<TeamStatus> {
		return this.team("nothing to dissolve");
	}

	async addMember(input: AddMemberInput): Promise<Ack> {
		return this.ack(`no convened team — convene before adding ${input.agent}`);
	}

	async removeMember(input: RemoveMemberInput): Promise<Ack> {
		return this.ack(`no convened team — nothing to remove ${input.member} from`);
	}

	async worktrees(_input: WorktreesInput): Promise<Ack> {
		return this.ack("worktrees arrive with the fleet");
	}

	async openMailbox(input: OpenMailboxInput): Promise<Ack> {
		return this.ack(`no convened team — nothing to open ${input.name} on`);
	}

	async closeMailbox(input: CloseMailboxInput): Promise<Ack> {
		return this.ack(`no convened team — nothing to close ${input.channel} on`);
	}

	wakeSource(): WakeSource | null {
		return null;
	}

	private team(message: string): TeamStatus {
		return {
			convened: false,
			members: [],
			openMailboxes: [],
			pendingAsks: 0,
			unreadReports: 0,
			warnings: [message],
		};
	}

	private ack(message: string): Ack {
		return { ok: false, message };
	}
}
