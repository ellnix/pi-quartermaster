/**
 * Mailbox definition discovery. Each mailbox is unidirectional; the
 * reverse direction is a wholly separate file because the relationships
 * are unrelated — the builder asks, the reviewer dictates. Nothing
 * enforces pairing: the quartermaster sanctions channels by judgment
 * from the descriptions.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { projectMailboxesDir, userMailboxesDir } from "./paths.ts";
import type { DiscoveryWarning } from "./agents.ts";

export interface MailboxDef {
	name: string;
	description: string;
	/**
	 * Constitutional preamble prefixed to every message on this channel.
	 * A template carries no endpoints - the convene wiring is the single
	 * authority for who talks to whom - and may reference ${from} and
	 * ${to}, which the engine substitutes with the wired endpoints at
	 * delivery. A preamble without placeholders is used verbatim and
	 * should be written generically.
	 */
	preamble: string;
	source: "user" | "project";
	filePath: string;
}

export function loadMailboxes(cwd: string, warnings: DiscoveryWarning[]): Map<string, MailboxDef> {
	const mailboxes = new Map<string, MailboxDef>();
	collect(userMailboxesDir(), "user", mailboxes, warnings);
	const project = projectMailboxesDir(cwd);
	if (project) collect(project, "project", mailboxes, warnings);
	return mailboxes;
}

function collect(
	dir: string,
	source: "user" | "project",
	mailboxes: Map<string, MailboxDef>,
	warnings: DiscoveryWarning[],
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		const filePath = path.join(dir, entry.name);
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf8");
		} catch (err) {
			warnings.push({ file: filePath, message: `unreadable: ${String(err)}` });
			continue;
		}

		const parsed = parseFrontmatter(content);
		if (!parsed) {
			warnings.push({ file: filePath, message: "no frontmatter at line 1 — skipped" });
			continue;
		}

		const name = str(parsed.frontmatter.name);
		const description = str(parsed.frontmatter.description);
		if (!name || !description) {
			warnings.push({
				file: filePath,
				message: `missing required frontmatter field (needs name, description) — skipped`,
			});
			continue;
		}
		if (str(parsed.frontmatter.from) || str(parsed.frontmatter.to)) {
			warnings.push({
				file: filePath,
				message: "from/to in a mailbox definition are ignored — the convene wiring is the authority for endpoints; delete the fields",
			});
		}

		if (mailboxes.has(name)) {
			const existing = mailboxes.get(name)!;
			if (existing.source === source) {
				warnings.push({
					file: filePath,
					message: `duplicate mailbox name "${name}" (first definition: ${existing.filePath}) — skipped`,
				});
				continue;
			}
		}

		mailboxes.set(name, {
			name,
			description,
			preamble: parsed.body,
			source,
			filePath,
		});
	}
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}
