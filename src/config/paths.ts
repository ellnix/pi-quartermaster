/**
 * Configuration locations.
 *
 * Everything lives under pi's agent directory (getAgentDir(), relocated
 * wholesale by PI_CODING_AGENT_DIR): one home for the team's agents,
 * mailboxes, engine config, evidence, and records. Project overrides
 * live in the repo's .pi directory, discovered from the session's
 * working directory up through ancestors and stopping at the git
 * repository root — passing that root would let a repo without .pi
 * inherit the global agent dir as project config. pi exports no public
 * helper for this walk.
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

/**
 * The record's files. Named here, in one place, because the wake watcher
 * observes exactly two of them: reports.jsonl and asks.jsonl. Channel logs
 * under channels/ are never watched — inter-agent mail is not news.
 */
export function reportsFile(recordPath: string): string {
	return path.join(recordPath, "reports.jsonl");
}

/** The ask log: asks and their resolutions share it, told apart by `type`. */
export function asksFile(recordPath: string): string {
	return path.join(recordPath, "asks.jsonl");
}

/** Composition history: members added and removed, with who/when/why. */
export function compositionFile(recordPath: string): string {
	return path.join(recordPath, "composition.jsonl");
}

/** Directory of per-mailbox channel logs. */
export function channelsDir(recordPath: string): string {
	return path.join(recordPath, "channels");
}

export function channelFile(recordPath: string, mailbox: string): string {
	return path.join(channelsDir(recordPath), `${mailbox}.jsonl`);
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * True when the directory holds a git marker: `.git` as a directory in a
 * clone, as a file in worktrees and submodules.
 *
 * Only a missing marker means "no repository here". Any other stat failure
 * (EACCES, ELOOP) still stops the walk — walking past a root we merely
 * cannot inspect is the bug this check exists to prevent.
 */
function hasGitMarker(dir: string): boolean {
	try {
		fs.statSync(path.join(dir, ".git"));
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/**
 * Nearest project .pi directory, walking from the session's working
 * directory up through ancestors and stopping at the git repository root.
 *
 * `.git` counts whether it is a directory or a file, so worktrees and
 * submodules stop at their own root. Returns null when the walk ends without
 * finding a .pi: either a .git marker stopped it first — the nearest .pi
 * lies above the repository root — or no .git exists before the filesystem
 * root and no .pi was found on the way. That second case means a session
 * started in a non-repository directory under $HOME can still find ~/.pi,
 * which is accepted, documented behaviour.
 */
export function nearestProjectPiDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	while (true) {
		const candidate = path.join(current, ".pi");
		if (isDirectory(candidate)) return candidate;
		if (hasGitMarker(current)) return null;
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
