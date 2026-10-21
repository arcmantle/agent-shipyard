import { Option } from "clipanion";

import { backfillBodies, parseBackfillableBodyKinds } from "@agent-issues/core";

import { renderBackfillBodies } from "../renderers.js";
import { MutableTenantCommand, parseCsvOption, withStore } from "../shared.js";

export class BackfillBodiesCommand extends MutableTenantCommand {
	public static paths = [["backfill-bodies"]];

	public allTenants = Option.Boolean("--all-tenants", false);
	public dryRun = Option.Boolean("--dry-run", false);
	public kinds = Option.String("--kinds");

	public async execute(): Promise<number> {
		return withStore(this.dbPath, this.withStoreOptions(), async (store, dbPath) => {
			const kinds = parseBackfillableBodyKinds(parseCsvOption(this.kinds));
			const tenantIds = this.allTenants ? (await store.listTenants()).map((tenant) => tenant.id) : [store.tenantId];

			const tenants = [];
			for (const tenantId of tenantIds) {
				if (tenantId === store.tenantId) {
					tenants.push(await backfillBodies(store, { dryRun: this.dryRun, force: this.force, kinds }));
					continue;
				}

				tenants.push(
					await withStore(this.dbPath, this.withStoreOptions({ tenant: tenantId }), (tenantStore) =>
						backfillBodies(tenantStore, { dryRun: this.dryRun, force: this.force, kinds })
					)
				);
			}

			const result = {
				command: "backfill-bodies" as const,
				dbPath,
				dryRun: this.dryRun,
				force: this.force,
				kinds,
				scope: this.allTenants ? ("all-tenants" as const) : ("current-tenant" as const),
				tenants
			};

			this.print(result, renderBackfillBodies(result));
			return 0;
		});
	}
}
