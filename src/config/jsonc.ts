/**
 * A small JSONC reader: strips line comments, block comments, and
 * trailing commas, then hands the result to JSON.parse. Used for
 * specs.jsonc and authority.jsonc. Written by hand rather than pulling
 * a dependency: the inputs are flat config files, and a parser this
 * size is easy to review.
*/

export function parseJsonc(text: string): unknown {
	return JSON.parse(stripJsonc(text));
}

export function stripJsonc(text: string): string {
	let out = "";
	let i = 0;
	let inString = false;
	let stringChar = "";

	while (i < text.length) {
		const ch = text[i];
		const next = text[i + 1];

		if (inString) {
			out += ch;
			if (ch === "\\") {
				if (next !== undefined) {
					out += next;
					i += 2;
					continue;
				}
			} else if (ch === stringChar) {
				inString = false;
			}
			i += 1;
			continue;
		}

		if (ch === '"' || ch === "'") {
			inString = true;
			stringChar = ch;
			out += ch;
			i += 1;
			continue;
		}

		if (ch === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			continue;
		}

		if (ch === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i += 2;
			continue;
		}

		out += ch;
		i += 1;
	}

	return stripTrailingCommas(out);
}

function stripTrailingCommas(text: string): string {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j += 1;
			if (text[j] === "}" || text[j] === "]") continue; // drop the comma
		}
		out += ch;
	}
	return out;
}
