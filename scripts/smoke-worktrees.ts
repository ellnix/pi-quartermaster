/**
 * Smoke check for per-member worktrees, against REAL git in a throwaway
 * fixture repository (never the package repo). Sessions are stubs: no model
 * calls. Covers placement, isolation, attach, copy-before-setup, setup
 * failure with no orphan, lifecycle (remove, dissolve, keepOnDissolve), the
 * janitor, non-git fallback, and that the primary tree is never touched.
 *
 *   npx tsx scripts/smoke-worktrees.ts
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_WORKTREES, type WorktreeConfig } from "../src/config/worktrees.ts";
import { Fleet } from "../src/fleet/fleet.ts";
import { WorktreeManager, worktreesReport } from "../src/fleet/worktrees.ts";

const sh = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "qm-wt-")));
const tmpHome = path.join(root, "tmp");
fs.mkdirSync(tmpHome);
process.env.TMPDIR = tmpHome;

function makeRepo(name: string): string {
	const repo = path.join(root, name);
	fs.mkdirSync(repo);
	sh(repo, "init", "-q", "-b", "main");
	sh(repo, "config", "user.email", "t@example.com");
	sh(repo, "config", "user.name", "T");
	fs.writeFileSync(path.join(repo, "app.txt"), "one\n");
	fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n");
	sh(repo, "add", ".");
	sh(repo, "commit", "-q", "-m", "init");
	return repo;
}

const checks: Array<[string, boolean]> = [];
const ok = (label: string, cond: boolean) => checks.push([label, cond]);
const config = (over: Partial<WorktreeConfig> = {}): WorktreeConfig => ({ ...DEFAULT_WORKTREES, ...over });
const agent = (name: string, tools: string[], worktree?: string): any => ({
	name, definition: name, description: `${name} d`, systemPrompt: "", source: "user", filePath: "", tools, worktree,
});
const stubSession = () => ({ prompts: [] as string[], prompt() { return Promise.resolve(); }, async abort() {}, dispose() {} });

function fleetFor(repo: string, wt: WorktreeConfig): any {
	const cfg: any = { agents: new Map(), mailboxes: new Map(), models: new Map(), authority: {}, worktrees: wt, warnings: [] };
	const fleet: any = new Fleet({ cwd: repo } as any, cfg, {} as any, {} as any);
	fleet.teamId = "t1";
	fleet.recordPath = fs.mkdtempSync(path.join(root, "rec-"));
	return fleet;
}
/** Spawn through the real placement path, with a stub where the model draw would be. */
async function spawn(fleet: any, a: any, ws: any = {}, warnings: string[] = []): Promise<any> {
	const member: any = { name: a.name, agent: a, state: "convening", pendingDelivery: [], notices: [] };
	fleet.members.set(a.name, member);
	try {
		member.placement = await fleet.place(member, ws, warnings);
	} catch (err) {
		fleet.members.delete(a.name);
		throw err;
	}
	member.session = stubSession();
	member.state = "idle";
	return member;
}

const repo = makeRepo("repo");
const primaryHead = sh(repo, "rev-parse", "HEAD");
const primaryStatus = () => sh(repo, "status", "--porcelain");
fs.writeFileSync(path.join(repo, "user-wip.txt"), "the user's uncommitted work\n");
let baselineStatus = primaryStatus();

// 1. Two builders -> two distinct worktrees, independent branches, neither the primary tree.
const fleet = fleetFor(repo, config());
const b1 = await spawn(fleet, agent("builder", ["read", "edit", "write", "bash"]));
const b2 = await spawn(fleet, agent("builder-b", ["read", "edit", "write", "bash"]));
const p1 = b1.placement, p2 = b2.placement;
ok("writers get their own worktrees by default", p1?.mode === "per-member" && p2?.mode === "per-member");
ok("two distinct paths, neither the user's tree", p1.path !== p2.path && p1.path !== repo && p2.path !== repo && fs.existsSync(p1.path) && fs.existsSync(p2.path));
ok("both are worktrees of the repo, on their own branches", sh(p1.path, "rev-parse", "--abbrev-ref", "HEAD") === "quartermaster/t1/builder" && sh(p2.path, "rev-parse", "--abbrev-ref", "HEAD") === "quartermaster/t1/builder-b");
ok("the session cwd is the tree", p1.cwd === p1.path);

