/**
 * Crewman tools: the tools a child session gets, passed as customTools at
 * session creation. Children never load the quartermaster surface — the
 * guard in quartermaster.ts keeps it out — so these are their only
 * channels: report to the quartermaster, ask through mailboxes (PR #5),
 * and request permission (PR #6).
 *
 * Every tool closes over the team record path, so traffic lands in files
 * the quartermaster can inspect on demand: visible, not in-context.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendReport } from "./record.ts";

export interface ReportEntry {
	/** Tracking number, sequential per team record: r1, r2, ... The
	 *  quartermaster cites it in ratings and messages; the crewman sees
	 *  it echoed back and can be steered by reference. */
	id: string;
	ts: number;
	member: string;
	status: "complete" | "partial" | "blocked";
	summary: string;
	confidence?: number;
}

export function crewmanTools(memberName: string, recordPath: string): ToolDefinition[] {
	return [
		{
			name: "report",
			label: "Report to quartermaster",
			description:
				"Report your progress or result to the Quartermaster - the session that " +
				"convened you and speaks with the user. Use at meaningful milestones and " +
				"when your task completes. The quartermaster reads reports on demand; be " +
				"complete and specific, because this may be all it sees of your work.",
			promptSnippet: "Report results to the Quartermaster with report.",
			parameters: Type.Object({
				status: Type.Union([Type.Literal("complete"), Type.Literal("partial"), Type.Literal("blocked")], {
					description: "complete: task finished; partial: milestone reached; blocked: cannot proceed.",
				}),
				summary: Type.String({ description: "What you did, found, or produced — complete and specific." }),
				confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Confidence in the result." })),
			}),
			// Explicit param typing: the TypeBox generic does not infer through
			// the plain ToolDefinition return type.
			async execute(
				_toolCallId: string,
				params: { status: "complete" | "partial" | "blocked"; summary: string; confidence?: number },
			) {
				const entry = appendReport(recordPath, {
					ts: Date.now(),
					member: memberName,
					status: params.status,
					summary: params.summary,
					confidence: params.confidence,
				});
				return {
					content: [
						{
							type: "text",
							text: `Reported ${params.status} as ${entry.id}: the Quartermaster will see it on its next read. It can reference ${entry.id} when rating or steering you.`,
						},
					],
					details: entry as unknown as Record<string, unknown>,
				};
			},
		},
	];
}
