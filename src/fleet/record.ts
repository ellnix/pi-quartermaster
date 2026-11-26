/**
 * The team record: files under the agent dir's team/records/<teamId>/.
 *
 * The record is the blackboard and the audit trail. Traffic is logged
 * here by default and delivered to the quartermaster's context never by
 * default — visible is not in-context. It survives dissolution, so a
 * reconvened team starts with everything its predecessor wrote.
 *
 * Endpoints are denormalized into every entry: the record must stay
 * self-contained without the fleet's live wiring to decode it.
 */

import * as fs from "node:fs";
import { asksFile, channelFile, compositionFile, reportsFile } from "../config/paths.ts";
import type { ReportEntry } from "./crewman.ts";
import type { ModelSource } from "../engine.ts";

export function ensureRecord(recordPath: string): void {
	fs.mkdirSync(recordPath, { recursive: true });
}

export function appendJsonl(file: string, entry: Record<string, unknown>): void {
	fs.mkdirSync(file.slice(0, file.lastIndexOf("/")), { recursive: true });
	fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

export function readJsonl<T>(file: string, tail?: number): T[] {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	const selected = tail !== undefined && tail > 0 ? lines.slice(-tail) : lines;
	const out: T[] = [];
	for (const line of selected) {
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// A torn line never takes down a read; skip it.
		}
	}
	return out;
}

export function appendReport(recordPath: string, entry: Omit<ReportEntry, "id">): ReportEntry {
	const existing = readReports(recordPath);
	// Sequential per record: r1, r2, ... An explicit count beats parsing the
	// last line, because a torn line must not restart the sequence.
	const numbered: ReportEntry = { id: `r${existing.length + 1}`, ...entry };
	appendJsonl(reportsFile(recordPath), numbered as unknown as Record<string, unknown>);
	return numbered;
}

export function readReports(recordPath: string, tail?: number): ReportEntry[] {
	return readJsonl<ReportEntry>(reportsFile(recordPath), tail);
}

export interface ChannelEntry {
	/**
	 * Tracking number, sequential per channel: m1, m2, ... Both sides and the
	 * quartermaster can cite a message by reference.
	 */
	id: string;
	/** The channel this traveled on: a mailbox name or "quartermaster". */
	channel: string;
	ts: number;
	from: string;
	to: string;
	body: string;
}

/** Channel logs are named by config/paths.ts, beside the two watched files. */
export { channelFile } from "../config/paths.ts";

export function appendChannel(recordPath: string, mailbox: string, entry: Omit<ChannelEntry, "id">): ChannelEntry {
	const existing = readChannelLog(recordPath, mailbox);
	const numbered: ChannelEntry = { id: `m${existing.length + 1}`, ...entry };
	appendJsonl(channelFile(recordPath, mailbox), numbered as unknown as Record<string, unknown>);
	return numbered;
}

export function readChannelLog(recordPath: string, mailbox: string, tail?: number): ChannelEntry[] {
	return readJsonl<ChannelEntry>(channelFile(recordPath, mailbox), tail);
}

/**
 * A composition event: the team's roster history, append-only. Carries the
 * drawn model and weighted dimensions so a removed member can still be rated
 * from the record alone.
 */
export interface CompositionEntry {
	type: "added" | "removed" | "channel_opened" | "channel_closed";
	ts: number;
	/** The member added or removed; absent on channel events. */
	member?: string;
	/** Channel events: the channel id, template and wired endpoints. */
	channel?: string;
	template?: string;
	from?: string;
	to?: string;
	/** The agent definition (file) behind the member. */
	definition?: string;
	model?: string;
	/** How the model was resolved: an explicit choice, an agent pin, or the draw. */
	modelSource?: ModelSource;
	dimensions?: Array<{ dimension: string; weight: number }>;
	/** "convene" or "add_member" for additions. */
	via?: string;
	/** Where an added member works, when isolated or attached. */
	worktree?: { mode: string; path: string; branch?: string; base?: string; attachedTo?: string };
	reason?: string;
	forced?: boolean;
	by: "quartermaster";
}

export function appendComposition(recordPath: string, entry: CompositionEntry): void {
	appendJsonl(compositionFile(recordPath), entry as unknown as Record<string, unknown>);
}

export function readComposition(recordPath: string): CompositionEntry[] {
	return readJsonl<CompositionEntry>(compositionFile(recordPath));
}

export interface AskEntry {
	id: string;
	ts: number;
	member: string;
	tool: string;
	args: string;
	why: string;
}

export interface ResolutionEntry {
	ts: number;
	id: string;
	approve: boolean;
	by: "quartermaster";
	userConfirmed?: string;
	/** Why, when the engine resolved it (e.g. the asker was force-removed). */
	note?: string;
}

export interface AskRecordEntry extends Partial<ResolutionEntry> {
	type: "ask" | "resolution";
}

export function appendAsk(recordPath: string, entry: AskEntry): void {
	appendJsonl(asksFile(recordPath), { type: "ask", ...entry } as unknown as Record<string, unknown>);
}

export function appendResolution(recordPath: string, entry: ResolutionEntry): void {
	appendJsonl(asksFile(recordPath), { type: "resolution", ...entry } as unknown as Record<string, unknown>);
}

export function readAskLog(recordPath: string): Array<{ ask?: AskEntry; resolution?: ResolutionEntry }> {
	const raw = readJsonl<AskRecordEntry>(asksFile(recordPath));
	const out: Array<{ ask?: AskEntry; resolution?: ResolutionEntry }> = [];
	for (const entry of raw) {
		if (entry.type === "ask") {
			const { type: _t, ...ask } = entry;
			out.push({ ask: ask as AskEntry });
		} else if (entry.type === "resolution") {
			const { type: _t, ...resolution } = entry;
			out.push({ resolution: resolution as ResolutionEntry });
		}
	}
	return out;
}

/** Pending asks: latest ask per id without a later resolution. */
export function pendingAsks(recordPath: string): AskEntry[] {
	const pending = new Map<string, AskEntry>();
	for (const { ask, resolution } of readAskLog(recordPath)) {
		if (ask) pending.set(ask.id, ask);
		else if (resolution) pending.delete(resolution.id);
	}
	return [...pending.values()];
}

export function askResolution(recordPath: string, id: string): ResolutionEntry | null {
	let found: ResolutionEntry | null = null;
	for (const { resolution } of readAskLog(recordPath)) {
		if (resolution?.id === id) found = resolution;
	}
	return found;
}

/** Human-facing classification text for a pending ask. */
export function classifyForDisplay(classification: "auto" | "escalate"): string | undefined {
	return classification === "auto"
		? "auto-approvable: policy lets the quartermaster approve this alone"
		: "escalate-only: approving requires the user's confirmation quoted in userConfirmed";
}