// 2. A write in one tree leaves the user's tree and the other member's untouched.
fs.writeFileSync(path.join(p1.path, "app.txt"), "changed by builder\n");
fs.writeFileSync(path.join(p1.path, "new.txt"), "x\n");
ok("a write in one tree does not touch the user's tree", primaryStatus() === baselineStatus && fs.readFileSync(path.join(repo, "app.txt"), "utf8") === "one\n");
ok("nor the other member's tree", sh(p2.path, "status", "--porcelain") === "" && fs.readFileSync(path.join(p2.path, "app.txt"), "utf8") === "one\n");
ok("the user's HEAD, branch and uncommitted work are unchanged", sh(repo, "rev-parse", "HEAD") === primaryHead && sh(repo, "rev-parse", "--abbrev-ref", "HEAD") === "main" && fs.existsSync(path.join(repo, "user-wip.txt")));

// 3. Attach: a reader joins the owner's path; writers may not attach.
const rv = await spawn(fleet, agent("reviewer", ["read", "grep", "bash"], "attach"), { attachTo: "builder" });
ok("attach places the reader in the owner's path", rv.placement.mode === "attach" && rv.placement.path === p1.path && rv.placement.attachedTo === "builder");
const attachStatus = fleet.status().members.find((m: any) => m.name === "reviewer");
ok("status records the attachment", attachStatus.workspace?.mode === "attach" && attachStatus.workspace.attachedTo === "builder");
let refused = "";
try { await spawn(fleet, agent("sneaky", ["read", "edit"], "attach"), { attachTo: "builder" }); } catch (e) { refused = String(e); }
ok("a writer cannot attach", refused.includes("may not attach"));
refused = "";
try { await spawn(fleet, agent("r2", ["read"], "attach"), {}); } catch (e) { refused = String(e); }
ok("attach without an owner is refused", refused.includes("attachTo"));
refused = "";
try { await spawn(fleet, agent("r3", ["read"], "attach"), { attachTo: "nobody" }); } catch (e) { refused = String(e); }
ok("attach to an unknown member is refused", refused.includes("not an active member"));
const workspaceText = fleet.workspaceLines(rv).join("\n");
ok("the reader is told not to modify the tree", workspaceText.includes("Do not modify"));
ok("the owner is told its branch and to commit, never push", fleet.workspaceLines(b1).join("\n").includes("Never push"));
ok("a bare tree is announced as bare", fleet.workspaceLines(b1).join("\n").includes("bare"));

// 4. Shared by default for read-only agents, and by request.
const scout = await spawn(fleet, agent("scout", ["read", "grep"]));
ok("read-only agents share the user's tree by default", scout.placement === undefined);
const forced = await spawn(fleet, agent("wip-builder", ["read", "edit"], "shared"));
ok("an agent can ask for the shared tree", forced.placement === undefined);

// 5. Remove: a dirty tree is kept, a clean empty one goes with its branch, attach blocks removal of the owner.
fleet.members.get("reviewer").state = "idle";
const blocked = await fleet.removeMember({ member: "builder" });
ok("removing an owner with an attached reader is refused", !blocked.ok && blocked.message.includes("attached"));
await fleet.removeMember({ member: "reviewer" });
const dirtyRemoval = await fleet.removeMember({ member: "builder" });
ok("a dirty tree survives removal and says so", dirtyRemoval.ok && fs.existsSync(p1.path) && JSON.stringify(dirtyRemoval).includes("uncommitted"));
const cleanRemoval = await fleet.removeMember({ member: "builder-b" });
ok("a clean, empty tree and its branch are removed with the member", cleanRemoval.ok && !fs.existsSync(p2.path) && !sh(repo, "branch", "--list", "quartermaster/t1/builder-b"));

