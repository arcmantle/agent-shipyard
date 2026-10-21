import { Option } from "clipanion";

import { BodyTenantCommand, TenantCommand, requireOption, requirePositional, withStore } from "../shared.js";

export class AddPlanEntryCommand extends BodyTenantCommand {
	public static paths = [["plan-entry", "add"]];

	public positionals = Option.Rest();
	public role = Option.String("--role");
	public scopeDirection = Option.String("--scope-direction");
	public references = Option.Array("--reference");
	public supersedes = Option.Array("--supersedes");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entry = await store.createPlanEntry({
				planId: requirePositional(this.positionals, 0, "plan-entry add <planId> --role <role> --body-file <path|->"),
				role: requireOption(this.role, "--role is required for plan-entry add.") as "question",
				body: requireOption(await this.resolveBody(), "--body-file is required for plan-entry add."),
				...(this.scopeDirection === undefined ? {} : { scopeDirection: this.scopeDirection as "included" }),
				referencedEntityIds: await resolveEntityIds(store, this.references ?? []),
				supersededEntryIds: this.supersedes ?? []
			});
			this.print(entry, renderPlanEntry(entry));
			return 0;
		});
	}
}

export class EditPlanEntryCommand extends BodyTenantCommand {
	public static paths = [["plan-entry", "edit"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const planId = requirePositional(this.positionals, 0, "plan-entry edit <planId> <entryId> --body-file <path|->");
			const entry = await getPlanEntry(store, planId, requirePositional(this.positionals, 1, "plan-entry edit <planId> <entryId> --body-file <path|->"));
			const updated = await store.updatePlanEntry({
				entryId: entry.id,
				body: requireOption(await this.resolveBody(), "--body-file is required for plan-entry edit."),
				expectedRevision: entry.revision,
				expectedContentHash: entry.contentHash
			});
			this.print(updated, renderPlanEntry(updated));
			return 0;
		});
	}
}

export class DeletePlanEntryCommand extends TenantCommand {
	public static paths = [["plan-entry", "delete"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const planId = requirePositional(this.positionals, 0, "plan-entry delete <planId> <entryId>");
			const entry = await getPlanEntry(store, planId, requirePositional(this.positionals, 1, "plan-entry delete <planId> <entryId>"));
			const deleted = await store.deletePlanEntry({ entryId: entry.id, expectedRevision: entry.revision, expectedContentHash: entry.contentHash });
			this.print(deleted, renderPlanEntry(deleted));
			return 0;
		});
	}
}

export class ListPlanEntriesCommand extends TenantCommand {
	public static paths = [["plan-entry", "list"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const entries = await store.listPlanEntries({ planId: requirePositional(this.positionals, 0, "plan-entry list <planId>") });
			this.print(entries, entries.map(renderPlanEntry).join("\n\n") || "No Plan entries found.");
			return 0;
		});
	}
}

export class PlanEntryHistoryCommand extends TenantCommand {
	public static paths = [["plan-entry", "history"]];

	public positionals = Option.Rest();

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store) => {
			const history = await store.listPlanEntryHistory({ entryId: requirePositional(this.positionals, 0, "plan-entry history <entryId>") });
			this.print(history, history.map(renderPlanEntryHistory).join("\n\n") || "No Plan entry history found.");
			return 0;
		});
	}
}

function renderPlanEntry(entry: { reference: string; role: string; body?: string; tombstone: boolean; revision: number }): string {
	return `${entry.reference} ${entry.role} revision ${entry.revision}${entry.tombstone ? " deleted" : ""}${entry.body === undefined ? "" : `\n${entry.body}`}`;
}

function renderPlanEntryHistory(entry: { entryId: string; role: string; body: string; tombstone: boolean; targetRevision: number }): string {
	return `${entry.entryId} ${entry.role} revision ${entry.targetRevision}${entry.tombstone ? " deleted" : ""}\n${entry.body}`;
}

async function getPlanEntry(
	store: { listPlanEntries(input: { planId: string }): Promise<Array<{ id: string; reference: string; revision: number; contentHash: string }>> },
	planId: string,
	entryId: string
): Promise<{ id: string; reference: string; revision: number; contentHash: string }> {
	const entry = (await store.listPlanEntries({ planId })).find((candidate) => candidate.id === entryId || candidate.reference === entryId);
	if (!entry) {
		throw new Error(`Plan entry not found: ${entryId}`);
	}
	return entry;
}

async function resolveEntityIds(store: { getEntityDetails(entityId: string): Promise<{ entity: { id: string } }> }, references: string[]): Promise<string[]> {
	return Promise.all(references.map(async (reference) => (await store.getEntityDetails(reference)).entity.id));
}