import { compareMigrationRecordCounts, encodeMigrationBundle } from "@agent-issues/core";
import { Option } from "clipanion";

import { openSynchronizeStores } from "../../runtime/open-synchronize-stores.js";
import { renderCloudMigrate } from "../renderers.js";
import { BaseCommand } from "../shared.js";

/** The hosted JSON-RPC body limit is 50 MiB; keep room for the request envelope. */
const MAXIMUM_MIGRATION_BYTES = 49 * 1024 * 1024;

/**
 * One-time, push-only move of the whole local tenant into an empty cloud
 * tenant, verified by per-feature record counts on both sides.
 */
export class CloudMigrateCommand extends BaseCommand {
	public static paths = [["cloud", "migrate"]];

	public dryRun = Option.Boolean("--dry-run", false, { description: "Report what would move without changing the cloud." });

	public async execute(): Promise<number> {
		const { local, cloud, destination } = await openSynchronizeStores({
			databaseOptions: { currentWorkingDirectory: this.context.cwd },
			authSessionOptions: this.context.credentialStoreOptions
		});

		try {
			const bundle = await local.exportMigrationBundle();
			const localCounts = await local.countMigrationRecords();
			const bytes = Buffer.byteLength(JSON.stringify(encodeMigrationBundle(bundle)));
			if (bytes > MAXIMUM_MIGRATION_BYTES) {
				throw new Error(`The migration data is ${(bytes / 1024 / 1024).toFixed(1)} MB; the cloud accepts at most ${MAXIMUM_MIGRATION_BYTES / 1024 / 1024} MB in one request.`);
			}
			const base = { command: "cloud migrate" as const, dryRun: this.dryRun, cloudApiUrl: destination.serviceUrl, tenantId: destination.tenantId, bytes, local: localCounts };
			if (this.dryRun) {
				const result = { ...base, mismatched: [] };
				this.print(result, renderCloudMigrate(result));
				return 0;
			}
			const cloudCounts = await cloud.importMigrationBundle(bundle);
			const result = { ...base, cloud: cloudCounts, mismatched: compareMigrationRecordCounts(localCounts, cloudCounts) };
			this.print(result, renderCloudMigrate(result));
			return result.mismatched.length === 0 ? 0 : 1;
		} finally {
			await local.close();
			await cloud.close();
		}
	}
}
