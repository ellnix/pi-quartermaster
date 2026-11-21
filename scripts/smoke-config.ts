/**
 * Smoke check for the configuration loader. Read-only: discovers every
 * layer, prints what it found and every warning. Run against a fixture
 * directory to exercise validation paths:
 *
 *   npx tsx scripts/smoke-config.ts [cwd]
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config/index.ts";
import { nearestProjectPiDir } from "../src/config/paths.ts";

/**
 * Exercise the project discovery walk in a throwaway tree: a .pi above the
 * git root must not be found, while a .pi in the repository root must be.
 */
function checkProjectDiscovery(): string[] {
	const lines: string[] = [];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "qm-discovery-"));
	try {
		const repo = path.join(root, "repo");
		const nested = path.join(repo, "sub");
		fs.mkdirSync(nested, { recursive: true });
		fs.mkdirSync(path.join(repo, ".git"));
		fs.mkdirSync(path.join(root, ".pi"));

		const aboveRepo = nearestProjectPiDir(nested);
		lines.push(`  .pi above the git root: ${aboveRepo === null ? "not found (correct)" : `FOUND ${aboveRepo} — WRONG`}`);

		const inRepo = path.join(repo, ".pi");
		fs.mkdirSync(inRepo);
		const found = nearestProjectPiDir(nested);
		lines.push(`  .pi in the repo root: ${found === inRepo ? "found (correct)" : `got ${found} — WRONG`}`);

		if (aboveRepo !== null || found !== inRepo) {
			throw new Error("project discovery does not stop at the git repository root");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	return lines;
}

/**
 * True when any ancestor of the directory holds a .git marker, using the
 * same rule as the code under test: success is a marker, only ENOENT means
 * there is none here.
 */
function hasGitAncestor(dir: string): boolean {
	let current = path.resolve(dir);
	while (true) {
		try {
			fs.statSync(path.join(current, ".git"));
			return true;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") return true;
		}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

/**
 * Exercise the walk with a worktree, where .git is a file rather than a
 * directory, and with no repository root at all.
 */
function checkGitFileAndOpenWalk(): string[] {
	const lines: string[] = [];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "qm-discovery-"));
	try {
		const worktree = path.join(root, "worktree");
		const nested = path.join(worktree, "sub");
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /elsewhere\n");
		fs.mkdirSync(path.join(root, ".pi"));

		const aboveWorktree = nearestProjectPiDir(nested);
		lines.push(`  .pi above a worktree (.git file): ${aboveWorktree === null ? "not found (correct)" : `FOUND ${aboveWorktree} — WRONG`}`);

		// The no-repository walk needs a fixture outside any repository; a
		// temp dir inside one has a .git root that legitimately stops us.
		const open = path.join(root, "open", "deeper");
		fs.mkdirSync(open, { recursive: true });
		const openPi = path.join(root, ".pi");
		if (hasGitAncestor(root)) {
			throw new Error(
				`cannot test the no-repository walk: ${root} is inside a git repository, so the fixture's .git stops the walk. Point TMPDIR at a directory outside any repository.`,
			);
		}
		const openFound = nearestProjectPiDir(open);
		const openRight = openFound === openPi;
		lines.push(`  no .git anywhere: ${openRight ? "walked to the .pi above (correct)" : `got ${openFound} — WRONG`}`);

		if (aboveWorktree !== null || !openRight) {
			throw new Error("worktree or open-ended walk behaves unexpectedly");
		}
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	return lines;
}

/**
 * Exercise the mailbox loader's warning when frontmatter fails to parse
 * mid-file: the parser's reason must reach the user.
 */
function checkFrontmatterWarning(): string[] {
	const lines: string[] = [];
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "qm-frontmatter-"));
	try {
		const dir = path.join(root, ".pi", "team", "mailboxes");
		fs.mkdirSync(dir, { recursive: true });
		const broken = path.join(dir, "broken.md");
		fs.writeFileSync(broken, ["---", "name: broken", "description: broken", "bad: [unclosed", "---", "body"].join("\n"));

		const warnings = loadConfig(root).warnings.filter((w) => w.file === broken);
		const message = warnings[0]?.message ?? "none";
		const shown = message.split("\n")[0];
		const right = warnings.length === 1 && message.includes("invalid YAML") && !message.includes("no frontmatter at line 1");
		lines.push(`  mailbox with mid-file YAML breakage: ${right ? `"${shown}" (correct)` : `"${shown}" — WRONG`}`);
		if (!right) throw new Error("mailbox loader does not surface the frontmatter parse reason");
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	return lines;
}

const cwd = process.argv[2] ?? process.cwd();
const config = loadConfig(cwd);

const lines: string[] = [];
lines.push(`config for ${cwd}`);
lines.push(`agents (${config.agents.size}):`);
for (const a of config.agents.values()) {
	lines.push(`  - ${a.name} [${a.source}] spec=${a.spec ? `τ${a.spec.temperature} ${JSON.stringify(a.spec.weights)}` : "-"} model=${a.model ?? "-"} tools=${a.tools?.join(",") ?? "-"} :: ${a.description.split("\n")[0]}`);
}
lines.push(`mailboxes (${config.mailboxes.size}):`);
for (const m of config.mailboxes.values()) {
	lines.push(`  - ${m.name} [${m.source}] (template - endpoints wired at convene) :: ${m.description.split("\n")[0]}`);
}
lines.push(`models (${config.models.size}):`);
for (const [id, m] of config.models) {
	lines.push(`  - ${id} cost=${m.cost ?? "-"} require=${JSON.stringify(m.require ?? null)} scores=${JSON.stringify(m.scores ?? {})}`);
}
lines.push(`authority: autoApprove=${JSON.stringify(config.authority.autoApprove)} escalate=${JSON.stringify(config.authority.escalate)}`);

lines.push("", "project discovery (git root stops the walk):");
lines.push(...checkProjectDiscovery());
lines.push(...checkGitFileAndOpenWalk());
lines.push("", "frontmatter warnings (parser reason required):");
lines.push(...checkFrontmatterWarning());

if (config.emptyState) lines.push("", config.emptyState);
if (config.warnings.length) {
	lines.push("", `warnings (${config.warnings.length}):`);
	for (const w of config.warnings) lines.push(`  - ${w.file}: ${w.message}`);
}

console.log(lines.join("\n"));
