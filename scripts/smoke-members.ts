/**
 * Smoke check for dynamic membership: add_member / remove_member on a live
 * team, with stub sessions (no model calls). Covers refusal while working,
 * force removal (abort + dispose, no orphan), pending-ask denial, channel
 * closure with logs preserved, rating after removal, failed-add atomicity,
 * dissolved-team refusal, and composition history.
 *
 *   npx tsx scripts/smoke-members.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { Fleet } from "../src/fleet/fleet.ts";
import { appendAsk, readChannelLog, readComposition, pendingAsks, askResolution } from "../src/fleet/record.ts";

const def = (name: string, spec?: any): any => ({ name, definition: name, description: `${name} desc`, systemPrompt: "", source: "user", filePath: "", spec });
const spec = { weights: { code: 0.8, cost: 0.2 }, temperature: 0.5 };
const template: any = { name: "ask", description: "d", preamble: "FROM ${from} TO ${to}", source: "user", filePath: "" };
const config: any = {
	agents: new Map([["builder", def("builder", spec)], ["scout", def("scout", spec)], ["nospec", def("nospec")]]),
	mailboxes: new Map([["ask", template]]),
	models: new Map(), authority: {}, warnings: [],
};

const record = fs.mkdtempSync(`${os.tmpdir()}/qm-members-`);
const fleet: any = new Fleet({} as any, config, {} as any, {} as any);
fleet.teamId = "t";
fleet.recordPath = record;

const log: string[] = [];
const stubSession = (name: string, blocking = false) => {
	let release: () => void = () => {};
	return {
		prompts: [] as string[],
		aborted: false,
		disposed: false,
		prompt(t: string) {
			this.prompts.push(t);
			return blocking ? new Promise<void>((r) => (release = r)) : Promise.resolve();
		},
		async abort() { this.aborted = true; release(); },
		dispose() { this.disposed = true; log.push(`dispose ${name}`); },
	};
};
const seed = (name: string, modelId: string, blocking = false) => {
	const session: any = stubSession(name, blocking);
	fleet.members.set(name, { name, agent: def(name), spec, modelId, session, state: "idle", pendingDelivery: [] });
	return session;
};
// Stand in for the draw and session creation, which need a real registry.
fleet.spawnMember = async (agent: any, _o: any, _w: string[], _drop: boolean) => {
	const session: any = stubSession(agent.name);
	const member = { name: agent.name, agent, spec: agent.spec, modelId: "p/new-model", session, state: "unstarted", pendingDelivery: [] };
	fleet.members.set(agent.name, member);
	return member;
};

const checks: Array<[string, boolean]> = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);

seed("scout", "p/scout-model");
const builderSession = seed("builder", "p/builder-model", true);
fleet.openChannel({ name: "ask", from: "builder", to: "scout" }, false);

// Add a member armed, with a new channel; it exchanges messages.
const added = await fleet.addMember({ agent: "builder", task: "" });
ok("adding an existing name is refused", !added.ok && added.message.includes("already a member"));
config.agents.set("reviewer", def("reviewer", spec));
const r = await fleet.addMember({ agent: "reviewer", mailboxes: [{ name: "ask", from: "reviewer", to: "scout" }] });
ok("add_member succeeds, armed", r.ok && fleet.members.get("reviewer").state === "unstarted" && r.message.includes("not started"));
ok("second wiring of the template gets pairing ids", fleet.channels.has("ask__reviewer--scout"));
const sent = fleet.routeSend(fleet.members.get("reviewer"), "ask__reviewer--scout", "hello scout");
ok("new member can send; recipient receives framed message", typeof sent !== "string" && fleet.members.get("scout").session.prompts.some((p: string) => p.includes("FROM reviewer TO scout")));
fleet.message("reviewer", "start", false);
ok("first message starts the added member", fleet.members.get("reviewer").session.prompts.length === 1);
ok("composition log records the add", readComposition(record).some((e) => e.type === "added" && e.member === "reviewer" && e.model === "p/new-model" && e.via === "add_member"));

// Failed add leaves the team unchanged (real spawn path: no spec, no model pin).
const realSpawn = Fleet.prototype["spawnMember" as keyof Fleet] as any;
fleet.spawnMember = realSpawn.bind(fleet);
fleet.ctx = { modelRegistry: { getAvailable: () => [], hasConfiguredAuth: () => false, find: () => undefined }, cwd: process.cwd() };
const before = [...fleet.members.keys()].join();
const bad = await fleet.addMember({ agent: "nospec" });
ok("failed draw: not added, team unchanged", !bad.ok && [...fleet.members.keys()].join() === before);

// Removal refuses while working, and reports why.
fleet.members.get("builder").state = "working";
const refused = await fleet.removeMember({ member: "builder" });
ok("remove refuses while working", !refused.ok && refused.message.includes("working") && fleet.members.get("builder").state === "working");

// Pending ask also blocks; force denies it with a note, aborts and disposes.
appendAsk(record, { id: "a1", ts: Date.now(), member: "builder", tool: "bash", args: "ls", why: "x" });
const forced = await fleet.removeMember({ member: "builder", force: true, reason: "lost the race" });
ok("force removes a working member", forced.ok && fleet.members.get("builder").state === "removed");
ok("force aborted then disposed its session; none orphaned", builderSession.aborted && builderSession.disposed && fleet.members.get("builder").session === undefined);
ok("pending ask denied with a recorded note", pendingAsks(record).length === 0 && askResolution(record, "a1")?.approve === false && (askResolution(record, "a1") as any)?.note?.includes("removed"));
await new Promise((r) => setTimeout(r, 10));
ok("settling run does not resurrect the member", fleet.members.get("builder").state === "removed");

// Channels closed, logs preserved, other members undisturbed.
ok("channel to removed member closed and unlisted", fleet.channels.get("ask").closed === true && !fleet.status().openMailboxes.some((m: string) => m.startsWith("ask (")));
ok("sends to a removed member are refused", typeof fleet.routeSend(fleet.members.get("scout"), "ask", "x") === "string");
ok("quartermaster message to removed member refused", !fleet.message("builder", "hi", false).ok);
ok("other channel still works", typeof fleet.routeSend(fleet.members.get("reviewer"), "ask__reviewer--scout", "again") !== "string");
ok("logs preserved after closure", readChannelLog(record, "ask__reviewer--scout").length === 2);
ok("other sessions not disposed", !fleet.members.get("scout").session.disposed && !fleet.members.get("reviewer").session.disposed);

// Record keeps the member; rating still resolves to the right model.
const st = fleet.status().members.find((m: any) => m.name === "builder");
ok("status keeps removed member with timestamp and reason", st.state === "removed" && st.removedAt > 0 && st.removedReason === "lost the race");
ok("rating after removal resolves the drawn model", fleet.memberForRating("builder")?.modelId === "p/builder-model");
ok("composition log records removal with model and dimensions", readComposition(record).some((e) => e.type === "removed" && e.member === "builder" && e.forced === true && e.model === "p/builder-model" && (e.dimensions?.length ?? 0) > 0));
ok("a removed name cannot be re-added", !(await fleet.addMember({ agent: "builder" })).ok);
ok("removing twice is refused", !(await fleet.removeMember({ member: "builder" })).ok);

// A new member's spawn prompt lists the current team, not the removed one.
fleet.spawnMember = async (agent: any) => {
	const member = { name: agent.name, agent, spec: agent.spec, modelId: "p/m", session: stubSession(agent.name), state: "unstarted", pendingDelivery: [] };
	fleet.members.set(agent.name, member);
	return member;
};
config.agents.set("verifier", def("verifier", spec));
await fleet.addMember({ agent: "verifier", task: "check it" });
const prompt = fleet.members.get("verifier").session.prompts[0] as string;
ok("spawn prompt lists current members only", prompt.includes("scout") && prompt.includes("reviewer") && !prompt.includes("- builder:"));

// Dynamic mailbox management, decoupled from add_member.
const scoutS = fleet.members.get("scout");
const verifier = fleet.members.get("verifier");
const opened = await fleet.openMailbox({ name: "ask", from: "verifier", to: "scout" });
ok("open_mailbox opens a pairing on a live team", opened.ok && fleet.channels.has("ask__verifier--scout"));
ok("open_mailbox refuses an identical open wiring", !(await fleet.openMailbox({ name: "ask", from: "verifier", to: "scout" })).ok);
ok("open_mailbox refuses a removed endpoint", !(await fleet.openMailbox({ name: "ask", from: "builder", to: "scout" })).ok);
ok("open_mailbox refuses an unknown template", !(await fleet.openMailbox({ name: "nope", from: "verifier", to: "scout" })).ok);
ok("sends flow on the new channel", typeof fleet.routeSend(verifier, "ask__verifier--scout", "hi") !== "string");
const closedRes = await fleet.closeMailbox({ channel: "verifier--scout", reason: "abused" });
ok("close_mailbox closes by pairing", closedRes.ok && fleet.channels.get("ask__verifier--scout").closed === true);
ok("closed channel refuses sends with the uniform refusal", fleet.routeSend(verifier, "ask__verifier--scout", "x") === 'no mailbox "ask__verifier--scout" is open for you to send through');
ok("closed channel log is preserved and readable", readChannelLog(record, "ask__verifier--scout").length === 1 && fleet.channelLogIds("verifier--scout").length === 1);
ok("close_mailbox refuses closing twice", !(await fleet.closeMailbox({ channel: "ask__verifier--scout" })).ok);
ok("closing did not touch other channels", typeof fleet.routeSend(fleet.members.get("reviewer"), "ask__reviewer--scout", "still") !== "string");
const reopened = await fleet.openMailbox({ name: "ask", from: "verifier", to: "scout" });
ok("open_mailbox revives a closed channel with the same id and log", reopened.ok && reopened.message.includes("reopened") && !fleet.channels.get("ask__verifier--scout").closed);
const ambiguous = await fleet.closeMailbox({ channel: "ask" });
ok("close by an ambiguous template name is refused, listing ids", !ambiguous.ok && ambiguous.message.includes("ask__reviewer--scout"));
ok("close_mailbox refuses an unknown channel", !(await fleet.closeMailbox({ channel: "zzz" })).ok);
ok("composition log records channel open/close", readComposition(record).filter((e) => e.type === "channel_closed" && e.reason === "abused").length === 1 && readComposition(record).filter((e) => e.type === "channel_opened").length === 2);
void scoutS;

// Dissolution skips removed sessions and leaves nothing running.
log.length = 0;
await fleet.dissolve();
ok("dissolve does not double-dispose a removed member", !log.includes("dispose builder"));

for (const [label, pass] of checks) console.log(`  ${label}: ${pass ? "ok" : "WRONG"}`);
fs.rmSync(record, { recursive: true, force: true });
if (checks.some(([, pass]) => !pass)) process.exit(1);
