/**
 * Configuration locations.
 *
 * User layer: agent and mailbox markdown in ~/.agents (symmetry with the
 * Agent Skills convention already in use), engine config (specs, models,
 * authority, evidence, overrides) under ~/.pi/agent/team.
 *
 * Project layer: .pi/agents and .pi/team, discovered from the working
 * directory up through ancestors. Project entries override user entries
 * of the same name. The project layer is optional and may stay empty
 * forever — the team is personal infrastructure and leaves no footprint
 * in the repos it works in.
 */

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const USER_AGENTS_DIR = path.join(os.homedir(), ".agents", "agents");
export const USER_MAILBOXES_DIR = path.join(os.homedir(), ".agents", "mailboxes");

export function teamDir(): string {
	return path.join(getAgentDir(), "team");
}

/** The team record for one convened team: traffic, reports, asks. */
export function recordDir(teamId: string): string {
	return path.join(teamDir(), "records", teamId);
}

export function userTeamFile(name: string): string {
	return path.join(teamDir(), name);
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Nearest project .pi directory, walking from cwd up through ancestors.
 * Returns null when no .pi exists anywhere above cwd.
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
