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
}
