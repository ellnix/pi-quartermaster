/**
 * Frontmatter for agent and mailbox markdown: a `---` fence at the very
 * first line, a YAML block inside it, the body after the closing fence.
 * The YAML block is parsed by js-yaml — the same dependency models.yaml
 * uses — so frontmatter may use any YAML form: nested objects (an agent's
 * inline spec), flow lists, quoted strings.
 *
 * Parse failures report their reason: an agent fixing a broken
 * configuration needs the parser's actual error, not "no frontmatter".
 */

import yaml from "js-yaml";

export type FrontmatterResult =
	| { ok: true; frontmatter: Record<string, unknown>; body: string }
	| { ok: false; reason: string };

export function parseFrontmatter(content: string): FrontmatterResult {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") {
		return { ok: false, reason: "no frontmatter, or it does not start at line 1" };
	}

	const end = lines.indexOf("---", 1);
	if (end === -1) {
		return { ok: false, reason: "no closing fence" };
	}

	let parsed: unknown;
	try {
		parsed = yaml.load(lines.slice(1, end).join("\n"));
	} catch (err) {
		return { ok: false, reason: `invalid YAML: ${err instanceof Error ? err.message : String(err)}` };
	}
	if (typeof parsed === "undefined") parsed = {};
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { ok: false, reason: "frontmatter block is not a YAML object" };
	}

	const body = lines.slice(end + 1).join("\n").trim();
	return { ok: true, frontmatter: parsed as Record<string, unknown>, body };
}

/** Normalize a tools/tags value to a list; CSV strings stay accepted. */
export function toList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const items = value.map((item) => String(item).trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	if (typeof value === "string") {
		const items = value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	return undefined;
}