// 6. Janitor: lists what is left, prunes unclaimed trees, never branches with commits.
const manager = new WorktreeManager(repo, config());
const listing = await worktreesReport(manager, fleet.liveBranches(), {});
ok("the janitor lists the kept tree as dirty and unclaimed", listing.message.includes("quartermaster/t1/builder") && listing.message.includes("dirty") && listing.message.includes("unclaimed"));
const noScope = await worktreesReport(manager, new Set(), { prune: true });
ok("prune demands a scope", !noScope.ok && noScope.message.includes("scope"));
const keptDirty = await worktreesReport(manager, new Set(), { prune: true, all: true });
ok("prune skips dirty trees by default", fs.existsSync(p1.path) && keptDirty.message.includes("uncommitted"));
sh(p1.path, "add", "-A"); sh(p1.path, "-c", "user.email=t@e.com", "-c", "user.name=T", "commit", "-q", "-m", "builder work");
const keptCommits = await worktreesReport(manager, new Set(), { prune: true, all: true });
ok("prune removes a clean tree but keeps a branch with commits", !fs.existsSync(p1.path) && keptCommits.message.includes("kept") && sh(repo, "branch", "--list", "quartermaster/t1/builder") !== "");
ok("the kept branch carries the work", sh(repo, "show", "quartermaster/t1/builder:new.txt") === "x");
ok("no prunable registrations remain", !sh(repo, "worktree", "list", "--porcelain").includes("prunable"));

// 7. Copy lands before setup runs; setup runs once per tree; refuses to reuse a branch.
fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
fs.writeFileSync(path.join(repo, ".other"), "not declared\n");
baselineStatus = primaryStatus(); // the test itself added a user-side file; the engine must add nothing beyond it
const f2 = fleetFor(repo, config({ copy: [".env"], setup: ["test -f .env && cp .env setup-saw-env", "echo ran >> setup-count"] }));
f2.teamId = "t2";
const pb = await spawn(f2, agent("pb", ["edit"]));
ok("copy lands the declared untracked file", fs.readFileSync(path.join(pb.placement.path, ".env"), "utf8") === "SECRET=1\n");
ok("copy happens before setup", fs.existsSync(path.join(pb.placement.path, "setup-saw-env")));
ok("undeclared untracked files are not copied", !fs.existsSync(path.join(pb.placement.path, ".other")));
ok("setup ran once", fs.readFileSync(path.join(pb.placement.path, "setup-count"), "utf8") === "ran\n");
ok("the provisioning is reported to the member", f2.workspaceLines(pb).join("\n").includes("copied .env"));
let reuse = "";
try { await new WorktreeManager(repo, config()).create("t2", "pb"); } catch (e) { reuse = String(e); }
ok("an existing branch is never reused", reuse.includes("already exists"));

// 8. Setup failure: spawn fails loudly, worktree and branch and directory are gone.
const f3 = fleetFor(repo, config({ setup: ["echo boom >&2; exit 3"] }));
f3.teamId = "t3";
let failure = "";
try { await spawn(f3, agent("doomed", ["edit"])); } catch (e) { failure = String(e); }
const doomedDir = path.join(tmpHome, "quartermaster", "t3", "doomed");
ok("setup failure fails the spawn with git's and the command's output", failure.includes("provisioning failed") && failure.includes("boom"));
ok("no orphan directory, registration or branch", !fs.existsSync(doomedDir) && !sh(repo, "worktree", "list").includes("doomed") && sh(repo, "branch", "--list", "quartermaster/t3/doomed") === "");
const f3b = fleetFor(repo, config({ copy: ["missing.env"] }));
f3b.teamId = "t3b";
failure = "";
try { await spawn(f3b, agent("nocopy", ["edit"])); } catch (e) { failure = String(e); }
ok("a declared file that is missing fails the spawn and cleans up", failure.includes("does not exist") && !fs.existsSync(path.join(tmpHome, "quartermaster", "t3b", "nocopy")));
const f3c = fleetFor(repo, config({ setup: ["sleep 30"], setupTimeoutMs: 1000 }));
f3c.teamId = "t3c";
failure = "";
const started = Date.now();
try { await spawn(f3c, agent("slow", ["edit"])); } catch (e) { failure = String(e); }
ok("a hung setup times out and is cleaned up", failure.includes("timed out") && Date.now() - started < 10000 && !fs.existsSync(path.join(tmpHome, "quartermaster", "t3c", "slow")));

