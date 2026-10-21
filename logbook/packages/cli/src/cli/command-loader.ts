import type { Cli } from "clipanion";

import { loadCommandFamily } from "./command-router.js";
import type { AgentIssuesContext } from "./shared.js";

export async function registerCommandFamily(cli: Cli<AgentIssuesContext>, argv: readonly string[]): Promise<void> {
	await loadCommandFamily(argv, async (family) => {
		switch (family) {
			case "auth": {
				const { AuthListCommand, AuthLoginCommand, AuthLogoutCommand, AuthStatusCommand, AuthSwitchCommand } = await import("./commands/auth.js");
				cli.register(AuthListCommand);
				cli.register(AuthLoginCommand);
				cli.register(AuthLogoutCommand);
				cli.register(AuthStatusCommand);
				cli.register(AuthSwitchCommand);
				return;
			}
			case "backfill": {
				const { BackfillBodiesCommand } = await import("./commands/backfill.js");
				cli.register(BackfillBodiesCommand);
				return;
			}
			case "comments": {
				const { AddIssueCommentCommand, DeleteIssueCommentCommand, EditIssueCommentCommand, IssueCommentCommand, IssueCommentHistoryCommand, ListIssueCommentsCommand } = await import("./commands/comments.js");
				cli.register(IssueCommentCommand);
				cli.register(AddIssueCommentCommand);
				cli.register(DeleteIssueCommentCommand);
				cli.register(EditIssueCommentCommand);
				cli.register(IssueCommentHistoryCommand);
				cli.register(ListIssueCommentsCommand);
				return;
			}
			case "context": {
				const { ContextCommand } = await import("./commands/context.js");
				cli.register(ContextCommand);
				return;
			}
			case "daemon": {
				const { DaemonCommand } = await import("./commands/daemon.js");
				cli.register(DaemonCommand);
				return;
			}
			case "entities": {
				const { ArchiveCommand, CreateCommand, DeleteCommand, EditCommand, HistoryCommand, LinkCommand, ListCommand, MoveCommand, NextWorkCommand, OrphansCommand, RelationsCommand, RestoreCommand, ShowCommand, StatusCommand, UnlinkCommand } = await import("./commands/entities.js");
				cli.register(CreateCommand);
				cli.register(EditCommand);
				cli.register(HistoryCommand);
				cli.register(RestoreCommand);
				cli.register(ArchiveCommand);
				cli.register(DeleteCommand);
				cli.register(MoveCommand);
				cli.register(LinkCommand);
				cli.register(UnlinkCommand);
				cli.register(StatusCommand);
				cli.register(NextWorkCommand);
				cli.register(RelationsCommand);
				cli.register(OrphansCommand);
				cli.register(ShowCommand);
				cli.register(ListCommand);
				return;
			}
			case "export": {
				const { ExportCommand } = await import("./commands/export.js");
				cli.register(ExportCommand);
				return;
			}
			case "fallback": {
				const { FallbackCommand } = await import("./commands/fallback.js");
				cli.register(FallbackCommand);
				return;
			}
			case "issue-breakdowns": {
				const { ApproveIssueBreakdownCommand, CreateIssueBreakdownCommand, IssueBreakdownCommand, LatestIssueBreakdownCommand, ShowIssueBreakdownCommand } = await import("./commands/issue-breakdowns.js");
				cli.register(IssueBreakdownCommand);
				cli.register(CreateIssueBreakdownCommand);
				cli.register(ShowIssueBreakdownCommand);
				cli.register(LatestIssueBreakdownCommand);
				cli.register(ApproveIssueBreakdownCommand);
				return;
			}
			case "kanban": {
				const { KanbanCommand } = await import("./commands/kanban.js");
				cli.register(KanbanCommand);
				return;
			}
			case "instructions": {
				const { CompareInstructionSourceCommand, InspectInstructionDependenciesCommand, CommitInstructionChangesCommand, CreateInstructionFragmentCommand, RemoveInstructionFragmentCommand, ListInstructionSourcesCommand, PreviewInstructionCommand, ReadInstructionSourceCommand, RetrieveInstructionCommand, SaveInstructionSourceCommand, ListInstructionHistoryCommand, ReadInstructionRevisionCommand, RestoreInstructionRevisionCommand, InspectInstructionResetCommand, ResetInstructionSourceCommand, InspectInstructionResetAllCommand, ResetInstructionAllCommand } = await import("./commands/instructions.js");
				cli.register(RetrieveInstructionCommand);
				cli.register(PreviewInstructionCommand);
				cli.register(ListInstructionSourcesCommand);
				cli.register(ReadInstructionSourceCommand);
				cli.register(CompareInstructionSourceCommand);
				cli.register(InspectInstructionDependenciesCommand);
				cli.register(SaveInstructionSourceCommand);
				cli.register(ListInstructionHistoryCommand);
				cli.register(ReadInstructionRevisionCommand);
				cli.register(RestoreInstructionRevisionCommand);
				cli.register(InspectInstructionResetCommand);
				cli.register(ResetInstructionSourceCommand);
				cli.register(InspectInstructionResetAllCommand);
				cli.register(ResetInstructionAllCommand);
				cli.register(CommitInstructionChangesCommand);
				cli.register(CreateInstructionFragmentCommand);
				cli.register(RemoveInstructionFragmentCommand);
				return;
			}
			case "meta": {
				const { CapabilitiesCommand, HelpCommand, SchemaCommand } = await import("./commands/meta.js");
				cli.register(HelpCommand);
				cli.register(SchemaCommand);
				cli.register(CapabilitiesCommand);
				return;
			}
			case "plan-entries": {
				const { AddPlanEntryCommand, DeletePlanEntryCommand, EditPlanEntryCommand, ListPlanEntriesCommand, PlanEntryHistoryCommand } = await import("./commands/plan-entries.js");
				cli.register(AddPlanEntryCommand);
				cli.register(EditPlanEntryCommand);
				cli.register(DeletePlanEntryCommand);
				cli.register(ListPlanEntriesCommand);
				cli.register(PlanEntryHistoryCommand);
				return;
			}
			case "plugin": {
				const { AgentInitCommand } = await import("./commands/plugin.js");
				cli.register(AgentInitCommand);
				return;
			}
			case "site": {
				const { SiteCommand } = await import("./commands/site.js");
				cli.register(SiteCommand);
				return;
			}
			case "sql": {
				const { SqlCommand } = await import("./commands/sql.js");
				cli.register(SqlCommand);
				return;
			}
			case "synchronize": {
				const { SynchronizeCommand } = await import("./commands/synchronize.js");
				cli.register(SynchronizeCommand);
				return;
			}
			case "tenants": {
				const { CurrentTenantCommand, DeleteTenantCommand, InitCommand, ListTenantsCommand, ProjectIdentityCommand, RenameTenantCommand } = await import("./commands/tenants.js");
				cli.register(InitCommand);
				cli.register(CurrentTenantCommand);
				cli.register(ProjectIdentityCommand);
				cli.register(ListTenantsCommand);
				cli.register(DeleteTenantCommand);
				cli.register(RenameTenantCommand);
				return;
			}
		}
	});
}