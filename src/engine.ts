/**
 * The engine contract: what the quartermaster tools call.
 *
 * The tool surface in quartermaster.ts is final — it delegates every call to
 * this interface. Later modules (config discovery, the matcher, the fleet)
 * implement the operations; the scaffold ships an engine that reports its
 * not-configured state so the surface is callable from the first commit.
 */

export interface ConveneMemberInput {
	/** Agent definition name (the `name` in an agent .md file). */
	agent: string;
	/** Spec name (pools.jsonc). Optional when the agent file pins a model. */
	spec?: string;
	/** The complete, self-contained task for this member. */
	task: string;
}

export interface ConveneMailboxInput {
	/** Mailbox definition name. */
	name: string;
	/** Sender member; defaults to the definition's from. */
	from?: string;
	/** Recipient member; defaults to the definition's to. */
	to?: string;
}

export interface ConveneInput {
	members: ConveneMemberInput[];
	/** The team's relationship graph: channels to open, with endpoints. */
	mailboxes?: ConveneMailboxInput[];
}

export interface MemberStatus {
	/** Member name in this team (the agent definition name). */
	name: string;
	description: string;
	spec?: string;
	model?: string;
	/**
	 * A union of string literals rather than an enum: the TypeScript
	 * idiom. It is compile-time-checked everywhere the value is read or
	 * written, serializes as plain strings, and adds no runtime object.
	 */
	state: "convening" | "working" | "idle" | "dissolved" | "error";
	note?: string;
}

export interface TeamStatus {
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
	from: string;
	to: string;
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
}

/**
 * The scaffold engine: every operation reports what it will do and which
 * configuration it is waiting for. Replaced by the composed engine as the
 * config, matcher, and fleet modules land.
 */
export class NotConfiguredEngine implements QuartermasterEngine {
	async convene(): Promise<TeamStatus> {
		return this.team("convening waits on agent definitions in ~/.agents/agents/ (or .pi/agents/)");
	}

	async status(): Promise<TeamStatus> {
		return this.team("no team is convened; agent definitions load from ~/.agents/agents/ (or .pi/agents/)");
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

	async resolveAsk(): Promise<Ack> {
		return this.ack("permission resolution arrives with the permissions module");
	}

	async dissolve(): Promise<TeamStatus> {
		return this.team("nothing to dissolve");
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
