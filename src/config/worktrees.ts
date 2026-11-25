/**
 * worktrees.jsonc: how members are placed in git worktrees, and how a fresh
 * worktree is made usable. Project-level, because provisioning is the repo's
 * knowledge (`.pi/team/worktrees.jsonc`): the same declaration serves every
 * member and every session.
 *
 * Absent means the documented defaults: worktrees under the system temp dir,
 * from HEAD, with no setup and nothing copied. Every malformed value warns
 * and falls back to its default alone.
 *
 * Setup commands run in the new worktree with the same authority as a
 * member's `bash` grant: they are code from the repository's own config, so
 * review this file as you would a Makefile.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { projectTeamDir } from "./paths.ts";
import type { DiscoveryWarning } from "./agents.ts";

export interface WorktreeConfig {
	/** Base ref worktree branches start from. Absent: the primary tree's HEAD. */
	base?: string;
	/** Commands run once per new worktree, in it, in order. One failure aborts the spawn. */
	setup: string[];
	/** Untracked files copied from the primary tree before setup runs; exact relative paths, no globs. */
	copy: string[];
	/** Keep clean worktrees when the team dissolves (branches with commits are always kept). */
	keepOnDissolve: boolean;
	/** `tmp`: $TMPDIR/quartermaster/<team>/<member>; `repo`: <repo>/.quartermaster/worktrees/<team>/<member>. */
	location: "tmp" | "repo";
	/**
	 * `auto`: members that can write (edit/write grants) get their own worktree,
	 * everyone else shares the user's tree. `shared`: isolation off unless an
	 * agent or a convene asks for it.
	 */
	default: "auto" | "shared";
	/** Per setup command, in ms. */
	setupTimeoutMs: number;
	/** Where this came from; absent for the defaults. */
	filePath?: string;
}

export const DEFAULT_WORKTREES: WorktreeConfig = {
	setup: [],
	copy: [],
	keepOnDissolve: false,
	location: "tmp",
	default: "auto",
	setupTimeoutMs: 10 * 60 * 1000,
};

export function loadWorktreeConfig(cwd: string, warnings: DiscoveryWarning[]): WorktreeConfig {
	const dir = projectTeamDir(cwd);
	if (!dir) return DEFAULT_WORKTREES;
	const filePath = path.join(dir, "worktrees.jsonc");
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return DEFAULT_WORKTREES;
	}

	const errors: Array<{ error: number }> = [];
	const parsed: unknown = parseJsonc(raw, errors as never, { allowTrailingComma: true });
	if (errors.length > 0 || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		warnings.push({ file: filePath, message: "not a valid JSONC object — using worktree defaults" });
		return DEFAULT_WORKTREES;
	}
	const obj = parsed as Record<string, unknown>;
	const config: WorktreeConfig = { ...DEFAULT_WORKTREES, setup: [], copy: [], filePath };

	for (const key of Object.keys(obj)) {
		if (!["base", "setup", "copy", "keepOnDissolve", "location", "default", "setupTimeoutMs"].includes(key)) {
			warnings.push({ file: filePath, message: `unknown key "${key}" ignored` });
		}
	}

	if (obj.base !== undefined) {
		if (typeof obj.base === "string" && obj.base.trim() && !obj.base.startsWith("-")) config.base = obj.base.trim();
		else warnings.push({ file: filePath, message: "base must be a ref name — using the primary tree's HEAD" });
	}
	config.setup = stringList(obj.setup, "setup", filePath, warnings);
	config.copy = [];
	for (const entry of stringList(obj.copy, "copy", filePath, warnings)) {
		// Exact, relative, inside the repo: copy must never reach for files it
		// was not told about, and a config must not name ones outside the tree.
		const normalized = path.normalize(entry);
		if (path.isAbsolute(entry) || normalized.startsWith("..") || normalized === ".") {
			warnings.push({ file: filePath, message: `copy entry "${entry}" must be a relative path inside the repository — ignored` });
			continue;
		}
		config.copy.push(normalized);
	}
	if (obj.keepOnDissolve !== undefined) {
		if (typeof obj.keepOnDissolve === "boolean") config.keepOnDissolve = obj.keepOnDissolve;
		else warnings.push({ file: filePath, message: "keepOnDissolve must be true or false — using false" });
	}
	if (obj.location !== undefined) {
		if (obj.location === "tmp" || obj.location === "repo") config.location = obj.location;
		else warnings.push({ file: filePath, message: 'location must be "tmp" or "repo" — using "tmp"' });
	}
	if (obj.default !== undefined) {
		if (obj.default === "auto" || obj.default === "shared") config.default = obj.default;
		else warnings.push({ file: filePath, message: 'default must be "auto" or "shared" — using "auto"' });
	}
	if (obj.setupTimeoutMs !== undefined) {
		if (typeof obj.setupTimeoutMs === "number" && Number.isFinite(obj.setupTimeoutMs) && obj.setupTimeoutMs >= 1000) {
			config.setupTimeoutMs = obj.setupTimeoutMs;
		} else {
			warnings.push({ file: filePath, message: `setupTimeoutMs must be a number >= 1000 — using ${DEFAULT_WORKTREES.setupTimeoutMs}` });
		}
	}
	return config;
}

function stringList(value: unknown, key: string, file: string, warnings: DiscoveryWarning[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || !value.every((v) => typeof v === "string" && v.trim() !== "")) {
		warnings.push({ file, message: `${key} must be a list of non-empty strings — ignored` });
		return [];
	}
	return (value as string[]).map((v) => v.trim());
}
