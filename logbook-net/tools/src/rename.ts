// The approved product rename and the inputs that it must not touch.
// One mechanical rule for each case form. The only exceptions are the retained inputs below.

export const CASE_FORMS: readonly (readonly [string, string])[] = [
	["agent-issues", "agent-logbook"],
	["agentIssues", "agentLogbook"],
	["AGENT_ISSUES", "AGENT_LOGBOOK"],
	["agent_issues", "agent_logbook"],
	["AgentIssues", "AgentLogbook"],
	["Agent Issues", "Agent Logbook"]
];

/**
 * Old names that the .NET tool still reads or derives from. They are data-format values and supported inputs, not visible product names.
 * Order matters for masking: a longer name comes before a name that it contains.
 */
export const RETAINED_INPUTS: readonly string[] = [
	"agent-issues/entity-stable-id/v1",
	"agent-issues/context-stable-id/v1",
	"agent-issues/context-term-id/v1",
	"agent-issues/user-stable-id/v1",
	".agent-issues.json",
	".agent-issues",
	"AGENT_ISSUES_PROJECT_IDENTITY"
];

/** Applies the rename to a text. Retained inputs stay as they are. */
export function renameVisible(text: string): string {
	const masks = RETAINED_INPUTS.map((input, index) => [input, `\u0000${index}\u0000`] as const);
	let result = text;
	for (const [input, mask] of masks) result = result.split(input).join(mask);
	for (const [from, to] of CASE_FORMS) result = result.split(from).join(to);
	for (const [input, mask] of masks) result = result.split(mask).join(input);
	return result;
}

const PREFIXES = ["", "x ", "$", "${", "`", "'", '"', "(", "[", "<", ": ", ", ", "\n", "\t", "/", "\\", "--", "--x=", "a-", "a_", "a.", "=", "@"];
const SUFFIXES = ["", " y", ".", ",", ")", "]", ">", "`", "'", '"', "=", "=x", ":", ": ", "\n", "\t", "/", "-", "_", "x", " file", ".json", "}"];

/** Texts that put a retained input in many surroundings. A text rule must leave every one of them unchanged. */
export function retainedProbes(): string[] {
	return RETAINED_INPUTS.flatMap((input) => PREFIXES.flatMap((prefix) => SUFFIXES.map((suffix) => `${prefix}${input}${suffix}`)));
}
