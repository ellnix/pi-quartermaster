/**
 * Crewman tools: the tools a child session gets, passed as customTools
 * at session creation. Children never load the quartermaster surface —
 * the guard in quartermaster.ts keeps it out — so these are their only
 * channels: report to the quartermaster, ask through mailboxes.
 * (request_permission arrives with the permissions module.)
 *
 * Every tool closes over the team record path, so traffic lands in files
 * the quartermaster can inspect on demand: visible, not in-context.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { appendChannel, appendReport } from "./record.ts";

export interface CrewHooks {
	/**
	 * Validate and route a mailbox send. A string refusal is returned to the
	 * sender verbatim; a receipt confirms the send and its tracking number.
	 */
	onSend: (mailbox: string, body: string) => string | SendReceipt;
	/**
	 * Register a permission ask and await its resolution. Resolves to a
	 * verdict; a rejected promise is a failed ask, not a denial.
	 */
	onAsk: (tool: string, args: string, why: string) => Promise<{ approve: boolean; note: string }>;
}

export interface ReportEntry {
	/**
	 * Tracking number, sequential per team record: r1, r2, ... The
	 * quartermaster cites it in ratings and messages; the crewman sees
	 * it echoed back and can be steered by reference.
	 */
	id: string;
	ts: number;
	member: string;
	status: "complete" | "partial" | "blocked";
	summary: string;
	confidence?: number;
}

export interface SendReceipt {
	/** The message's tracking number. */
	id: string;
}

export interface CrewHooks {
	/**
	 * Validate and route a mailbox send. A string refusal is returned to the
	 * sender verbatim; a receipt confirms the send and its tracking number.
	 */
	onSend: (mailbox: string, body: string) => string | SendReceipt;
}

export function crewmanTools(memberName: string, recordPath: string, hooks: CrewHooks): ToolDefinition[] {
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
		{
			name: "request_permission",
			label: "Request permission",
			description:
				"Ask the Quartermaster's approval before a sensitive action. The Quartermaster " +
				"decides by policy: read-only and test commands it may approve itself; destructive " +
				"or credential-touching actions always require the user. Approval records consent " +
				"- it does not add tools to your session. If the tool itself is not granted to you, " +
				"say so in your report and the Quartermaster may run it on your behalf. " +
				"You wait here until it resolves - do not attempt the action before it answers.",
			promptSnippet: "Ask the Quartermaster before any action outside your granted tools.",
			parameters: Type.Object({
				tool: Type.String({ description: 'The tool you need, e.g. "bash".' }),
				args: Type.String({ description: "The exact arguments you would run." }),
				why: Type.String({ description: "Why this task needs it." }),
			}),
			async execute(
				_toolCallId: string,
				params: { tool: string; args: string; why: string },
				signal: AbortSignal | undefined,
			) {
				const verdict = await withTimeout(
					hooks.onAsk(params.tool, params.args, params.why),
					10 * 60 * 1000,
					{ approve: false, note: "the ask timed out unresolved — treat as denied" },
					signal,
				);
				return {
					content: [{ type: "text", text: verdict.approve ? `Approved: ${verdict.note}` : `Denied: ${verdict.note}` }],
					isError: !verdict.approve,
					details: { tool: params.tool, args: params.args },
				};
			},
		},
		{
			name: "send",
			label: "Send via mailbox",
			description:
				"Send a message to another member through one of your open mailboxes. The " +
				"engine frames and logs the delivery, and the Quartermaster sees all traffic. " +
				"A tracking number is echoed back to you and can be cited when the " +
				"Quartermaster steers you. Your task lists your channels by name and " +
				"recipient; anything beyond that about a channel is not your concern.",
			promptSnippet: "Send messages to other members through your open mailboxes with send.",
			parameters: Type.Object({
				mailbox: Type.String({ description: "The mailbox name from your task's channels list." }),
				body: Type.String({ description: "The message body." }),
			}),
			async execute(
				_toolCallId: string,
				params: { mailbox: string; body: string },
			) {
				const { onSend } = hooks;
				const result = onSend(params.mailbox, params.body);
				if (typeof result === "string") {
					return {
						content: [{ type: "text", text: result }],
						isError: true,
						details: {},
					};
				}
				return {
					content: [
						{
							type: "text",
							text: `Sent via ${params.mailbox} as ${result.id}: the recipient sees it when idle; the Quartermaster sees it always. ${result.id} can be cited to reference this message.`,
						},
					],
					details: { mailbox: params.mailbox, id: result.id },
				};
			},
		},
	];
}

/** Race a promise against a timeout, honoring an abort signal. */
async function withTimeout(
	promise: Promise<{ approve: boolean; note: string }>,
	ms: number,
	fallback: { approve: boolean; note: string },
	signal?: AbortSignal,
): Promise<{ approve: boolean; note: string }> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(fallback), ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve({ approve: false, note: "aborted" });
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(err: unknown) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				resolve({ approve: false, note: `ask failed: ${String(err)}` });
			},
		);
	});
}
