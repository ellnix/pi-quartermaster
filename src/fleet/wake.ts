/**
 * Wakes: the quartermaster hears about reports and permission asks without
 * the user having to ping it.
 *
 * The 0.1.0 quartermaster was pull-only, and two things died of it: an ask
 * from a blocked member expired unread while the user was away (the member
 * then proceeded on a denial nobody chose), and a builder's report sat in
 * the record until a user ping happened to arrive.
 *
 * What wakes, and what never does:
 *
 * - `reports.jsonl` and `asks.jsonl` of the ACTIVE team's record dir, and
 *   nothing else. `channels/*.jsonl` is deliberately not watched: mailbox
 *   traffic between members is their business, and waking on it would burn
 *   the quartermaster's context on inter-agent prose it can read on demand.
 * - Notices are DIGESTS, never payloads: a report contributes its id, member,
 *   status and one summary line; an ask contributes its id, member and the
 *   requested action. The record stays the blackboard; the quartermaster
 *   still calls read_channel for detail.
 *
 * Delivery contract (the caller's half, see wakeMessage): a custom message
 * with `triggerTurn: true` and `deliverAs: "followUp"` — a wake starts a turn
 * when the agent is idle, and queues after the current run when it is not.
 * It never steers a running quartermaster. `pi.sendUserMessage` is not used:
 * machine traffic must not impersonate the user.
 *
 * Why a debounce: a burst (two members finishing together) is one event to
 * the quartermaster, and one turn. The window opens on the first entry and
 * closes it — entries arriving inside it merge; entries arriving after the
 * flush open a new window, so sustained traffic still wakes on a cadence
 * instead of starving behind a resetting timer. That cadence is also the rate
 * limit: at most one notice per window, however loud the record gets.
 *
 * Two boundaries worth knowing, because both fail silently by nature:
 *
 * - Directory events are a platform facility: Node may deliver a null
 *   filename, and an event can be dropped. A null filename drains anyway
 *   (the only safe reading of "not available"), and a 30-second sweep drains
 *   unconditionally, so a lost event costs at most that delay rather than a
 *   notice. The byte offsets make every later drain catch everything up, so
 *   the watcher can never be desynchronized — only late, and boundedly so.
 * - Offsets seed at the current file sizes, so anything already written when
 *   the watch starts is history. A convene mints a fresh record path, so the
 *   seed only ever skips history in a record that is being re-attached.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WakePolicy } from "../config/authority.ts";
import { asksFile, reportsFile } from "../config/paths.ts";
import type { WakeSource } from "../engine.ts";

/** Custom message type; the extension registers a TUI renderer under it. */
export const WAKE_CUSTOM_TYPE = "quartermaster-wake";

/** Longest summary line a digest carries; the record has the rest. */
const SUMMARY_LIMIT = 160;

/**
 * How often the watcher drains unconditionally, event or no event.
 *
 * Directory events are a platform facility and can be missing: Node's
 * `fs.watch` may deliver a null filename ("not available" on some platforms),
 * and an event can be dropped outright. For reports a lost event costs one
 * debounce window, because the next report catches everything up — but an ask
 * that is the last-ever append to `asks.jsonl` has no next append, so the ask
 * would die unread and that is the headline defect this feature exists to
 * prevent. The sweep bounds that to 30 seconds: drain is offset-guarded, so it
 * costs two small reads and emits nothing when the files are unchanged.
 */
const SWEEP_MS = 30_000;

export interface WakeReport {
	id: string;
	/** When the member filed it (ms since epoch); lets a digest say how old it is. */
	ts?: number;
	member: string;
	status: string;
	summary: string;
}

export interface WakeAsk {
	id: string;
	member: string;
	tool: string;
	args: string;
	why?: string;
}

export interface WakeDetails {
	/** The record the entries came from. */
	recordPath: string;
	reports: WakeReport[];
	asks: WakeAsk[];
	/** Entries that were newline-terminated but not readable as record JSON. */
	malformed: number;
}

export interface WakeNotice {
	/** The digest, as the model reads it. */
	text: string;
	details: WakeDetails;
}

/** The exact arguments a caller hands to `pi.sendMessage`. */
export interface WakeMessage {
	message: { customType: string; content: string; display: true; details: WakeDetails };
	options: { triggerTurn: true; deliverAs: "followUp" };
}

/**
 * Build the `pi.sendMessage(message, options)` pair for a notice.
 *
 * One place, so the delivery contract above is testable without a live pi:
 * custom type for the renderer, follow-up delivery so a wake never steers,
 * triggerTurn so an idle quartermaster actually starts a turn.
 */
export function wakeMessage(notice: WakeNotice): WakeMessage {
	return {
		message: {
			customType: WAKE_CUSTOM_TYPE,
			content: notice.text,
			display: true,
			details: notice.details,
		},
		options: { triggerTurn: true, deliverAs: "followUp" },
	};
}

