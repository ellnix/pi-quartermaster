/**
 * authority.jsonc: the bounds of the quartermaster's delegated
 * authority. A quartermaster approving in the user's name is a privilege
 * delegation, and a persuadable orchestrator is a privilege-escalation
 * path — so which tool categories it may approve alone, and which it
 * must always escalate to the user, are user-authored policy, not vibes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { teamDir } from "./paths.ts";
import type { DiscoveryWarning } from "./agents.ts";

export interface AuthorityConfig {
	/** Tool name patterns the quartermaster may approve without the user. */
	autoApprove: string[];
	/** Tool name patterns that always require the user's confirmation. */
	escalate: string[];
}

const DEFAULT_AUTHORITY: AuthorityConfig = {
	// Read-only work never needs a human.
	autoApprove: ["read", "grep", "find", "ls", "bash:git *", "bash:composer test*", "bash:npm test*"],
	// Destructive and exfiltrating surfaces always do.
	escalate: ["bash:rm *", "bash:git push*", "write", "edit"],
};

export function loadAuthority(warnings: DiscoveryWarning[]): AuthorityConfig {
	const filePath = path.join(teamDir(), "authority.jsonc");
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch {
		return DEFAULT_AUTHORITY; // absent: documented defaults
	}

	let parsed: unknown;
	try {
		parsed = parseJsonc(raw);
	} catch (err) {
		warnings.push({ file: filePath, message: `invalid JSONC, using defaults: ${String(err)}` });
		return DEFAULT_AUTHORITY;
	}

	if (typeof parsed !== "object" || parsed === null) {
		warnings.push({ file: filePath, message: "expected an object with autoApprove and escalate — using defaults" });
		return DEFAULT_AUTHORITY;
	}

	const obj = parsed as Record<string, unknown>;
	const autoApprove = patternsOf(obj.autoApprove);
	const escalate = patternsOf(obj.escalate);
	if (!autoApprove || !escalate) {
		warnings.push({
			file: filePath,
			message: "autoApprove and escalate must be string arrays — using defaults",
		});
		return DEFAULT_AUTHORITY;
	}
	return { autoApprove, escalate };
}

function patternsOf(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	const patterns = value.filter((p): p is string => typeof p === "string" && p.length > 0);
	return patterns.length > 0 ? patterns : null;
}

/**
 * Classify a permission ask against the authority config.
 * Escalate wins over auto-approve when both match.
 */
export function classifyAsk(tool: string, args: string, authority: AuthorityConfig): "auto" | "escalate" {
	const subject = tool === "bash" ? `bash:${args.trim().split(/\s+/).slice(0, 2).join(" ")} ` : `${tool} `;
	for (const pattern of authority.escalate) {
		if (matchPattern(pattern, tool, subject)) return "escalate";
	}
	for (const pattern of authority.autoApprove) {
		if (matchPattern(pattern, tool, subject)) return "auto";
	}
	// Unknown tools default to escalate: the quartermaster may still
	// approve them itself after looking, but the policy never pre-blesses
	// what the user has not classified.
	return "escalate";
}

function matchPattern(pattern: string, tool: string, subject: string): boolean {
	// "bash:git *" matches bash calls whose leading words start "git";
	// a bare "read" matches any call of the read tool.
	if (pattern.includes("*")) {
		const prefix = pattern.slice(0, pattern.indexOf("*"));
		return subject.startsWith(prefix);
	}
	return tool === pattern;
}
