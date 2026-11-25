/**
 * composeEngine: build a QuartermasterEngine from whatever operations
 * exist so far, falling back to informative not-configured behavior for
 * the rest. This is how the implementation lands in slices — each PR
 * contributes its operations, the surface never changes shape.
 *
 * `wakeSource` defaults to null (nobody to wake) rather than delegating to
 * the fallback: it is an observation about live state, not an operation.
 */

import { NotConfiguredEngine, type QuartermasterEngine } from "./engine.ts";

export function composeEngine(parts: Partial<QuartermasterEngine>): QuartermasterEngine {
	const fallback = new NotConfiguredEngine();
	return {
		convene: parts.convene ?? ((input) => fallback.convene(input)),
		status: parts.status ?? (() => fallback.status()),
		readChannel: parts.readChannel ?? ((input) => fallback.readChannel(input)),
		rate: parts.rate ?? ((input) => fallback.rate(input)),
		message: parts.message ?? ((input) => fallback.message(input)),
		setCost: parts.setCost ?? ((input) => fallback.setCost(input)),
		setOverride: parts.setOverride ?? ((input) => fallback.setOverride(input)),
		pendingAsks: parts.pendingAsks ?? (() => fallback.pendingAsks()),
		resolveAsk: parts.resolveAsk ?? ((input) => fallback.resolveAsk(input)),
		dissolve: parts.dissolve ?? (() => fallback.dissolve()),
		addMember: parts.addMember ?? ((input) => fallback.addMember(input)),
		removeMember: parts.removeMember ?? ((input) => fallback.removeMember(input)),
		openMailbox: parts.openMailbox ?? ((input) => fallback.openMailbox(input)),
		closeMailbox: parts.closeMailbox ?? ((input) => fallback.closeMailbox(input)),
		wakeSource: parts.wakeSource ?? (() => null),
	};
}
