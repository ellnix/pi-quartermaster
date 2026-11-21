/**
 * Wake smoke check: drives the watcher against a fixture record dir, with no
 * pi session and no live team.
 *
 *   PI_CODING_AGENT_DIR=/tmp/qm-wake npx tsx scripts/smoke-wake.ts
 *
 * Asserts the behavior the wake feature promises: reports and asks produce
 * one debounced digest notice each burst, the digest carries ids and one-line
 * summaries rather than payloads, channel traffic produces nothing at all,
 * the delivery invocation is the follow-up shape that never steers, and the
 * policy switches (reports/asks off) restore pull-only behavior. Exits
 * non-zero on any failed assertion — a watcher that silently stops watching
 * is worse than no watcher, because the quartermaster believes it is woken.
 */

process.env.PI_CODING_AGENT_DIR ??= "/tmp/qm-wake-agent-dir";

import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_WAKE, type WakePolicy } from "../src/config/authority.ts";
import { recordDir } from "../src/config/paths.ts";
import { appendAsk, appendChannel, appendReport, appendResolution, ensureRecord } from "../src/fleet/record.ts";
import { WAKE_CUSTOM_TYPE, WakeWatcher, syncWake, wakeMessage, type WakeNotice } from "../src/fleet/wake.ts";

const FAST: WakePolicy = { ...DEFAULT_WAKE, debounceMs: 60 };

fs.rmSync(process.env.PI_CODING_AGENT_DIR, { recursive: true, force: true });

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
	console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures += 1;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		await sleep(10);
	}
	return predicate();
}

function collect(): { notices: WakeNotice[]; emit: (notice: WakeNotice) => void } {
	const notices: WakeNotice[] = [];
	return { notices, emit: (notice) => notices.push(notice) };
}

