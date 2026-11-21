/**
 * Configuration locations.
 *
 * Everything lives under pi's agent directory (getAgentDir(), relocated
 * wholesale by PI_CODING_AGENT_DIR): one home for the team's agents,
 * mailboxes, engine config, evidence, and records. Project overrides
 * live in the repo's .pi directory, discovered from the session's
 * working directory up through ancestors — the same walk pi's shipped
 * subagent example performs; pi exports no public helper for it.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

/** The engine's home under the agent dir. */
export function teamDir(): string {
	return path.join(getAgentDir(), "team");
}

export function userAgentsDir(): string {
	return path.join(teamDir(), "agents");
}

export function userMailboxesDir(): string {
	return path.join(teamDir(), "mailboxes");
}

export function userTeamFile(name: string): string {
	return path.join(teamDir(), name);
}

/** The team record for one convened team: traffic, reports, asks. */
export function recordDir(teamId: string): string {
	return path.join(teamDir(), "records", teamId);
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Nearest project .pi directory, walking from the session's working
 * directory up through ancestors. Returns null when no .pi exists
 * anywhere above cwd. pi exports no helper for this walk — its own
 * shipped subagent example hand-rolls the same one.
 */
export function nearestProjectPiDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

export function projectAgentsDir(cwd: string): string | null {
	const pi = nearestProjectPiDir(cwd);
	return pi ? path.join(pi, "agents") : null;
}

export function projectMailboxesDir(cwd: string): string | null {
	const pi = nearestProjectPiDir(cwd);
	return pi ? path.join(pi, "team", "mailboxes") : null;
}

export function projectTeamDir(cwd: string): string | null {
	const pi = nearestProjectPiDir(cwd);
	return pi ? path.join(pi, "team") : null;
}
