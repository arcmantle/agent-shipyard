import type { MigrationBundle, MigrationRecordCounts } from "../migration/migration-bundle.js";
import type { CanonicalChainBundle, CanonicalChainImportResult } from "../synchronize/canonical-chain.js";

/**
 * The synchronize half of the storage-driver seam (ADR "Backends mirror one
 * another per feature, behind all-async feature interfaces"), split out of
 * `StorageDriver` so a reader who knows one backend's `LocalSynchronizeStore`/
 * `PgSynchronizeStore` can read the other.
 */
export interface SynchronizeStore {
	exportCanonicalChains(): Promise<CanonicalChainBundle>;
	importCanonicalChains(bundle: CanonicalChainBundle): Promise<CanonicalChainImportResult>;
	/** Exports the whole tenant, including relations of every project, for a one-time migration. */
	exportMigrationBundle(): Promise<MigrationBundle>;
	/** Imports a migration bundle into a tenant that has no records except the seeded default project and epic. */
	importMigrationBundle(bundle: MigrationBundle): Promise<MigrationRecordCounts>;
	countMigrationRecords(): Promise<MigrationRecordCounts>;
}