/**
 * Point a watcher at the active team's record, or park it.
 *
 * The extension calls this after convene and dissolve — the only operations
 * that move the record path — so the watch cannot drift from the live team.
 * A null source (no team) parks the watcher rather than leaving it on a stale
 * record: a dissolved team's record must not wake anyone.
 */
export function syncWake(watcher: WakeWatcher, source: WakeSource | null): void {
	if (source) watcher.watch(source.recordPath, source.policy);
	else watcher.stop();
}

/**
 * The watcher: one active record dir, two files, one debounce window.
 *
 * Offsets are byte offsets into each file, so each entry is digested exactly
 * once. Starting to watch a record seeds the offsets at the current file
 * sizes: history is not news, and a restart must not replay yesterday's
 * reports into a fresh context.
 */
export class WakeWatcher {
	private recordPath: string | null = null;
	private policy: WakePolicy;
	private watcher: fs.FSWatcher | null = null;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;
	private offsets = new Map<string, number>();
	private pendingReports: WakeReport[] = [];
	private pendingAsks: WakeAsk[] = [];
	private malformed = 0;

	constructor(
		policy: WakePolicy,
		private emit: (notice: WakeNotice) => void,
	) {
		this.policy = policy;
	}

	/** Watch a record dir, or retarget an existing watch. Idempotent per path. */
	watch(recordPath: string, policy: WakePolicy): void {
		this.policy = policy;
		if (this.recordPath === recordPath && this.watcher) return;
		this.stop();
		this.recordPath = recordPath;
		this.pendingReports = [];
		this.pendingAsks = [];
		this.malformed = 0;
		fs.mkdirSync(recordPath, { recursive: true });
		this.offsets = new Map([
			[reportsFile(recordPath), this.sizeOf(reportsFile(recordPath))],
			[asksFile(recordPath), this.sizeOf(asksFile(recordPath))],
		]);
		this.watcher = fs.watch(recordPath, (_event, filename) => {
			// A null filename means "not available", not "irrelevant": draining
			// unconditionally is the only safe reading, and drain is offset-guarded.
			const watched = filename === null || filename === "reports.jsonl" || filename === "asks.jsonl";
			if (watched) this.drain();
		});
		this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
		// Background maintenance must never keep a process alive on its own.
		this.sweepTimer.unref?.();
	}

	/**
	 * Drain once, ignoring what the event stream did or did not deliver.
	 *
	 * The interval backstop calls this; smoke-wake calls it directly to assert
	 * that a sweep with nothing new is a no-op. Offset-guarded, so repeated
	 * sweeps cannot duplicate a notice.
	 */
	sweep(): void {
		this.drain();
	}

	stop(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}
		this.watcher?.close();
		this.watcher = null;
		this.recordPath = null;
		this.pendingReports = [];
		this.pendingAsks = [];
		this.malformed = 0;
	}

	/** True while a record is being watched. */
	get watching(): boolean {
		return this.watcher !== null;
	}

	/**
	 * Read whatever is new in both files, queue it, and open the debounce
	 * window if one is not already open.
	 */
	private drain(): void {
		if (!this.recordPath) return;
		const reports = this.policy.reports === "immediate";
		const asks = this.policy.asks === "immediate";
		// Both files are read even when a kind is off, so the offsets stay
		// current: turning reports on mid-team must not replay the backlog.
		this.readNew(reportsFile(this.recordPath), (line) => {
			const entry = parseLine(line);
			// reports.jsonl holds reports and nothing else: anything else that
			// parses is a record this watcher does not understand.
			if (entry.kind !== "report") {
				this.malformed += 1;
				return;
			}
			if (reports) this.pendingReports.push(entry.report);
		});
		this.readNew(asksFile(this.recordPath), (line) => {
			const entry = parseLine(line);
			if (entry.kind === "ignored") return; // a resolution: the quartermaster wrote it
			if (entry.kind !== "ask") {
				this.malformed += 1;
				return;
			}
			if (asks) this.pendingAsks.push(entry.ask);
		});
		if (this.pendingReports.length === 0 && this.pendingAsks.length === 0) return;
		this.schedule();
	}

	/** Complete lines only: a half-written tail waits for the next event. */
	private readNew(file: string, onLine: (line: string) => void): void {
		let raw: Buffer;
		try {
			raw = fs.readFileSync(file);
		} catch {
			return; // the file is created on first append; nothing to read yet
		}
		let start = this.offsets.get(file) ?? 0;
		if (raw.length < start) start = 0; // truncated or rotated: read from the top
		if (raw.length === start) return;
		const chunk = raw.subarray(start);
		const lastNewline = chunk.lastIndexOf(0x0a);
		if (lastNewline < 0) return;
		this.offsets.set(file, start + lastNewline + 1);
		for (const line of chunk.subarray(0, lastNewline + 1).toString("utf8").split("\n")) {
			if (line.trim().length > 0) onLine(line);
		}
	}

	private schedule(): void {
		if (this.timer) return; // a window is open; merge into it
		this.timer = setTimeout(() => {
			this.timer = null;
			this.flush();
		}, this.policy.debounceMs);
	}

	private flush(): void {
		if (!this.recordPath) return;
		const reports = this.pendingReports;
		const asks = this.pendingAsks;
		const malformed = this.malformed;
		this.pendingReports = [];
		this.pendingAsks = [];
		this.malformed = 0;
		if (reports.length === 0 && asks.length === 0 && malformed === 0) return;
		this.emit({
			text: formatDigest({ recordPath: this.recordPath, reports, asks, malformed }),
			details: { recordPath: this.recordPath, reports, asks, malformed },
		});
	}

	private sizeOf(file: string): number {
		try {
			return fs.statSync(file).size;
		} catch {
			return 0;
		}
	}
}

