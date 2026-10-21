import { Option } from "clipanion";

import { resolveDatabasePath, resolveTenantRootPath, resolveTenantSlug } from "@agent-issues/api-local";

import { resolveProjectIdentity } from "../../runtime/project-identity.js";
import { renderCurrentTenant, renderDeleteTenant, renderProjectIdentity, renderRenameTenant, renderTenantList } from "../renderers.js";
import { MutableTenantCommand, TenantCommand, requirePositional, withStore } from "../shared.js";

export class InitCommand extends TenantCommand {
	public static paths = [["init"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (_store, dbPath) => {
			this.print(
				{
					command: "init",
					dbPath,
					status: "ok"
				},
				`Initialized data store at ${dbPath}`
			);
			return 0;
		});
	}
}

export class CurrentTenantCommand extends TenantCommand {
	public static paths = [["current-tenant"]];

	public async execute(): Promise<number> {
		const result = {
			command: "current-tenant" as const,
			dbPath: resolveDatabasePath(this.dbPath, { currentWorkingDirectory: this.context.cwd }),
			tenantId: resolveTenantSlug({ currentWorkingDirectory: this.context.cwd }),
			workspaceRoot: resolveTenantRootPath(this.context.cwd)
		};

		this.print(result, renderCurrentTenant(result));
		return 0;
	}
}

export class ProjectIdentityCommand extends TenantCommand {
	public static paths = [["project-identity"]];

	public async execute(): Promise<number> {
		const result = {
			command: "project-identity" as const,
			...resolveProjectIdentity(this.context.cwd)
		};

		this.print(result, renderProjectIdentity(result));
		return 0;
	}
}

abstract class TenantAdminCommand extends MutableTenantCommand {
	public positionals = Option.Rest();
}

export class ListTenantsCommand extends TenantCommand {
	public static paths = [["list-tenants"]];

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store, dbPath) => {
			const result = {
				command: "list-tenants" as const,
				currentTenantId: resolveTenantSlug({ currentWorkingDirectory: this.context.cwd }),
				dbPath,
				tenants: await store.listTenants()
			};

			this.print(result, renderTenantList(result));
			return 0;
		});
	}
}

export class DeleteTenantCommand extends TenantAdminCommand {
	public static paths = [["delete-tenant"]];

	public async execute(): Promise<number> {
		if (!this.force) {
			throw new Error("`delete-tenant` requires `--force`.");
		}

		return withStore(this.dbPath, this.withStoreOptions(), async (store, dbPath) => {
			const rawTenantId = requirePositional(this.positionals, 0, "delete-tenant <tenantId> --force");
			const tenantId = resolveTenantSlug({ tenant: rawTenantId });
			const result = {
				command: "delete-tenant" as const,
				dbPath,
				...(await store.deleteTenant(tenantId))
			};

			this.print(result, renderDeleteTenant(result));
			return 0;
		});
	}
}

export class RenameTenantCommand extends TenantAdminCommand {
	public static paths = [["rename-tenant"]];

	public async execute(): Promise<number> {
		if (!this.force) {
			throw new Error("`rename-tenant` requires `--force`.");
		}

		return withStore(this.dbPath, this.withStoreOptions(), async (store, dbPath) => {
			const rawPreviousTenantId = requirePositional(this.positionals, 0, "rename-tenant <tenantId> <newTenantId> --force");
			const rawNewTenantId = requirePositional(this.positionals, 1, "rename-tenant <tenantId> <newTenantId> --force");
			const previousTenantId = resolveTenantSlug({ tenant: rawPreviousTenantId });
			const newTenantId = resolveTenantSlug({ tenant: rawNewTenantId });
			const result = {
				command: "rename-tenant" as const,
				dbPath,
				...(await store.renameTenant(previousTenantId, newTenantId))
			};

			this.print(result, renderRenameTenant(result));
			return 0;
		});
	}
}
