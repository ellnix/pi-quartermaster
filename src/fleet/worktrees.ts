/**
 * Git worktree mechanics for members: create, remove, list, prune.
 *
 * Boring on purpose: every operation shells out to `git worktree` (no
 * libgit2, no clever bookkeeping) and lets git report its own errors. Git is
 * the source of truth for what exists; the only thing this module invents is
 * the naming convention, `quartermaster/<team>/<member>` for branches, which
 * is what lets the janitor recognise its own trees.
 *
 * Invariants it holds:
 * - The primary tree's HEAD, index and branch are never touched. A worktree
 *   is created with `git worktree add -b <new> <path> <sha>`, which only
 *   adds; nothing here checks out, resets or commits in the user's tree.
 * - A tree is never half-provisioned. If copy or setup fails, the worktree,
 *   its branch and its directory are removed before the error is thrown.
 * - Work is not destroyed silently. A tree with uncommitted changes is kept
 *   (and reported) unless the caller explicitly discards it; a branch with
 *   commits is always kept, even when its tree is removed.
 * - It never pushes.
 */

import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { WorktreeConfig } from "../config/worktrees.ts";

const execFileAsync = promisify(execFile);

/** Where a member works: the user's tree, its own worktree, or another member's. */
export interface Placement {
	mode: "shared" | "per-member" | "attach";
	/** The worktree root (the repo's root for `shared`). */
	path: string;
	/** The member's cwd: the worktree root plus the session's subdirectory. */
	cwd: string;
	branch?: string;
	/** The commit the branch started from. */
	base?: string;
	/** For `attach`: the member that owns the tree. */
	attachedTo?: string;
	/** What provisioning did; empty for `shared` and `attach`. */
	provisioned?: { copied: string[]; setup: string[] };
}

export interface RepoInfo {
	toplevel: string;
	/** The session cwd relative to the toplevel ("" at the root). */
	relCwd: string;
}

/** A worktree the janitor found: branch prefix `quartermaster/`. */
export interface ListedWorktree {
	path: string;
	branch: string;
	team: string;
	member: string;
	dirty: boolean;
	/** The directory is gone; `git worktree prune` clears the registration. */
	missing: boolean;
	/** Directory mtime, or null when missing. */
	lastUsed: number | null;
	/** Commits on the branch that its base does not have. */
	unmergedCommits: number;
}

export class GitError extends Error {}

