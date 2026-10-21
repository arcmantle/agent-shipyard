import packageJson from "../../package.json" with { type: "json" };

declare const __AGENT_ISSUES_INSTRUCTION_VERSION__: string | undefined;

export function getInstructionVersion(): string {
	return typeof __AGENT_ISSUES_INSTRUCTION_VERSION__ === "undefined"
		? packageJson.version
		: __AGENT_ISSUES_INSTRUCTION_VERSION__;
}