import { RESERVED_SYSTEM_AUTHOR, type RelationRecord } from "../entity-store/domain.js";
import { decodeCanonicalChainBundle, encodeCanonicalChainBundle, type CanonicalChainBundle, type CanonicalChainWireBundle } from "../synchronize/canonical-chain.js";
import { deriveUserIdentity, SYSTEM_AUTHENTICATION_SUBJECT } from "../user-directory/user-directory.js";

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

type AuthoredChain = { head: { createdBy: string; updatedBy: string }; deltas: Array<{ author: string }> };

/**
 * Gives local users' records to the signed-in owner and replaces the legacy
 * `system` author with the system user ID. Content and patch hashes do not
 * cover authors, so every chain stays valid.
 */
export function assignMigrationAuthorship(bundle: MigrationBundle, owner?: { userId: string; displayName?: string }, now = new Date().toISOString()): MigrationBundle {
	const replacements = new Map<string, string>([[RESERVED_SYSTEM_AUTHOR, deriveUserIdentity(SYSTEM_AUTHENTICATION_SUBJECT).id]]);
	let users = bundle.chains.users;
	if (owner) {
		const ownerUser = deriveUserIdentity(owner.userId);
		for (const user of users) {
			if (user.authenticationSubject.startsWith("local:")) replacements.set(user.id, ownerUser.id);
		}
		users = users.filter((user) => !replacements.has(user.id));
		if (!users.some((user) => user.id === ownerUser.id)) users = [...users, { ...ownerUser, displayName: owner.displayName ?? null, updatedAt: now }];
	}
	const author = (value: string) => replacements.get(value) ?? value;
	const chain = <T extends AuthoredChain>(item: T): T => ({
		...item,
		head: { ...item.head, createdBy: author(item.head.createdBy), updatedBy: author(item.head.updatedBy) },
		deltas: item.deltas.map((delta) => ({ ...delta, author: author(delta.author) }))
	});
	const { chains } = bundle;
	return {
		chains: {
			...chains,
			entities: chains.entities.map(chain),
			contexts: chains.contexts.map(chain),
			contextTerms: chains.contextTerms.map(chain),
			issueComments: chains.issueComments.map(chain),
			planEntries: chains.planEntries.map(chain),
			users
		},
		relations: bundle.relations.map((relation) => ({ ...relation, createdBy: author(relation.createdBy) }))
	};
}
