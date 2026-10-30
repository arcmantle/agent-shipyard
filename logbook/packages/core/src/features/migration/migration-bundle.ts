import { RESERVED_SYSTEM_AUTHOR, type RelationRecord } from "../entity-store/domain.js";
import { decodeCanonicalChainBundle, encodeCanonicalChainBundle, type CanonicalChainBundle, type CanonicalChainWireBundle } from "../synchronize/canonical-chain.js";
import { deriveUserIdentity, SYSTEM_AUTHENTICATION_SUBJECT } from "../user-directory/user-directory.js";

/** Stored issue-breakdown draft row; the snapshot stays opaque JSON text. */
export type MigrationIssueBreakdownDraft = {
	id: string;
	targetId: string;
	status: string;
	snapshotJson: string;
	snapshotDigest: string;
	approvedAt: string | null;
	createdIssueReferences: string;
	createdAt: string;
	updatedAt: string;
};

export type MigrationProjectSettings = { projectId: string; prospectorSettings: string };

/** One owner's personal instruction state; the importer becomes its owner. */
export type MigrationInstructions = {
	overrides: Array<{ itemKey: string; kind: string; body: string; revision: number; contentHash: string; defaultVersion: string }>;
	personalFragments: Array<{ itemKey: string; revision: number; body: string; contentHash: string; removed: boolean }>;
	history: Array<{ itemKey: string; revision: number; kind: string; body: string; contentHash: string; defaultVersion: string; isDefault: boolean }>;
};

/** Everything a one-time local-to-cloud migration carries for one tenant. */
export type MigrationBundle = {
	chains: CanonicalChainBundle;
	relations: RelationRecord[];
	issueBreakdownDrafts: MigrationIssueBreakdownDraft[];
	projectSettings: MigrationProjectSettings[];
	instructions: MigrationInstructions;
};

export type MigrationWireBundle = Omit<MigrationBundle, "chains"> & {
	chains: CanonicalChainWireBundle;
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
	issueBreakdownDrafts: number;
	projectSettings: number;
	instructionOverrides: number;
	instructionPersonalFragments: number;
	instructionHistory: number;
};

export function encodeMigrationBundle(bundle: MigrationBundle): MigrationWireBundle {
	return { ...bundle, chains: encodeCanonicalChainBundle(bundle.chains) };
}

export function decodeMigrationBundle(bundle: MigrationWireBundle): MigrationBundle {
	for (const section of ["relations", "issueBreakdownDrafts", "projectSettings"] as const) {
		if (!Array.isArray(bundle[section])) throw new Error(`Invalid migration bundle: ${section} must be an array.`);
	}
	for (const section of ["overrides", "personalFragments", "history"] as const) {
		if (!Array.isArray(bundle.instructions?.[section])) throw new Error(`Invalid migration bundle: instructions.${section} must be an array.`);
	}
	return { ...bundle, chains: decodeCanonicalChainBundle(bundle.chains) };
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
		...bundle,
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
