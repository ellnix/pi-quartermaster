/**
 * Smoke check for the tool surface: the quartermaster registers its whole
 * surface, and a convene member / add_member can name an explicit model
 * (issue #41). Imports the extension with a fake pi API — no engine is
 * created and no config is read.
 *
 *   npx tsx scripts/smoke-tools.ts
 */

import quartermaster from "../src/quartermaster.ts";
import { RATING_BANDS } from "../src/matching/rating.ts";

const tools = new Map<string, any>();
const pi: any = {
	registerTool: (tool: any) => tools.set(tool.name, tool),
	on: () => {},
	registerMessageRenderer: () => {},
	sendMessage: () => {},
};
quartermaster(pi);

const member = tools.get("convene_team")?.parameters?.properties?.members?.items?.properties;
const added = tools.get("add_member")?.parameters?.properties;

const advertised = [
	"convene_team",
	"team_list",
	"read_channel",
	"rate_member",
	"set_cost",
	"set_override",
	"pending_asks",
	"resolve_ask",
	"message_member",
	"add_member",
	"remove_member",
	"worktrees",
	"open_mailbox",
	"close_mailbox",
	"dissolve_team",
];

const checks: Array<[string, boolean]> = [
	["every advertised tool is registered", advertised.every((name) => tools.has(name))],
	["a convene member can name an explicit model", member?.model?.type === "string"],
	["add_member can name an explicit model", added?.model?.type === "string"],
	["the field says it skips the draw", /skips the spec draw/.test(member?.model?.description ?? "")],
	[
		"the rating tool states the bands",
		/below 0\.4/.test(tools.get("rate_member")?.description ?? "") &&
			/\[0\.8, 1\] outstanding/.test(tools.get("rate_member")?.description ?? ""),
	],
	["the rating tool prices the top band at a note", /refused without/.test(tools.get("rate_member")?.description ?? "")],
	["the rating tool names a competent run's band", /around 0\.5/.test(tools.get("rate_member")?.description ?? "")],
	[
		"the rating tool renders every band from the standard",
		RATING_BANDS.every((band) => (tools.get("rate_member")?.description ?? "").includes(band.name)),
	],
];

for (const [label, ok] of checks) console.log(`  ${label}: ${ok ? "ok" : "WRONG"}`);
if (checks.some(([, ok]) => !ok)) process.exit(1);
