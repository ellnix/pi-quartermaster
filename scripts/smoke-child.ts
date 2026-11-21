/**
 * SDK semantics check: does a tools allowlist disable customTools?
 * CreateAgentSessionOptions.tools says "when provided, only matching
 * tools are enabled" — if that includes custom tools, the crewman tools
 * must be named in the allowlist too.
 */

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const marker = process.env.QM_CHILD;
process.env.QM_CHILD = "1";
try {
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		tools: ["read", "ls", "find", "grep", "report"],
		customTools: [
			{
				name: "report",
				label: "Report",
				description: "Report to the quartermaster.",
				parameters: Type.Object({
					summary: Type.String(),
				}),
				async execute(_id: string, params: { summary: string }) {
					return { content: [{ type: "text", text: `reported: ${params.summary}` }], details: {} };
				},
			},
		],
		sessionManager: (await import("@earendil-works/pi-coding-agent")).SessionManager.inMemory(),
	});
	console.log("callable:", session.getCallableToolNames().join(", "));
	console.log("report definition present:", session.getToolDefinition("report") !== undefined);
	session.dispose();
} finally {
	if (marker === undefined) delete process.env.QM_CHILD;
	else process.env.QM_CHILD = marker;
}
