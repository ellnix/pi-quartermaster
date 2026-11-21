/**
 * The team record: files under ~/.pi/agent/team/records/<teamId>/.
 *
 * The record is the blackboard and the audit trail. Traffic is logged
 * here by default and delivered to the quartermaster's context never by
 * default — visible is not in-context. It survives dissolution, so a
 * reconvened team starts with everything its predecessor wrote.
 */

import * as fs from "node:fs";
import type { ReportEntry } from "./crewman.ts";

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
	appendJsonl(`${recordPath}/reports.jsonl`, numbered as unknown as Record<string, unknown>);
	return numbered;
}

export function readReports(recordPath: string, tail?: number): ReportEntry[] {
	return readJsonl<ReportEntry>(`${recordPath}/reports.jsonl`, tail);
}