/** Git's own environment must not leak in: a parent hook's GIT_DIR would hijack every call. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
	for (const key of [
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_INDEX_FILE",
		"GIT_COMMON_DIR",
		"GIT_PREFIX",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	]) {
		delete env[key];
	}
	return env;
}

export async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
			env: cleanEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }),
			maxBuffer: 32 * 1024 * 1024,
		});
		return stdout;
	} catch (err) {
		const e = err as { stderr?: Buffer | string; message?: string };
		throw new GitError(`git ${args.join(" ")} failed: ${(e.stderr?.toString() || e.message || "").trim()}`);
	}
}

/** The repository the session sits in, or null when it is not in one. */
export async function repoInfo(cwd: string): Promise<RepoInfo | null> {
	try {
		const top = fs.realpathSync((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
		const real = fs.realpathSync(cwd);
		return { toplevel: top, relCwd: path.relative(top, real) };
	} catch {
		return null;
	}
}

/** Branch and directory names: keep them boring. */
export function safeName(name: string): string {
	return name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "x");
}

export function branchFor(teamId: string, member: string): string {
	return `quartermaster/${teamId}/${safeName(member)}`;
}

export class WorktreeManager {
	constructor(
		private cwd: string,
		private config: WorktreeConfig,
	) {}

	/**
	 * Create a worktree for a member: branch from the base, copy declared
	 * untracked files, run setup. Throws if the cwd is not in a repository
	 * (callers decide the fallback) or on any failure, having cleaned up.
	 */
	async create(teamId: string, member: string): Promise<Placement & { branch: string; base: string }> {
		const info = await repoInfo(this.cwd);
		if (!info) throw new NotGitError(this.cwd);

		const branch = branchFor(teamId, member);
		try {
			await git(info.toplevel, ["check-ref-format", `refs/heads/${branch}`]);
		} catch {
			throw new GitError(`"${branch}" is not a valid branch name`);
		}
		if (await this.branchExists(info.toplevel, branch)) {
			throw new GitError(`branch ${branch} already exists — refusing to reuse it (delete it, or use another member name)`);
		}
		const base = (await git(info.toplevel, ["rev-parse", "--verify", `${this.config.base ?? "HEAD"}^{commit}`])).trim();

		const dir =
			this.config.location === "repo"
				? path.join(info.toplevel, ".quartermaster", "worktrees", teamId, safeName(member))
				: path.join(fs.realpathSync(os.tmpdir()), "quartermaster", teamId, safeName(member));
		if (fs.existsSync(dir)) {
			throw new GitError(`${dir} already exists — refusing to reuse it`);
		}
		if (this.config.location === "repo") await this.excludeFromRepo(info.toplevel);
		fs.mkdirSync(path.dirname(dir), { recursive: true });

		await git(info.toplevel, ["worktree", "add", "-b", branch, dir, base]);
		const placement = {
			mode: "per-member" as const,
			path: dir,
			cwd: info.relCwd ? path.join(dir, info.relCwd) : dir,
			branch,
			base,
			provisioned: { copied: [] as string[], setup: [] as string[] },
		};
		try {
			placement.provisioned.copied = await this.copyDeclared(info.toplevel, dir);
			for (const command of this.config.setup) {
				await runSetup(command, dir, this.config.setupTimeoutMs);
				placement.provisioned.setup.push(command);
			}
		} catch (err) {
			await this.discard(info.toplevel, dir, branch);
			throw new GitError(
				`worktree for "${member}" was removed because provisioning failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		return placement;
	}

	/**
	 * Remove a member's tree and, when nothing is lost, its branch.
	 * A dirty tree is kept unless `discardDirty`; a branch with commits is
	 * always kept. Returns what happened, as plain sentences.
	 */
	async remove(placement: Placement, opts: { discardDirty?: boolean } = {}): Promise<string[]> {
		if (placement.mode === "shared" || !placement.branch) return [];
		const notes: string[] = [];
		const info = await repoInfo(this.cwd);
		if (!info) return [`${placement.path} left alone: not inside a repository to run git from`];

		const present = fs.existsSync(placement.path);
		if (present && !opts.discardDirty && (await this.isDirty(placement.path))) {
			return [`${placement.path} kept: it has uncommitted changes (branch ${placement.branch}); commit or discard them, then remove it with git worktree remove`];
		}
		try {
			if (present) await git(info.toplevel, ["worktree", "remove", "--force", placement.path]);
			else await git(info.toplevel, ["worktree", "prune"]);
			notes.push(`removed worktree ${placement.path}`);
		} catch (err) {
			return [`${placement.path} not removed: ${err instanceof Error ? err.message : String(err)}`];
		}
		if (fs.existsSync(placement.path)) fs.rmSync(placement.path, { recursive: true, force: true });
		notes.push(await this.dropBranchIfEmpty(info.toplevel, placement.branch, placement.base));
		return notes;
	}

	/** Every quartermaster worktree of this repository, live or not. */
	async list(): Promise<ListedWorktree[]> {
		const info = await repoInfo(this.cwd);
		if (!info) return [];
		const raw = await git(info.toplevel, ["worktree", "list", "--porcelain"]);
		const out: ListedWorktree[] = [];
		for (const block of raw.split("\n\n")) {
			const lines = block.split("\n");
			const wt = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length);
			const ref = lines.find((l) => l.startsWith("branch "))?.slice("branch ".length);
			if (!wt || !ref?.startsWith("refs/heads/quartermaster/")) continue;
			const branch = ref.slice("refs/heads/".length);
			const [, team = "", ...rest] = branch.split("/");
			const missing = !fs.existsSync(wt);
			out.push({
				path: wt,
				branch,
				team,
				member: rest.join("/"),
				missing,
				dirty: missing ? false : await this.isDirty(wt),
				lastUsed: missing ? null : fs.statSync(wt).mtimeMs,
				unmergedCommits: await this.unmerged(info.toplevel, branch, undefined),
			});
		}
		return out;
	}

	/**
	 * The janitor: remove quartermaster worktrees not claimed by a live
	 * member (`keep` says which to leave). Dirty ones are skipped unless
	 * `discardDirty`; branches with commits survive. A line per decision.
	 */
	async prune(keep: (wt: ListedWorktree) => boolean, opts: { discardDirty?: boolean } = {}): Promise<string[]> {
		const info = await repoInfo(this.cwd);
		if (!info) return ["not inside a git repository: nothing to prune"];
		const notes: string[] = [];
		for (const wt of await this.list()) {
			if (keep(wt)) continue;
			const outcome = await this.remove(
				{ mode: "per-member", path: wt.path, cwd: wt.path, branch: wt.branch },
				{ discardDirty: opts.discardDirty },
			);
			notes.push(...outcome);
		}
		await git(info.toplevel, ["worktree", "prune"]);
		return notes.length > 0 ? notes : ["nothing to prune"];
	}

	/** Whether a tree has uncommitted work (tracked changes or untracked, non-ignored files). */
	async isDirty(treePath: string): Promise<boolean> {
		if (!fs.existsSync(treePath)) return false;
		return (await git(treePath, ["status", "--porcelain"])).trim().length > 0;
	}

	private async branchExists(repo: string, branch: string): Promise<boolean> {
		try {
			await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
			return true;
		} catch {
			return false;
		}
	}

	/** Commits on the branch that its base (or, failing that, HEAD) lacks. */
	private async unmerged(repo: string, branch: string, base: string | undefined): Promise<number> {
		try {
			const out = await git(repo, ["rev-list", "--count", branch, "--not", base ?? this.config.base ?? "HEAD"]);
			return Number.parseInt(out.trim(), 10) || 0;
		} catch {
			return 0;
		}
	}

	private async dropBranchIfEmpty(repo: string, branch: string, base: string | undefined): Promise<string> {
		if (!(await this.branchExists(repo, branch))) return `branch ${branch} already gone`;
		const commits = await this.unmerged(repo, branch, base);
		if (commits > 0) return `branch ${branch} kept: ${commits} commit(s) not in its base; compare with git diff ${base ? base.slice(0, 9) : "<base>"}...${branch}`;
		await git(repo, ["branch", "-D", branch]);
		return `deleted empty branch ${branch}`;
	}

	/** Undo a half-made worktree: tree, registration, branch, directory. */
	private async discard(repo: string, dir: string, branch: string): Promise<void> {
		try {
			await git(repo, ["worktree", "remove", "--force", dir]);
		} catch {
			// fall through to the manual cleanup below
		}
		if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
		try {
			await git(repo, ["worktree", "prune"]);
		} catch {
			// best effort
		}
		if (await this.branchExists(repo, branch)) {
			try {
				await git(repo, ["branch", "-D", branch]);
			} catch {
				// best effort
			}
		}
	}

	/**
	 * Copy exactly the declared untracked files from the user's tree. Nothing
	 * else is ever copied; entries that resolve outside the repository (a
	 * symlink out) are refused, and a declared file that does not exist is an
	 * error, because a half-provisioned tree fails mysteriously later.
	 */
	private async copyDeclared(toplevel: string, dir: string): Promise<string[]> {
		const copied: string[] = [];
		for (const entry of this.config.copy) {
			const src = path.join(toplevel, entry);
			let real: string;
			try {
				real = fs.realpathSync(src);
			} catch {
				throw new GitError(`copy: "${entry}" does not exist in ${toplevel}`);
			}
			if (real !== toplevel && !real.startsWith(toplevel + path.sep)) {
				throw new GitError(`copy: "${entry}" resolves outside the repository — refused`);
			}
			const dest = path.join(dir, entry);
			if (await this.tracked(dir, entry)) continue; // already in the tree via git
			fs.mkdirSync(path.dirname(dest), { recursive: true });
			fs.cpSync(real, dest, { recursive: true, dereference: false });
			copied.push(entry);
		}
		return copied;
	}

	private async tracked(dir: string, entry: string): Promise<boolean> {
		try {
			await git(dir, ["ls-files", "--error-unmatch", "--", entry]);
			return true;
		} catch {
			return false;
		}
	}

	/** Keep `.quartermaster/` out of the user's `git status`, without touching tracked files. */
	private async excludeFromRepo(toplevel: string): Promise<void> {
		const file = path.resolve(toplevel, (await git(toplevel, ["rev-parse", "--git-path", "info/exclude"])).trim());
		let current = "";
		try {
			current = fs.readFileSync(file, "utf8");
		} catch {
			// absent: create it
		}
		if (current.split("\n").includes("/.quartermaster/")) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}/.quartermaster/\n`);
	}
}

export class NotGitError extends Error {
	constructor(cwd: string) {
		super(`${cwd} is not inside a git repository`);
	}
}

/**
 * Run one setup command in the new tree through `sh -c`, killing its whole
 * process group on timeout. It runs with the same authority as a member's
 * bash grant: the command comes from the repository's own config.
 */
function runSetup(command: string, cwd: string, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("sh", ["-c", command], {
			cwd,
			env: cleanEnv(),
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let tail = "";
		const keep = (chunk: Buffer) => {
			tail = (tail + chunk.toString()).slice(-4000);
		};
		child.stdout.on("data", keep);
		child.stderr.on("data", keep);
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(new Error(`setup "${command}" could not start: ${err.message}`));
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			if (timedOut) reject(new Error(`setup "${command}" timed out after ${timeoutMs}ms`));
			else if (code === 0) resolve();
			else reject(new Error(`setup "${command}" failed (${code ?? signal}): ${tail.trim().split("\n").slice(-8).join("\n")}`));
		});
	});
}

