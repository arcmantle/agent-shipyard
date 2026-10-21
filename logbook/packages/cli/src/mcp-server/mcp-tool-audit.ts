type McpDataCommand = {
	command: string;
	toolNames: readonly string[];
};

const INCLUDED_MCP_DATA_COMMANDS: readonly McpDataCommand[] = [
	{ command: "instruction retrieve", toolNames: ["instruction_retrieve"] },
	{ command: "instruction preview", toolNames: ["instruction_inspect"] },
	{ command: "instruction list", toolNames: ["resource_list"] },
	{ command: "instruction read", toolNames: ["resource_show", "resource_body"] },
	{ command: "instruction compare", toolNames: ["instruction_inspect"] },
	{ command: "instruction dependencies", toolNames: ["instruction_inspect"] },
	{ command: "instruction save", toolNames: ["instruction_update"] },
	{ command: "instruction history", toolNames: ["resource_history"] },
	{ command: "instruction revision", toolNames: ["resource_history", "resource_body"] },
	{ command: "instruction restore", toolNames: ["instruction_update"] },
	{ command: "instruction reset-inspect", toolNames: ["instruction_reset"] },
	{ command: "instruction reset", toolNames: ["instruction_reset"] },
	{ command: "instruction reset-all-inspect", toolNames: ["instruction_reset"] },
	{ command: "instruction reset-all", toolNames: ["instruction_reset"] },
	{ command: "instruction commit", toolNames: ["instruction_update"] },
	{ command: "instruction fragment create", toolNames: ["instruction_update"] },
	{ command: "instruction fragment remove", toolNames: ["instruction_update"] },
	{ command: "project-identity", toolNames: ["project_identity"] },
	{ command: "create", toolNames: ["resource_create"] },
	{ command: "edit", toolNames: ["resource_edit"] },
	{ command: "archive", toolNames: ["entity_archive"] },
	{ command: "delete", toolNames: ["resource_delete"] },
	{ command: "move", toolNames: ["entity_move"] },
	{ command: "status", toolNames: ["entity_status"] },
	{ command: "list", toolNames: ["resource_list"] },
	{ command: "history", toolNames: ["resource_history", "resource_body"] },
	{ command: "show", toolNames: ["resource_show", "resource_body", "initiative_bundle"] },
	{ command: "context list", toolNames: ["resource_list"] },
	{ command: "context show", toolNames: ["resource_show", "resource_body"] },
	{ command: "context directory", toolNames: ["resource_list"] },
	{ command: "context search", toolNames: ["context_search"] },
	{ command: "context conflicts", toolNames: ["context_conflicts"] },
	{ command: "context set", toolNames: ["resource_create"] },
	{ command: "context define", toolNames: ["context_term_define"] },
	{ command: "context forget", toolNames: ["resource_delete"] },
	{ command: "history --context", toolNames: ["resource_history", "resource_body"] },
	{ command: "comment add", toolNames: ["resource_create"] },
	{ command: "comment edit", toolNames: ["resource_edit"] },
	{ command: "comment delete", toolNames: ["resource_delete"] },
	{ command: "comment list", toolNames: ["resource_list", "resource_body"] },
	{ command: "comment history", toolNames: ["resource_history", "resource_body"] },
	{ command: "plan-entry add", toolNames: ["resource_create"] },
	{ command: "plan-entry edit", toolNames: ["resource_edit"] },
	{ command: "plan-entry delete", toolNames: ["resource_delete"] },
	{ command: "plan-entry list", toolNames: ["resource_list", "resource_body", "resource_show"] },
	{ command: "plan-entry history", toolNames: ["resource_history", "resource_body", "resource_show"] },
	{ command: "link", toolNames: ["relation_link", "plan_entry_entity_link"] },
	{ command: "unlink", toolNames: ["relation_unlink", "plan_entry_entity_unlink"] },
	{ command: "relations", toolNames: ["relation_query"] },
	{ command: "next-work", toolNames: ["entity_next_work"] },
	{ command: "orphans", toolNames: ["resource_list"] },
	{ command: "tenant list", toolNames: ["resource_list"] },
	{ command: "tenant rename", toolNames: ["tenant_rename"] },
	{ command: "tenant delete", toolNames: ["resource_delete"] },
	{ command: "restore", toolNames: ["entity_restore_inspect", "entity_restore"] },
	{ command: "backfill-bodies", toolNames: ["body_backfill_inspect", "body_backfill"] },
	{ command: "issue-breakdown create", toolNames: ["issue_breakdown_create"] },
	{ command: "issue-breakdown show", toolNames: ["resource_show"] },
	{ command: "issue-breakdown latest", toolNames: ["resource_show"] },
	{ command: "issue-breakdown approve", toolNames: ["issue_breakdown_approve"] },
	{ command: "plan confirm", toolNames: ["plan_confirm"] }
];

const MCP_APP_TOOLS = ["plan_preview", "issue_breakdown_preview"] as const;

export function auditMcpToolRegistrations(registeredToolNames: Iterable<string>): { missing: Array<{ command: string; toolName: string }> } {
	const registeredTools = new Set(registeredToolNames);
	const missing = [
		...INCLUDED_MCP_DATA_COMMANDS,
		{ command: "Plan Preview", toolNames: MCP_APP_TOOLS }
	].flatMap(({ command, toolNames }) =>
		toolNames.filter((toolName) => !registeredTools.has(toolName)).map((toolName) => ({ command, toolName }))
	);

	return { missing };
}