async function main(): Promise<void> {
	const recordA = recordDir("t-wake-a");
	ensureRecord(recordA);

	// History is not news: a report that predates the watch must not wake.
	const history = appendReport(recordA, { ts: Date.now(), member: "builder", status: "partial", summary: "old news" });

	const { notices, emit } = collect();
	const watcher = new WakeWatcher(FAST, emit);
	watcher.watch(recordA, FAST);
	check("watcher reports itself watching the active record", watcher.watching);

	await sleep(150);
	check("pre-existing history produces no wake", notices.length === 0, `${notices.length} notice(s)`);

	// --- A burst: two reports + an ask inside one debounce window.
	const longSummary = `implemented the score gate ${"detail ".repeat(400)}end`;
	const r2 = appendReport(recordA, { ts: Date.now(), member: "builder", status: "complete", summary: longSummary });
	const r3 = appendReport(recordA, { ts: Date.now(), member: "reviewer", status: "partial", summary: "two findings,\nseverity sorted" });
	const askId = "1m4f-builder";
	appendAsk(recordA, {
		id: askId,
		ts: Date.now(),
		member: "builder",
		tool: "bash",
		args: "git push origin qm/018-wakes",
		why: "publish the branch",
	});

	// Channel traffic in the same window must not contribute anything.
	appendChannel(recordA, "builder-to-reviewer", {
		channel: "builder-to-reviewer",
		ts: Date.now(),
		from: "builder",
		to: "reviewer",
		body: "SECRET CHANNEL BODY — this must never appear in a wake",
	});

	const coalesced = await waitFor(() => notices.length >= 1);
	check("a burst of entries wakes once", coalesced && notices.length === 1, `${notices.length} notice(s)`);
	const first = notices[0];
	if (!first) {
		console.error("\nno wake notice was delivered — cannot assert digest content");
		process.exit(1);
	}

	const text = first.text;
	check("digest names both report ids", text.includes(r2.id) && text.includes(r3.id), r2.id + ", " + r3.id);
	check("digest names the ask and the requesting member", text.includes(askId) && text.includes("asks to run bash"), text.split("\n")[0]);
	check("digest points at the resolving tools", text.includes("pending_asks") && text.includes("resolve_ask"));
	check("digest points at read_channel for report detail", text.includes('read_channel "reports"'));
	check("asks come before reports in the digest", text.indexOf("ASKS") < text.indexOf("REPORTS"));

	// Digests, not payloads: the record holds the full text.
	check(
		"digest summarizes rather than pasting the payload",
		!text.includes("detail ".repeat(30).trim()) && text.length < 1200,
		`digest ${text.length} chars, report summary ${longSummary.length} chars`,
	);
	check("multi-line summaries are collapsed to one line", text.includes("two findings, severity sorted"));
	check("channel traffic never reaches a wake", !text.includes("SECRET CHANNEL BODY"));
	check("digest carries structured details for the renderer", first.details.reports.length === 2 && first.details.asks.length === 1);

	// --- The debounce closes: nothing more arrives from the same entries.
	await sleep(300);
	check("the same entries do not wake twice", notices.length === 1, `${notices.length} notice(s)`);

	// --- A resolution is not news: the quartermaster wrote it.
	appendResolution(recordA, { ts: Date.now(), id: askId, approve: true, by: "quartermaster" });
	await sleep(300);
	check("an ask resolution produces no wake", notices.length === 1, `${notices.length} notice(s)`);

	// --- Delivery shape: a custom message, follow-up delivery, never a steer,
	// never a user message.
	const { message: wireMessage, options } = wakeMessage(first);
	check("delivery uses the registered custom type", wireMessage.customType === WAKE_CUSTOM_TYPE && WAKE_CUSTOM_TYPE === "quartermaster-wake");
	check("delivery is displayed in the TUI", wireMessage.display === true);
	check("delivery triggers a turn when the quartermaster is idle", options.triggerTurn === true);
	check("delivery queues as a follow-up (never steers a running quartermaster)", options.deliverAs === "followUp");
	check("delivered content is the digest", wireMessage.content === first.text && wireMessage.details.reports.length === 2);

	// --- Policy: reports off leaves asks waking, and a report is not replayed
	// as a backlog when reports come back on.
	const recordB = recordDir("t-wake-b");
	ensureRecord(recordB);
	const offCollect = collect();
	const offWatcher = new WakeWatcher({ reports: "off", asks: "immediate", debounceMs: FAST.debounceMs }, offCollect.emit);
	offWatcher.watch(recordB, { reports: "off", asks: "immediate", debounceMs: FAST.debounceMs });

	const ignored = appendReport(recordB, { ts: Date.now(), member: "builder", status: "complete", summary: "while reports are off" });
	await sleep(300);
	check("reports off means exactly the pull-only behavior (no wake)", offCollect.notices.length === 0, `${offCollect.notices.length} notice(s)`);

	appendAsk(recordB, { id: "ask-b", ts: Date.now(), member: "reviewer", tool: "edit", args: "src/x.ts", why: "fix" });
	const askWoke = await waitFor(() => offCollect.notices.length === 1);
	check(
		"asks still wake while reports are off",
		askWoke && offCollect.notices[0]!.details.asks.length === 1 && offCollect.notices[0]!.details.reports.length === 0,
		offCollect.notices[0]?.text.split("\n")[0] ?? "",
	);

	// Reports back on: the ignored report must not be replayed.
	offWatcher.watch(recordB, { reports: "immediate", asks: "immediate", debounceMs: FAST.debounceMs });
	await sleep(150);
	check("re-enabling reports does not replay the ignored backlog", offCollect.notices.length === 1, `${offCollect.notices.length} notice(s)`);
	const fresh = appendReport(recordB, { ts: Date.now(), member: "builder", status: "complete", summary: "after reports came back" });
	const freshWoke = await waitFor(() => offCollect.notices.length === 2);
	check(
		"a report after re-enabling wakes, and only that one",
		freshWoke && offCollect.notices[1]!.details.reports.length === 1 && offCollect.notices[1]!.details.reports[0]!.id === fresh.id,
		offCollect.notices[1]?.details.reports.map((r) => r.id).join(", ") ?? "",
	);

	// --- Retargeting: the previous record goes quiet, the new one is watched.
	const recordC = recordDir("t-wake-c");
	ensureRecord(recordC);
	watcher.watch(recordC, FAST);
	await sleep(100);
	const beforeRetarget = notices.length;
	appendReport(recordA, { ts: Date.now(), member: "builder", status: "complete", summary: "after retarget" });
	await sleep(300);
	check(
		"retargeting stops watching the previous record",
		notices.length === beforeRetarget,
		`${notices.length - beforeRetarget} notice(s) from the old record`,
	);
	appendReport(recordC, { ts: Date.now(), member: "builder", status: "complete", summary: "on the new record" });
	const retargeted = await waitFor(() => notices.length === beforeRetarget + 1);
	check(
		"the newly targeted record wakes",
		retargeted && notices.at(-1)?.details.recordPath === recordC,
		notices.at(-1)?.details.recordPath ?? "(none)",
	);

	// --- A corrupt-but-complete line is loud, not silent.
	appendAsk(recordB, { id: "ask-c", ts: Date.now(), member: "reviewer", tool: "read", args: "src/y.ts", why: "look" });
	fs.appendFileSync(path.join(recordB, "reports.jsonl"), "{not json\n");
	const corruptWoke = await waitFor(() => offCollect.notices.length === 3);
	check(
		"an unreadable record line is reported in the digest",
		corruptWoke && offCollect.notices[2]!.text.includes("unreadable line(s)"),
		offCollect.notices[2]?.text.split("\n").at(-1) ?? "",
	);

	// --- A worker append must never be digested as a report.
	appendChannel(recordB, "reviewer-to-builder", {
		channel: "reviewer-to-builder",
		ts: Date.now(),
		from: "reviewer",
		to: "builder",
		body: "another channel body",
	});
	await sleep(300);
	check("channel traffic alone never wakes", offCollect.notices.length === 3, `${offCollect.notices.length} notice(s)`);

	// --- The sweep backstop: a drain that ignores the event stream. A null
	// filename (Node's "not available") or a dropped event must not strand an
	// ask, so the watcher drains on an interval too. What a script can assert
	// on Linux is safety, not event-independence: the sweep must never
	// duplicate a notice, and it must still be watching afterwards.
	const beforeSweep = offCollect.notices.length;
	offWatcher.sweep();
	offWatcher.sweep();
	await sleep(300);
	check(
		"a sweep with nothing new emits nothing (offset-guarded, no duplicates)",
		offCollect.notices.length === beforeSweep,
		`${offCollect.notices.length - beforeSweep} extra notice(s)`,
	);
	check("the watcher survives a sweep", offWatcher.watching);

	watcher.stop();
	offWatcher.stop();
	check("stopping closes the watch", !watcher.watching && !offWatcher.watching);

	// --- The wiring the extension actually uses: a null source parks the
	// watcher, a live source points it at that record.
	syncWake(watcher, null);
	check("no convened team parks the watcher", !watcher.watching);
	syncWake(watcher, { recordPath: recordC, policy: FAST });
	check("a convene points the watcher at the team record", watcher.watching);
	const wired = appendReport(recordC, { ts: Date.now(), member: "builder", status: "complete", summary: "through the wiring" });
	const wiredWoke = await waitFor(() => notices.at(-1)?.details.reports.some((r) => r.id === wired.id) === true);
	check("the wired watcher wakes on that record", wiredWoke, `report ${wired.id}`);
	syncWake(watcher, null);
	check("dissolving parks the watcher again", !watcher.watching);

	if (failures > 0) {
		console.error(`\n${failures} wake assertion(s) failed`);
		process.exit(1);
	}
	console.log("\nall wake assertions passed");
	console.log("\nlast digest:\n" + (notices[0]?.text ?? "(none)"));
}

await main();