type ParsedLine =
	| { kind: "report"; report: WakeReport }
	| { kind: "ask"; ask: WakeAsk }
	/** A valid record line that is not news — an ask resolution, for instance. */
	| { kind: "ignored" }
	| { kind: "malformed" };

/**
 * One record line to one digest item. Asks log both asks and their
 * resolutions to the same file, so `type` decides: a resolution is not news
 * (the quartermaster wrote it) and comes back as `ignored`, which is not the
 * same as `malformed` — one is a valid line with nothing to say, the other is
 * a line the record cannot be read from.
 */
function parseLine(line: string): ParsedLine {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return { kind: "malformed" };
	}
	if (typeof value !== "object" || value === null) return { kind: "malformed" };
	const obj = value as Record<string, unknown>;
	if (typeof obj.type === "string") {
		if (obj.type !== "ask") return { kind: "ignored" };
		if (typeof obj.id !== "string" || typeof obj.member !== "string") return { kind: "malformed" };
		if (typeof obj.tool !== "string" || typeof obj.args !== "string") return { kind: "malformed" };
		return {
			kind: "ask",
			ask: {
				id: obj.id,
				member: obj.member,
				tool: obj.tool,
				args: obj.args,
				why: typeof obj.why === "string" ? obj.why : undefined,
			},
		};
	}
	// Reports carry no `type`: id, ts, member, status, summary, confidence.
	if (typeof obj.id !== "string" || typeof obj.member !== "string" || typeof obj.summary !== "string") {
		return { kind: "malformed" };
	}
	return {
		kind: "report",
		report: {
			id: obj.id,
			ts: typeof obj.ts === "number" ? obj.ts : undefined,
			member: obj.member,
			status: typeof obj.status === "string" ? obj.status : "unknown",
			summary: obj.summary,
		},
	};
}

/**
 * The digest text: ids, names, and pointed-at tools. Never the payload —
 * a report's full summary can be thousands of tokens, and the record is one
 * `read_channel` away.
 */
export function formatDigest(details: WakeDetails): string {
	const counts: string[] = [];
	if (details.asks.length > 0) counts.push(`${details.asks.length} permission ask(s)`);
	if (details.reports.length > 0) counts.push(`${details.reports.length} report(s)`);
	// The team is named so a digest that arrives late, after a dissolve or a
	// long turn, cannot be mistaken for news from the team that is running now.
	const team = details.recordPath.split("/").filter(Boolean).pop() ?? "?";
	const lines = [`Wake from the team record of ${team} (${counts.join(", ") || "unreadable entries"}).`];
	if (details.asks.length > 0) {
		lines.push("", "ASKS — a member is blocked and its ask times out in ~10 minutes:");
		for (const ask of details.asks) {
			lines.push(`- ${ask.id} — ${ask.member} asks to run ${ask.tool} ${oneLine(ask.args)}`);
		}
		lines.push('  pending_asks lists them; resolve_ask { id, approve } answers one.');
	}
	if (details.reports.length > 0) {
		lines.push("", "REPORTS — digests only, the record is the blackboard:");
		for (const report of details.reports) {
			const age = report.ts !== undefined ? `, ${ageOf(report.ts)}` : "";
			lines.push(`- ${report.id} (${report.status}${age}) ${report.member}: ${oneLine(report.summary)}`);
		}
		lines.push('  Full text: read_channel "reports".');
	}
	if (details.malformed > 0) {
		lines.push("", `${details.malformed} unreadable line(s) in the record — read the files directly.`);
	}
	return lines.join("\n");
}

/** "just now", "4 min ago", "2 h ago": enough to tell fresh news from a queued digest. */
function ageOf(ts: number, now = Date.now()): string {
	const secs = Math.max(0, Math.round((now - ts) / 1000));
	if (secs < 90) return "just now";
	const mins = Math.round(secs / 60);
	if (mins < 90) return `${mins} min ago`;
	return `${Math.round(mins / 60)} h ago`;
}

/** Collapse whitespace to one line and cap the length. */
function oneLine(text: string, limit = SUMMARY_LIMIT): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}
