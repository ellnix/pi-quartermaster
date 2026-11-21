/**
 * Frontmatter for agent and mailbox markdown: a `---` fence at the very
 * first line, a YAML block inside it, the body after the closing fence.
 * The YAML block is parsed by js-yaml — the same dependency models.yaml
 * uses — so frontmatter may use any YAML form: nested objects (an agent's
 * inline spec), flow lists, quoted strings.
 */

import yaml from "js-yaml";

export interface ParsedFrontmatter {
	frontmatter: Record<string, unknown>;
	body: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter | null {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;

	const end = lines.indexOf("---", 1);
	if (end === -1) return null; // no closing fence

	let parsed: unknown;
	try {
		parsed = yaml.load(lines.slice(1, end).join("\n"));
	} catch {
		return null; // malformed YAML: the discovery layer reports and skips
	}
	if (typeof parsed === "undefined") parsed = {};
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return null;
	}

	const body = lines.slice(end + 1).join("\n").trim();
	return { frontmatter: parsed as Record<string, unknown>, body };
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
