import type { RelationRecord } from "../entity-store/domain.js";
import { decodeCanonicalChainBundle, encodeCanonicalChainBundle, type CanonicalChainBundle, type CanonicalChainWireBundle } from "../synchronize/canonical-chain.js";

/** Everything a one-time local-to-cloud migration carries for one tenant. */
export type MigrationBundle = {
	chains: CanonicalChainBundle;
	relations: RelationRecord[];
};

export type MigrationWireBundle = {
	chains: CanonicalChainWireBundle;
	relations: RelationRecord[];
};

/** Record counts for each migrated feature, used to verify a migration. */
export type MigrationRecordCounts = {
	entities: number;
	relations: number;
	contexts: number;
	contextTerms: number;
	issueComments: number;
	planEntries: number;
	completionObservations: number;
	revisionEntries: number;
};

export function encodeMigrationBundle(bundle: MigrationBundle): MigrationWireBundle {
	return { chains: encodeCanonicalChainBundle(bundle.chains), relations: bundle.relations };
}

export function decodeMigrationBundle(bundle: MigrationWireBundle): MigrationBundle {
	if (!Array.isArray(bundle.relations)) throw new Error("Invalid migration bundle: relations must be an array.");
	return { chains: decodeCanonicalChainBundle(bundle.chains), relations: bundle.relations };
}

/** Lists the features whose source and destination counts differ. */
export function compareMigrationRecordCounts(source: MigrationRecordCounts, destination: MigrationRecordCounts): Array<keyof MigrationRecordCounts> {
	return (Object.keys(source) as Array<keyof MigrationRecordCounts>).filter((feature) => source[feature] !== destination[feature]);
}
