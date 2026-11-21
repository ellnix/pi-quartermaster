/**
 * Minimal frontmatter parsing for agent and mailbox markdown.
 *
 * The format is deliberately small: a `---` fence at the very first line,
 * `key: value` lines inside it, lists as `[a, b]` or `- item` lines, and
 * everything after the closing fence is the body. Full YAML lives only
 * in models.yaml, which is parsed by js-yaml.
 */

export interface ParsedFrontmatter {
	frontmatter: Record<string, string | string[]>;
	body: string;
}

export function parseFrontmatter(content: string): ParsedFrontmatter | null {
	const lines = content.split(/\r?\n/);
	if (lines[0]?.trim() !== "---") return null;

	let index = 1;
	const raw: Array<{ key: string; value: string }> = [];
	while (index < lines.length && lines[index].trim() !== "---") {
		const line = lines[index];
		const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
		if (match) {
			raw.push({ key: match[1], value: match[2] });
		} else if (line.startsWith("  ") && raw.length > 0) {
			// Continuation of the previous key's value.
			raw[raw.length - 1].value += ` ${line.trim()}`;
		}
		index += 1;
	}
	if (index >= lines.length) return null; // no closing fence

	const frontmatter: Record<string, string | string[]> = {};
	for (const { key, value } of raw) {
		const trimmed = value.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			frontmatter[key] = splitList(trimmed.slice(1, -1));
		} else if (trimmed === "") {
			frontmatter[key] = "";
		} else {
			frontmatter[key] = unquote(trimmed);
		}
	}

	const body = lines.slice(index + 1).join("\n").trim();
	return { frontmatter, body };
}

function splitList(raw: string): string[] {
	return raw
		.split(",")
		.map((item) => unquote(item.trim()))
		.filter((item) => item.length > 0);
}

function unquote(value: string): string {
	if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
		return value.slice(1, -1);
	}
	return value;
}

/** Normalize a frontmatter value to a list of tool names / tags. */
export function toList(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) {
		const items = value.map((item) => String(item).trim()).filter(Boolean);
		return items.length > 0 ? items : undefined;
	}
	const items = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return items.length > 0 ? items : undefined;
}
