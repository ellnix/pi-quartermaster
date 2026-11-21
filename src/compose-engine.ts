/**
 * composeEngine: build a QuartermasterEngine from whatever operations
 * exist so far, falling back to informative not-configured behavior for
 * the rest. This is how the implementation lands in slices — each PR
 * contributes its operations, the surface never changes shape.
 */

import { NotConfiguredEngine, type QuartermasterEngine } from "./engine.ts";

export function composeEngine(parts: Partial<QuartermasterEngine>): QuartermasterEngine {
	const fallback = new NotConfiguredEngine();
	return {
		convene: parts.convene ?? ((input) => fallback.convene(input)),
		status: parts.status ?? (() => fallback.status()),
		readChannel: parts.readChannel ?? ((input) => fallback.readChannel(input)),
		rate: parts.rate ?? ((input) => fallback.rate(input)),
		setCost: parts.setCost ?? ((input) => fallback.setCost(input)),
		setOverride: parts.setOverride ?? ((input) => fallback.setOverride(input)),
		pendingAsks: parts.pendingAsks ?? (() => fallback.pendingAsks()),
		resolveAsk: parts.resolveAsk ?? ((input) => fallback.resolveAsk(input)),
		dissolve: parts.dissolve ?? (() => fallback.dissolve()),
	};
}
