/**
 * Smoke check for channel identity: one template, many wirings. Uses a
 * Fleet with stub sessions (no model calls) to verify that traffic is
 * isolated per pairing, ${from}/${to} render per channel, read resolution
 * accepts template and pairing names, and duplicate wirings fail convene.
 *
 *   npx tsx scripts/smoke-channels.ts
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { DEFAULT_WORKTREES } from "../src/config/worktrees.ts";
import { Fleet } from "../src/fleet/fleet.ts";
import { readChannelLog } from "../src/fleet/record.ts";

const agent = (name: string): any => ({ name, definition: name, description: name, systemPrompt: "", source: "user", filePath: "" });
const template: any = { name: "ask", description: "d", preamble: "FROM ${from} TO ${to}", source: "user", filePath: "" };
const config: any = { agents: new Map(), mailboxes: new Map([["ask", template]]), models: new Map(), authority: {}, worktrees: DEFAULT_WORKTREES, warnings: [] };

const fleet: any = new Fleet({} as any, config, {} as any, {} as any);
const record = fs.mkdtempSync(`${os.tmpdir()}/qm-channels-`);
fleet.teamId = "t";
fleet.recordPath = record;

const prompts: Record<string, string[]> = {};
// Sessions announce their runs the way a real AgentSession does: the fleet
// follows those events, so a stub without them is not a valid stand-in.
const sessionFor = (name: string) => {
	const listeners: Array<(event: any) => void> = [];
	const emit = (event: any) => {
		for (const l of listeners) l(event);
	};
	return {
		subscribe: (listener: (event: any) => void) => {
			listeners.push(listener);
			return () => {};
		},
		async prompt(t: string) {
			prompts[name].push(t);
			emit({ type: "agent_start" });
			const message = { role: "assistant", content: [], stopReason: "stop" };
			emit({ type: "message_end", message });
			emit({ type: "agent_settled", aborted: false });
		},
	};
};
for (const name of ["builder", "reviewer", "scout"]) {
	prompts[name] = [];
	fleet.members.set(name, {
		name,
		agent: agent(name),
		state: "idle",
		pendingDelivery: [], notices: [],
		session: sessionFor(name),
	});
}
const checks: Array<[string, boolean]> = [];

// Wired twice from one template: distinct pairings.
fleet.openChannel({ name: "ask", from: "builder", to: "scout" }, true);
fleet.openChannel({ name: "ask", from: "reviewer", to: "scout" }, true);
// Wired in the other direction too, from the same file.
fleet.openChannel({ name: "ask", from: "scout", to: "builder" }, true);

const ids = [...fleet.channels.keys()];
checks.push(["three distinct channel ids", ids.length === 3 && new Set(ids).size === 3]);

const builder = fleet.members.get("builder");
const reviewer = fleet.members.get("reviewer");
const scout = fleet.members.get("scout");
// Template name is ambiguous only if the sender has several; here it is unique per sender.
const r1 = fleet.routeSend(builder, "ask", "from builder");
const r2 = fleet.routeSend(reviewer, "ask", "from reviewer");
const r3 = fleet.routeSend(scout, "ask", "from scout");
checks.push(["sends by template name resolve per sender", typeof r1 !== "string" && typeof r2 !== "string" && typeof r3 !== "string"]);

await new Promise((r) => setTimeout(r, 10));
const logOf = (id: string) => readChannelLog(record, id).map((e) => e.body);
checks.push(["traffic isolated per pairing", logOf("ask__builder--scout").join() === "from builder" && logOf("ask__reviewer--scout").join() === "from reviewer"]);
checks.push(["both directions through one template", logOf("ask__scout--builder").join() === "from scout"]);
checks.push(["preamble renders per channel", prompts.scout.some((p) => p.includes("FROM builder TO scout")) && prompts.scout.some((p) => p.includes("FROM reviewer TO scout")) && prompts.builder.some((p) => p.includes("FROM scout TO builder"))]);
checks.push(["read by template aggregates all wirings", fleet.channelLogIds("ask").length === 3]);
checks.push(["read by pairing", fleet.channelLogIds("builder--scout").join() === "ask__builder--scout"]);
checks.push(["read by id", fleet.channelLogIds("ask__reviewer--scout").length === 1]);

// A template wired once keeps its own name (and its existing log file).
const single: any = new Fleet({} as any, config, {} as any, {} as any);
single.members = fleet.members;
single.openChannel({ name: "ask", from: "builder", to: "scout" }, false);
checks.push(["single wiring keeps the template name as id", [...single.channels.keys()].join() === "ask"]);

// Duplicate wiring fails convene loudly.
let threw = "";
try {
	await new Fleet({} as any, config, {} as any, {} as any).convene({
		members: [{ agent: "builder" }],
		mailboxes: [
			{ name: "ask", from: "builder", to: "scout" },
			{ name: "ask", from: "builder", to: "scout" },
		],
	});
} catch (err) {
	threw = String(err);
}
checks.push(["identical duplicate wiring fails convene", threw.includes("wired twice")]);

for (const [label, ok] of checks) console.log(`  ${label}: ${ok ? "ok" : "WRONG"}`);
fs.rmSync(record, { recursive: true, force: true });
if (checks.some(([, ok]) => !ok)) process.exit(1);
