#!/usr/bin/env node
/**
 * refresh-scores.cjs — print suggested models.yaml priors from public data.
 *
 * Pulls OpenRouter's unauthenticated model catalog (pricing, input
 * modalities, context length) and prints a commented models.yaml block.
 * It NEVER writes models.yaml: priors are the user's to accept, edit, or
 * ignore. Cost scores are log-normalized across the fetched set
 * (1 = cheapest), which is exactly the default the matcher falls back to
 * when the user provides nothing — this script exists to make writing
 * your own costs easy, not to replace them.
 *
 * Usage:
 *   node scripts/refresh-scores.cjs [provider-prefix ...]
 *
 * Examples:
 *   node scripts/refresh-scores.cjs anthropic openai google
 *
 * Offline or unreachable: prints the failure and exits non-zero, so an
 * agent can report it instead of silently skipping.
 */

const ENDPOINT = "https://openrouter.ai/api/v1/models";

async function main() {
	const prefixes = process.argv.slice(2).map((a) => a.toLowerCase());

	let response;
	try {
		response = await fetch(ENDPOINT, { signal: AbortSignal.timeout(15000) });
	} catch (err) {
		console.error(`refresh-scores: could not reach ${ENDPOINT}: ${err.message}`);
		console.error("Offline is fine — cost scores default to catalog-derived values at draw time.");
		process.exit(1);
	}
	if (!response.ok) {
		console.error(`refresh-scores: ${ENDPOINT} answered ${response.status}`);
		process.exit(1);
	}

	const catalog = (await response.json()).data ?? [];
	const models = catalog
		.filter((m) => m.id && m.pricing && Number(m.pricing.prompt) >= 0)
		.filter((m) => prefixes.length === 0 || prefixes.some((p) => m.id.toLowerCase().startsWith(p + "/")))
		.map((m) => ({
			id: m.id,
			promptPerMtok: Number(m.pricing.prompt) * 1e6,
			contextLength: m.context_length ?? 0,
			modalities: (m.architecture?.input_modalities ?? ["text"]).join("+"),
		}))
		// Free models break log-normalization; keep them, they sort first anyway.
		.sort((a, b) => a.promptPerMtok - b.promptPerMtok);

	if (models.length === 0) {
		console.error("refresh-scores: no models matched the given prefixes.");
		process.exit(1);
	}

	const positive = models.filter((m) => m.promptPerMtok > 0).map((m) => m.promptPerMtok);
	const logMin = positive.length ? Math.log(Math.min(...positive)) : 0;
	const logMax = positive.length ? Math.log(Math.max(...positive)) : 0;

	const lines = [
		"# Suggested models.yaml priors — from OpenRouter's public catalog,",
		`# fetched ${new Date().toISOString().slice(0, 10)}. Cost is 0-1 (1 = cheapest),`,
		"# log-normalized across this fetch; adjust to your actual account,",
		"# because promotions and plans are yours, not the catalog's.",
		"# Scores are omitted on purpose: they are priors you should judge.",
		"# Provider prefixes are OpenRouter's — adjust them to your pi setup.",
	];

	for (const m of models) {
		const cost =
			m.promptPerMtok <= 0 || logMax <= logMin
				? 1
				: Math.round((1 - (Math.log(m.promptPerMtok) - logMin) / (logMax - logMin)) * 1000) / 1000;
		lines.push("");
		lines.push(`${m.id}:`);
		lines.push(`  cost: ${cost}  # $${m.promptPerMtok.toFixed(2)}/Mtok input, context ${m.contextLength}, input ${m.modalities}`);
	}

	console.log(lines.join("\n"));
}

main();
