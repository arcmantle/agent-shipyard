import { synchronizeStores } from "@agent-issues/core";
import { openSynchronizeStores } from "../../runtime/open-synchronize-stores.js";

import { renderSynchronize } from "../renderers.js";
import { BaseCommand } from "../shared.js";

/**
 * The explicit, user-invoked `synchronize` command (ISS41/ISS59, ADR15,
 * ADR16): converges the current project's local `SqliteStore` and cloud
 * `HttpStore` by merging their append-only history logs, resolving any
 * concurrent same-record edit by last-writer-wins. Never a background
 * process - one run, one report.
 */
export class SynchronizeCommand extends BaseCommand {
	public static paths = [["synchronize"]];

	public async execute(): Promise<number> {
		const { local, cloud, destination } = await openSynchronizeStores({
			databaseOptions: { currentWorkingDirectory: this.context.cwd },
			authSessionOptions: this.context.credentialStoreOptions
		});

		try {
			const summary = await synchronizeStores(local, cloud);
			const result = { command: "synchronize" as const, cloudApiUrl: destination.serviceUrl, tenantId: destination.tenantId, summary };

			this.print(result, renderSynchronize(result));
			return 0;
		} finally {
			await local.close();
			await cloud.close();
		}
	}
}