// 9. Dissolve destroys trees unless keepOnDissolve; the user's tree is never touched.
await f2.dissolve();
ok("dissolve removes unneeded trees... (dirty ones kept)", fs.existsSync(pb.placement.path) === (sh(pb.placement.path, "status", "--porcelain") !== ""));
const f4 = fleetFor(repo, config());
f4.teamId = "t4";
const clean = await spawn(f4, agent("clean", ["edit"]));
await f4.dissolve();
ok("dissolve removes a clean tree and its empty branch", !fs.existsSync(clean.placement.path) && sh(repo, "branch", "--list", "quartermaster/t4/clean") === "");
const f5 = fleetFor(repo, config({ keepOnDissolve: true }));
f5.teamId = "t5";
const kept = await spawn(f5, agent("kept", ["edit"]));
const dissolved = await f5.dissolve();
ok("keepOnDissolve keeps the tree and says so", fs.existsSync(kept.placement.path) && JSON.stringify(dissolved.warnings).includes("keepOnDissolve"));
await worktreesReport(manager, new Set(), { prune: true, all: true, discardDirty: true });
ok("the janitor clears everything left behind", !sh(repo, "worktree", "list", "--porcelain").includes("quartermaster/") );
ok("the user's tree is exactly as it was throughout", primaryStatus() === baselineStatus && sh(repo, "rev-parse", "HEAD") === primaryHead && sh(repo, "rev-parse", "--abbrev-ref", "HEAD") === "main");

// 10. Repo-adjacent location keeps .quartermaster out of git status.
const repo2 = makeRepo("repo2");
const f6 = fleetFor(repo2, config({ location: "repo" }));
f6.teamId = "t6";
const inRepo = await spawn(f6, agent("local", ["edit"]));
ok("location: repo puts the tree under .quartermaster/worktrees", inRepo.placement.path === path.join(repo2, ".quartermaster", "worktrees", "t6", "local"));
ok("and the user's git status does not show it", sh(repo2, "status", "--porcelain") === "");
await f6.dissolve();

// 11. Non-git project: shared, with a loud warning; nothing pretends to be isolated.
const plain = path.join(root, "plain");
fs.mkdirSync(plain);
const f7 = fleetFor(plain, config());
f7.teamId = "t7";
const warnings: string[] = [];
const shared = await spawn(f7, agent("builder", ["edit"]), {}, warnings);
ok("non-git: the member is shared, not isolated", shared.placement === undefined);
ok("non-git: a loud warning says so", warnings.some((w) => w.includes("SHARED") && w.includes("not inside a git repository")));
ok("non-git: the janitor reports gracefully", (await worktreesReport(new WorktreeManager(plain, config()), new Set(), {})).message.includes("No quartermaster worktrees"));

// 12. Subdirectory sessions keep their relative cwd inside the tree.
fs.mkdirSync(path.join(repo, "sub"));
fs.writeFileSync(path.join(repo, "sub", "f.txt"), "f\n");
sh(repo, "add", "."); sh(repo, "commit", "-q", "-m", "sub");
const f8 = fleetFor(path.join(repo, "sub"), config());
f8.teamId = "t8";
const subm = await spawn(f8, agent("subber", ["edit"]));
ok("a session started in a subdirectory lands in the same subdirectory of its tree", subm.placement.cwd === path.join(subm.placement.path, "sub") && fs.existsSync(path.join(subm.placement.cwd, "f.txt")));
await f8.dissolve();

for (const [label, pass] of checks) console.log(`  ${label}: ${pass ? "ok" : "WRONG"}`);
fs.rmSync(root, { recursive: true, force: true });
if (checks.some(([, pass]) => !pass)) process.exit(1);