/**
 * The `worktrees` tool: list this repository's quartermaster trees, or prune
 * unclaimed ones. `live` holds the branches of this session's active members,
 * which are never pruned. Pruning needs an explicit scope because another
 * running session's trees look unclaimed from here.
 */
export async function worktreesReport(
	manager: WorktreeManager,
	live: Set<string>,
	input: { prune?: boolean; team?: string; all?: boolean; discardDirty?: boolean },
): Promise<{ ok: boolean; message: string }> {
	if (input.prune) {
		if (!input.team && !input.all) {
			return {
				ok: false,
				message:
					"prune needs a scope: team (a team id from the listing) or all. Trees of another running session look unclaimed from here, so name what you mean to remove.",
			};
		}
		const notes = await manager.prune(
			(wt) => live.has(wt.branch) || (input.team !== undefined && !input.all && wt.team !== input.team),
			{ discardDirty: input.discardDirty },
		);
		return { ok: true, message: notes.join("\n") };
	}
	const trees = await manager.list();
	if (trees.length === 0) return { ok: true, message: "No quartermaster worktrees for this repository." };
	const lines = trees.map((t) => {
		const flags = [
			live.has(t.branch) ? "live" : "unclaimed",
			t.missing ? "directory missing (prunable)" : t.dirty ? "dirty" : "clean",
			t.unmergedCommits > 0 ? `${t.unmergedCommits} commit(s) ahead` : "no commits",
		];
		const used = t.lastUsed ? new Date(t.lastUsed).toISOString() : "-";
		return `- ${t.team}/${t.member} on ${t.branch} at ${t.path} [${flags.join(", ")}] last used ${used}`;
	});
	return { ok: true, message: lines.join("\n") };
}
