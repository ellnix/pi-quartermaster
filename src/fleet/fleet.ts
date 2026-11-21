/**
 * The fleet: convene, observe, dissolve.
 *
 * Each member is a full child session created in-process through the pi
 * SDK — in-memory session manager, the tool allowlist from the agent
 * file, the crewman tools, and one model drawn at convening (never per
 * message, so a member's context and prompt cache stay warm across
 * follow-ups). The constitutional introduction is assembled here, in
 * code, single-sourced: it must not be possible for an agent file to
 * forget it or opt out.
 */

import {
	createAgentSession,
	type AgentSession,
	type ExtensionToolContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ConveneInput, MemberStatus, TeamStatus } from "../engine.ts";
import type { QuartermasterConfig, AgentDef } from "../config/index.ts";
import { validateSpec, type SpecDef } from "../config/spec.ts";
import type { SpecOverrideInput } from "../engine.ts";
import { drawForSpec, type Candidate } from "../matching/matcher.ts";
import type { EvidenceStore } from "../matching/evidence.ts";
import type { Overrides } from "../matching/overrides.ts";
import { recordDir } from "../config/paths.ts";
import { childTools } from "./child-tools.ts";
import { ensureRecord, readReports } from "./record.ts";

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
}

/** Tools a member gets when its agent file grants none: read-only. */
const DEFAULT_TOOLS = ["read", "ls", "find", "grep"];

export class Fleet {
	private members = new Map<string, FleetMember>();
	private teamId?: string;
	private recordPath?: string;
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

	async convene(input: ConveneInput): Promise<TeamStatus> {
		if (this.convened) {
			return this.status(["a team is already convened — dissolve_team before convening another"]);
		}

		const warnings: string[] = [];
		const openedMailboxes: string[] = [];
		for (const wiring of input.mailboxes ?? []) {
			const template = this.config.mailboxes.get(wiring.name);
			if (!template) {
				warnings.push(`mailbox "${wiring.name}" is not defined — skipped`);
				continue;
			}
			// The wiring IS the authority for endpoints; the definition supplies
			// the preamble template. Delivery machinery arrives with the
			// mailboxes module; this validates the declared graph up front.
			const sender = this.members.get(wiring.from) ?? null;
			const recipient = this.members.get(wiring.to) ?? null;
			if (!sender) {
				warnings.push(`mailbox "${wiring.name}" wired from "${wiring.from}" who is not a member — channel will not open`);
			}
			if (!recipient) {
				warnings.push(`mailbox "${wiring.name}" wired to "${wiring.to}" who is not a member — channel will not open`);
			}
			openedMailboxes.push(`${wiring.name} (${wiring.from} -> ${wiring.to})`);
		}

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
			await this.spawnMember(agent, request.spec, request.task, warnings);
		}

		return this.status(warnings, openedMailboxes);
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
			// own inline spec is the reusable form. Both are objects now.
			let spec: SpecDef | undefined = agent.spec;
			if (specOverride !== undefined) {
				spec = validateSpec(specOverride, `convene member ${agent.name}`, []) ?? undefined;
			}
			const member: FleetMember = {
				name: agent.name,
				agent,
				spec,
				state: "convening",
			};
			this.members.set(member.name, member);

			const draw = await this.resolveModel(member, warnings);
			if (!draw.ok) {
				member.state = "error";
				member.note = draw.error;
				return;
			}
			member.modelId = draw.modelId;

			// Model ids may contain slashes beyond the provider split; split once.
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
				const tools = childTools(member.name, this.recordPath!);
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
			member.state = "working";

			const prompt = assembleSpawnPrompt(member.name, agent, task);
			void session
				.prompt(prompt)
				.then(() => {
					member.state = "idle";
				})
				.catch((err: unknown) => {
					member.state = "error";
					member.note = `run failed: ${String(err)}`;
				});
		});
		this.creationChain = creation.catch(() => {});
		await creation;
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

	status(extraWarnings: string[] = [], openMailboxes: string[] = []): TeamStatus {
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
			openMailboxes,
			pendingAsks: 0,
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
		return dissolved;
	}
}

/**
 * Constitutional spawn assembly. Injected in code, single-sourced: no
 * agent file can forget it, and no member convenes sub-teams.
 */
function assembleSpawnPrompt(memberName: string, agent: AgentDef, task: string): string {
	return [
		`You are ${memberName}, a member of a team convened by the Quartermaster.`,
		"",
		agent.systemPrompt,
		"",
		"OPERATING RULES:",
		"- The Quartermaster is the orchestrating session that speaks with the user. You never see its conversation.",
		"- All traffic between members is visible to the Quartermaster. Nothing you send is private.",
		"- Report results to the Quartermaster with the report tool at meaningful milestones and at completion.",
		"- Permission questions about actions outside your granted tools go to the Quartermaster via request-permission.",
		"- Your task below is the whole of what the Quartermaster delegated. If it is incomplete or ambiguous, say so in a report instead of guessing.",
		"",
		"YOUR TASK:",
		task,
	].join("\n");
}
