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
import { DEFAULT_WORKTREES } from "../src/config/worktrees.ts";
import { Fleet } from "../src/fleet/fleet.ts";
import { appendAsk, readChannelLog, readComposition, pendingAsks, askResolution } from "../src/fleet/record.ts";

const def = (name: string, spec?: any): any => ({ name, definition: name, description: `${name} desc`, systemPrompt: "", source: "user", filePath: "", spec });
const spec = { weights: { code: 0.8, cost: 0.2 }, temperature: 0.5 };
const template: any = { name: "ask", description: "d", preamble: "FROM ${from} TO ${to}", source: "user", filePath: "" };
const config: any = {
	agents: new Map([["builder", def("builder", spec)], ["scout", def("scout", spec)], ["nospec", def("nospec")]]),
	mailboxes: new Map([["ask", template]]),
	models: new Map(), authority: {}, worktrees: DEFAULT_WORKTREES, warnings: [],
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
	fleet.members.set(name, { name, agent: def(name), spec, modelId, session, state: "idle", pendingDelivery: [], notices: [] });
	return session;
};
// Stand in for the draw and session creation, which need a real registry.
fleet.spawnMember = async (agent: any, _o: any, _w: string[], _drop: boolean) => {
	const session: any = stubSession(agent.name);
	const member = { name: agent.name, agent, spec: agent.spec, modelId: "p/new-model", session, state: "unstarted", pendingDelivery: [], notices: [] };
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
ok("a failed add says why in its warnings", (bad.warnings ?? []).some((w: string) => w.includes("nospec") && w.includes("no spec")));

// Explicit model choice: precedence, catalog checks, failure reporting.
{
	const registry = {
		getAvailable: () => [],
		hasConfiguredAuth: (m: any) => m.id !== "noauth",
		find: (p: string, id: string) => (p === "p" && id !== "nope" ? { provider: "p", id } : undefined),
	};
	fleet.ctx = { modelRegistry: registry, cwd: process.cwd() };
	config.agents.set("pinned", { ...def("pinned", spec), model: "p/agent-pin" });
	config.agents.set("free", def("free", spec));
	const probe = (agent: any, modelOverride?: string) => ({ name: agent.name, agent, spec: agent.spec, modelOverride });

	const chosen = await fleet.resolveModel(probe(config.agents.get("pinned"), "p/ok"), []);
	ok("an explicit model wins over the agent file's pin", chosen.ok && chosen.source === "override" && chosen.modelId === "p/ok");
	const pinned = await fleet.resolveModel(probe(config.agents.get("pinned")), []);
	ok("without one, the agent file's pin applies", pinned.ok && pinned.source === "pin" && pinned.modelId === "p/agent-pin");
	ok("with neither, the spec draw still decides", !(await fleet.resolveModel(probe(config.agents.get("free")), [])).ok);

	ok("a model id with no provider is called out", fleet.modelProblem("haiku").includes("provider/model-id"));
	ok("an id missing from the catalog is called out", fleet.modelProblem("p/nope").includes("not in the model catalog"));
	ok("a model without auth is called out", fleet.modelProblem("p/noauth").includes("no configured auth"));
	ok("a usable id passes", fleet.modelProblem("p/ok") === undefined);

	// add_member forwards the choice; a bad one fails without a fallback draw.
	const realSpawnBound = fleet.spawnMember;
	const forwarded: any[] = [];
	fleet.spawnMember = async (agent: any, _s: any, _w: any, _d: any, _f: any, model?: string) => {
		forwarded.push([agent.name, model]);
		const member = { name: agent.name, agent, spec: agent.spec, modelId: model, modelSource: model ? "override" : "draw", session: stubSession(agent.name), state: "unstarted", pendingDelivery: [], notices: [] };
		fleet.members.set(agent.name, member);
		return member;
	};
	const picked = await fleet.addMember({ agent: "free", model: "p/ok" });
	ok("add_member forwards the explicit model", picked.ok && forwarded.at(-1)?.[1] === "p/ok" && picked.message.includes("p/ok"));
	ok("team_list shows the model came from the choice", fleet.status().members.find((m: any) => m.name === "free").modelSource === "override");
	const emptyAdd = await fleet.addMember({ agent: "free", model: "  " });
	ok("an empty model is refused, not read as no choice", !emptyAdd.ok && emptyAdd.message.includes("model is empty"));
	let conveneThrew = "";
	try {
		await new Fleet({} as any, config, {} as any, {} as any).convene({ members: [{ agent: "free", model: "" }] });
	} catch (err) {
		conveneThrew = String(err);
	}
	ok("convene refuses an empty model before drawing anything", conveneThrew.includes("model is empty"));
	// A model without a spec runs, but its rating has nowhere to land.
	config.agents.set("bare", { ...def("bare"), model: "p/ok" });
	fleet.members.set("bare-probe", { name: "bare-probe", agent: config.agents.get("bare"), spec: undefined, modelId: "p/ok", state: "idle", pendingDelivery: [], notices: [] });
	ok("a spec-less member has no rating dimensions, so rate_member refuses", fleet.memberForRating("bare-probe")?.dimensions.length === 0);
	fleet.members.delete("bare-probe");
	fleet.spawnMember = realSpawnBound;
	const badModel = await fleet.addMember({ agent: "pinned", model: "p/nope" });
	ok("an unusable explicit model fails the add, no fallback", !badModel.ok && !fleet.members.has("pinned"));
	ok("and the failure names the model and the reason", (badModel.warnings ?? []).some((w: string) => w.includes("p/nope") && w.includes("not in the model catalog")));

	// convene hands each member's choice down the same path.
	const issued: any[] = [];
	const conv: any = new Fleet({} as any, config, {} as any, {} as any);
	conv.spawnMember = async (agent: any, _s: any, _w: any, _d: any, _f: any, model?: string) => {
		issued.push([agent.name, model]);
		const member = { name: agent.name, agent, spec: agent.spec, modelId: model ?? "p/m", session: stubSession(agent.name), state: "unstarted", pendingDelivery: [], notices: [] };
		conv.members.set(agent.name, member);
		return member;
	};
	await conv.convene({ members: [{ agent: "free", name: "conv-free", model: "p/ok", task: "go" }] });
	ok("convene forwards the explicit model", issued[0]?.[1] === "p/ok");
	const convRecord = conv.recordPath;
	await conv.dissolve();
	if (convRecord) fs.rmSync(convRecord, { recursive: true, force: true });

	// A member that failed its model check is not a live channel endpoint.
	const mixed: any = new Fleet({} as any, config, {} as any, {} as any);
	mixed.ctx = { modelRegistry: registry, cwd: process.cwd() };
	const realSpawnMixed = Fleet.prototype["spawnMember" as keyof Fleet] as any;
	mixed.spawnMember = async (agent: any, spec: any, ws: any, warnings: string[], drop: boolean, model?: string) => {
		if (model === "p/nope") return realSpawnMixed.call(mixed, agent, spec, ws, warnings, drop, model);
		const member = { name: agent.name, agent, spec: agent.spec, modelId: model ?? "p/ok", session: stubSession(agent.name), state: "unstarted", pendingDelivery: [], notices: [] };
		mixed.members.set(agent.name, member);
		return member;
	};
	const mixedStatus = await mixed.convene({
		members: [{ agent: "free", name: "good", task: "" }, { agent: "free", name: "bad", model: "p/nope" }],
		mailboxes: [{ name: "ask", from: "bad", to: "good" }],
	});
	ok("an unusable model leaves the member in error", mixed.members.get("bad")?.state === "error");
	ok("a channel wired to a failed member does not open", !mixed.channels.has("ask"));
	ok("convene says the channel will not open", mixedStatus.warnings.some((w: string) => w.includes("not an active member")));
	ok("the rating resolver carries the failed state", mixed.memberForRating("bad")?.state === "error");
	const mixedRecord = mixed.recordPath;
	await mixed.dissolve();
	if (mixedRecord) fs.rmSync(mixedRecord, { recursive: true, force: true });
}

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
	const member = { name: agent.name, agent, spec: agent.spec, modelId: "p/m", session: stubSession(agent.name), state: "unstarted", pendingDelivery: [], notices: [] };
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

// Stumbling blocks found by using the system: replies, channel notices, unread, dedupe, trust.
{
	const reply = fleet.routeSend(fleet.members.get("reviewer"), "ask__reviewer--scout", "ping");
	ok("a receipt says no reply is possible when the recipient has no mailbox back", typeof reply !== "string" && reply.replyChannel === undefined);
	await fleet.openMailbox({ name: "ask", from: "scout", to: "reviewer" });
	const withBack = fleet.routeSend(fleet.members.get("reviewer"), "ask__reviewer--scout", "ping2");
	ok("and names the mailbox back once one exists", typeof withBack !== "string" && withBack.replyChannel === "ask__scout--reviewer");

	const rev = fleet.members.get("reviewer");
	rev.state = "idle";
	rev.notices.length = 0;
	await fleet.openMailbox({ name: "ask", from: "verifier", to: "reviewer" });
	ok("an open queues a notice for both ends", rev.notices.length === 1 && fleet.members.get("verifier").notices.length >= 1);
	const before = rev.session.prompts.length;
	fleet.message("reviewer", "carry on", false);
	await new Promise((r) => setTimeout(r, 10));
	const delivered = rev.session.prompts[before] as string;
	ok("the notice rides on the member's next message, once", delivered.includes("CHANNEL CHANGES") && delivered.includes("ask__verifier--reviewer") && rev.notices.length === 0);
	fleet.message("reviewer", "again", false);
	await new Promise((r) => setTimeout(r, 10));
	ok("and is not repeated", !(rev.session.prompts[before + 1] as string).includes("CHANNEL CHANGES"));
	await fleet.closeMailbox({ channel: "ask__verifier--reviewer" });
	ok("a close notifies too", rev.notices.some((n: string) => n.includes("closed")));

	// unread counts only reports the quartermaster has not read
	const { appendReport } = await import("../src/fleet/record.ts");
	appendReport(record, { ts: Date.now(), member: "scout", status: "complete", summary: "x" });
	appendReport(record, { ts: Date.now(), member: "scout", status: "complete", summary: "y" });
	const unreadBefore = fleet.status().unreadReports;
	fleet.markReportsRead();
	ok("unread counts drop to zero once reports are read", unreadBefore >= 2 && fleet.status().unreadReports === 0);
	appendReport(record, { ts: Date.now(), member: "scout", status: "complete", summary: "z" });
	ok("and count only newer ones afterwards", fleet.status().unreadReports === 1);

	ok("identical warnings are reported once", fleet.status(["a", "a", "b"]).warnings.join() === "a,b");
}

// Project trust: an untrusted project's setup and copy are skipped, loudly.
{
	const mk = (trusted: boolean | undefined) => {
		const cfg: any = { ...config, worktrees: { setup: ["touch ran"], copy: [".env"], filePath: "/x/worktrees.jsonc", keepOnDissolve: false, location: "tmp", default: "auto", setupTimeoutMs: 1000 } };
		const ctx: any = { cwd: process.cwd() };
		if (trusted !== undefined) ctx.isProjectTrusted = () => trusted;
		return new Fleet(ctx, cfg, {} as any, {} as any) as any;
	};
	ok("untrusted project: setup and copy are disabled", mk(false).untrustedSetup === true);
	ok("trusted project: they run", mk(true).untrustedSetup === false);
	ok("no trust API: unchanged behaviour", mk(undefined).untrustedSetup === false);
}

// One definition, many crewmen: the same agent launched under different names.
{
	const spawned: string[] = [];
	fleet.spawnMember = async (agent: any) => {
		spawned.push(`${agent.name}<-${agent.definition}`);
		const member = { name: agent.name, agent, spec: agent.spec, modelId: `p/${agent.name}`, session: stubSession(agent.name), state: "unstarted", pendingDelivery: [], notices: [] };
		fleet.members.set(agent.name, member);
		return member;
	};
	config.agents.set("racer", def("racer", spec));
	const a = await fleet.addMember({ agent: "racer", name: "racer-a" });
	const b = await fleet.addMember({ agent: "racer", name: "racer-b", spec: { weights: { cost: 0.9 } } });
	ok("the same agent can be added twice under different names", a.ok && b.ok && fleet.members.has("racer-a") && fleet.members.has("racer-b"));
	ok("each keeps its lineage and its own name", fleet.members.get("racer-a").agent.definition === "racer" && fleet.members.get("racer-b").agent.name === "racer-b");
	ok("the definition itself is untouched", config.agents.get("racer").name === "racer");
	const status = fleet.status().members.find((m: any) => m.name === "racer-a");
	ok("team_list shows the lineage", status.definition === "racer");
	ok("the original name is still free", (await fleet.addMember({ agent: "racer" })).ok);
	const dup = await fleet.addMember({ agent: "racer", name: "racer-a" });
	ok("a taken name is refused with the way out", !dup.ok && dup.message.includes("distinct `name`"));
	for (const bad of ["", "a b", "x/y", "-x", "a--b", "a__b", "quartermaster", "x".repeat(49)]) {
		const r = await fleet.addMember({ agent: "racer", name: bad });
		ok(`unusable name ${JSON.stringify(bad.slice(0, 12))} is refused`, !r.ok && /not usable|reserved/.test(r.message));
	}
	ok("an unknown agent is refused even with a name", !(await fleet.addMember({ agent: "nope", name: "n1" })).ok);
	const before = fleet.members.size;
	const warn: string[] = [];
	// convene path: resolveAgent is shared, so check it directly for the name rules
	const r1 = fleet.resolveAgent("racer", "conv-a");
	ok("convene resolves a renamed copy of the definition", r1.ok && r1.agent.name === "conv-a" && r1.agent.definition === "racer" && r1.agent.systemPrompt === config.agents.get("racer").systemPrompt);
	ok("and does not mutate the original", config.agents.get("racer").name === "racer" && before === fleet.members.size && warn.length === 0);
	// worktree branches are per name
	const { branchFor } = await import("../src/fleet/worktrees.ts");
	ok("branches and channel ids derive from the name", branchFor("t1", "racer-a") !== branchFor("t1", "racer-b"));
}

// Dissolution skips removed sessions and leaves nothing running.
log.length = 0;
await fleet.dissolve();
ok("dissolve does not double-dispose a removed member", !log.includes("dispose builder"));

for (const [label, pass] of checks) console.log(`  ${label}: ${pass ? "ok" : "WRONG"}`);
fs.rmSync(record, { recursive: true, force: true });
if (checks.some(([, pass]) => !pass)) process.exit(1);
