import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import type { SourceProfileResult } from "@agent-issues/core";
import type { SqliteInternalConnection } from "./sqlite-executor.js";

type SchemaObject = {
	name: string;
	sql: string | null;
	type: string;
};

type LedgerColumn = {
	cid: number;
	dflt_value: string | null;
	name: string;
	notnull: number;
	pk: number;
	type: string;
};

type LedgerIndex = {
	origin: string;
	partial: number;
	unique: number;
};

const LEGACY_V7_SCHEMA_SIGNATURES = new Set([
	"c0efb8fd9cb7f1fffcf946eb63c325e5b595a48ea6fdeca1dab3bbc08989b723",
	"ce2a73dc63ee1baeb7a53be50f5117cbacf46e70791cd80f98c1d25bf3d26685"
]);

const CURRENT_FINAL_SCHEMA_SIGNATURES = new Set([
	"c1e2b66ceb30869f739d605eeebc7247aac0ff8635124a962686ec6bbea9a81d",
	"50d7513e53b59d56788432fd20496ec41eaf468627853792af78ee8feb5ba2c9",
	"f8b576a20018130ef47a0df073d09a139683d3f47ae9becb5e1f45c61b43fbe0",
	"ee001534d58d8506c0011534cb82ae3a2d0c5a25958ed5bae01ca1ff828c9b1b",
	"f8688deca5a9334021fb175da92be9281f6950be455608980a944f2694791804",
	"66ff29b38bc923a660fc1bffd3b0cca96a649be331a62c596bd1d37c2f0c2244",
	"e6a9d0864480ec5a69ab319a2e414a3bf5ab52021cb002e0f3bf1eb3ea8d25dd",
	"bf99a2d79c2eb10993645ad57bedfdcae257b94944e2a74cdcf584eb43d40653",
	"29f9fcfa7de7c3bd4dfbff6c8c946b27ff86f140e81066032ca75a4e3ea79422",
	"7891cbdbbadab362a08d993b4bc0a17f33669510db8a114702e5a148ce495e70",
	"16522f37d98d36de3ade800657bebbdaaa0ffba733326953e695b9d5f88c4171",
	"9e7cc62c0dcf87198c8bcbe5dd1c91a141c978dcfb88d0d8af98628ef47bfbb6",
	"dc0ab9d8b8e93223dd9fd87bc3416adbf5d9a814c0d3494979c6ab4244d823bb",
	"56088fdda6180c9343496577f60e217fa53510c83b9b2fa3372b8d3d55e3e002",
	"8d7d1a1254ac3e5737f2385c3fc30ee4fa195b63a6b951d8ec4274700afd02ff",
	"6c4e5d5e7b55c93c9131d9a58a52329331225e7ea7931e4be95c85aaeef5a1d3",
	"77424dc75798c6a57ef3e08c17e4e29afe1948cc2650e347731ac92d3f2e9c50",
	"bbcb57583c51629c48796a92d5eeb462e014688821c770549b199f36d72b8a1b",
	"7e4da79023e5dfae7dca9af6237cc8d682e4204cec24a28f43c0e71908853862",
	"99e12d737bc7fcd0b7ebf9ade320608691b793b95f04fdaa6df8dd4d72048c96"
	,"b6f00a4c2cdc47d8e396c119e104449d6c97f0a111c0fc30f14af6813b0ee4af"
	,"49bfea4a6c0e95767f42dd3fd1ecbe1bfc0ac064984133cae2cac85f31bcdff8"
	,"3c78b8616ce76f2fe5cc44aec3c3eb25ff86b294f725cdffea4bf68ce3c905ab"
	,"2dec45af9afc36011c6a8514be59693775805b10a92d71f0ca15336f8c659668"
	,"2f66142d5523eeef7c062c6b48e017fa5fbe4948236f31a4818972d765a17896"
	,"2fd4340b768581ad6a73113ba0c14bbf9e09ce07c8cad8e24c170298ffe6e8d9"
	,"4d9d556677f5c0597da05951ac09905ebfd2276423f7eebde1bab3fbc9712ff1"
]);
const DIRECT_FINAL_SCHEMA_SIGNATURE = "892a43c929f85fd4f71f334c02aa664bc7e8a5f2203929654a10e11229d541ff";
const DIRECT_USER_DIRECTORY_SCHEMA_SIGNATURE = "8b16a9b6f6ed70905c50813482a2301d7dc9859775abba2c2dfc2300f8b225fe";
const DIRECT_PROVENANCE_SCHEMA_SIGNATURE = "e33a97d943e0ec653e3cb77ccafd448f04043a89464045eb2ec670d5b4083d36";
const DIRECT_ISSUE_COMMENTS_SCHEMA_SIGNATURE = "a6c2a8ff988200bc7c9022a0c45be645a573715134c986c9bbc3ccedbfbf905e";
const DIRECT_DEBT_METADATA_SCHEMA_SIGNATURE = "ab71a7ce651e889eba3fc47de47cd33afc0be5670d02fa8aa444c9f8aea69823";
const DIRECT_SHORT_ENTITY_REFERENCE_SCHEMA_SIGNATURE = "90281f8991142883e09fd636d18520cac18bf66125826e6a7c767375b391c50c";
const DIRECT_SHORT_RECORD_REFERENCE_SCHEMA_SIGNATURE = "ab486dcf006ef3262da07bf2f2daf302701b970d1edbddadf1d97539ad2bd3e5";
const DIRECT_PLAN_ENTRIES_SCHEMA_SIGNATURE = "b72cabb9c3106db9f0713ebeab15e28580bc721cbb74addeb3a6f97ec54605c7";
const DIRECT_PLAN_ENTRY_SUPERSESSION_POSITION_SCHEMA_SIGNATURE = "56088fdda6180c9343496577f60e217fa53510c83b9b2fa3372b8d3d55e3e002";
const DIRECT_TOKEN_SEARCH_SCHEMA_SIGNATURE = "a5685140b1f0685a54f0caf479065b9682c361c06ebcab9558b59d35168ef27b";
const DIRECT_SEARCH_TYPO_VOCABULARY_SCHEMA_SIGNATURE = "a713c980aa71dcceb950c10a6ccb818e1871a0e9a1203e95074d84aed2a84504";
const DIRECT_INSTRUCTION_DEFAULTS_SCHEMA_SIGNATURE = "b765ed8566f18171ed12feb5990610e0e760c3d6612c8c64fe0425b7add92c13";
const DIRECT_INSTRUCTION_OVERRIDES_SCHEMA_SIGNATURE = "aa37aabd5e74b3d6c6b2deff365b3b50dd19fecbd8ebb74e9989866372922da5";
const DIRECT_PERSONAL_FRAGMENTS_SCHEMA_SIGNATURE = "32aef3a0eb7e04dd39bcf5d716bce63f85a1236a4b6da1062e976fb40890b811";
const DIRECT_INSTRUCTION_HISTORY_SCHEMA_SIGNATURE = "60d95c66e8e4523ef968e8bc566e873ad7c435fa90209f98c1206d75208dcd97";

export function inspectSqliteSourceProfile(database: SqliteInternalConnection, expectedLedgerIds: string[]): SourceProfileResult {
	const schemaObjects = database.drizzle.all<SchemaObject>(
		sql`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
	);
	const applicationObjects = schemaObjects.filter(({ name }) => name !== "schema_migrations");
	const schemaSignature = createHash("sha256").update(JSON.stringify(schemaObjects)).digest("hex");
	const finalSchemaSignature = createHash("sha256")
		.update(JSON.stringify(schemaObjects
			.filter(({ name }) => !name.startsWith("legacy_v7_"))
			.map((object) => object.name === "schema_migrations"
				? { ...object, sql: object.sql?.replace("CREATE TABLE schema_migrations", "CREATE TABLE IF NOT EXISTS schema_migrations") ?? null }
				: object)))
		.digest("hex");
	const ledgerMetadata = schemaObjects.find(({ name }) => name === "schema_migrations");
	const ledgerShapeMismatch = ledgerMetadata === undefined
		? undefined
		: ledgerMetadata.type === "table"
			? inspectLedgerShape(database)
			: `migration ledger metadata must be a table, found ${ledgerMetadata.type}: ${JSON.stringify(ledgerMetadata)}`;
	const ledgerIds = ledgerMetadata !== undefined
		? ledgerShapeMismatch === undefined
			? database.drizzle.all<{ id: string }>(sql`SELECT id FROM schema_migrations ORDER BY rowid`).map(({ id }) => id)
			: []
		: [];
	const evidence = { dialect: "sqlite" as const, ledgerIds, schemaSignature };
	if (ledgerShapeMismatch !== undefined) {
		return unsupported(evidence, applicationObjects, ledgerShapeMismatch);
	}

	if (applicationObjects.length === 0 && ledgerMetadata === undefined) {
		return { evidence, profile: "empty", supported: true };
	}
	if (LEGACY_V7_SCHEMA_SIGNATURES.has(schemaSignature) && ledgerMetadata === undefined) {
		return { evidence, profile: "legacy-sqlite-v7", supported: true };
	}
	if (CURRENT_FINAL_SCHEMA_SIGNATURES.has(schemaSignature)
		&& ledgerIds.length > 0
		&& ledgerIds.every((id, index) => id === expectedLedgerIds[index])) {
		return { evidence, profile: "current-final", supported: true };
	}
	if ((finalSchemaSignature === DIRECT_FINAL_SCHEMA_SIGNATURE || schemaSignature === DIRECT_USER_DIRECTORY_SCHEMA_SIGNATURE || schemaSignature === DIRECT_PROVENANCE_SCHEMA_SIGNATURE)
		&& !schemaObjects.some(({ name }) => name.startsWith("legacy_v7_"))
		&& ledgerIds.length === 1
		&& ledgerIds[0] === "legacy-v7-direct") {
		return { evidence, profile: "current-final", supported: true };
	}
	if ((schemaSignature === DIRECT_ISSUE_COMMENTS_SCHEMA_SIGNATURE || schemaSignature === DIRECT_DEBT_METADATA_SCHEMA_SIGNATURE || schemaSignature === DIRECT_SHORT_ENTITY_REFERENCE_SCHEMA_SIGNATURE || schemaSignature === DIRECT_SHORT_RECORD_REFERENCE_SCHEMA_SIGNATURE || schemaSignature === DIRECT_PLAN_ENTRIES_SCHEMA_SIGNATURE || schemaSignature === DIRECT_PLAN_ENTRY_SUPERSESSION_POSITION_SCHEMA_SIGNATURE || schemaSignature === DIRECT_TOKEN_SEARCH_SCHEMA_SIGNATURE || schemaSignature === DIRECT_SEARCH_TYPO_VOCABULARY_SCHEMA_SIGNATURE || schemaSignature === "902792184b29f07529230b5a5e49e09b7642ae65059a55a00e14280adcdf9b1e" || schemaSignature === "98a02c352e93cc53bc916a26402f9828065db6050dc038e83b96edbe8739d848" || schemaSignature === "cb1ce82c75f132e1e08795cbb31574e856339d76f3e8add625e7943c04aa032b" || schemaSignature === DIRECT_INSTRUCTION_DEFAULTS_SCHEMA_SIGNATURE || schemaSignature === DIRECT_INSTRUCTION_OVERRIDES_SCHEMA_SIGNATURE || schemaSignature === DIRECT_PERSONAL_FRAGMENTS_SCHEMA_SIGNATURE || schemaSignature === DIRECT_INSTRUCTION_HISTORY_SCHEMA_SIGNATURE || schemaSignature === "bb2fd69bdb8a417f373ecf48b12a0f2f284fa10a61fe7fe941ec7458b50d3732")
		&& ledgerIds.length > 1
		&& ledgerIds.length <= expectedLedgerIds.length + 1
		&& ledgerIds[0] === "legacy-v7-direct"
		&& ledgerIds.slice(1).every((id, index) => id === expectedLedgerIds[index])) {
		return { evidence, profile: "current-final", supported: true };
	}

	return unsupported(evidence, applicationObjects);
}

function inspectLedgerShape(database: SqliteInternalConnection): string | undefined {
	const columns = database.drizzle.all<LedgerColumn>(sql.raw("PRAGMA table_info('schema_migrations')"));
	const indexes = database.drizzle.all<LedgerIndex>(sql.raw("PRAGMA index_list('schema_migrations')"));
	const foreignKeys = database.drizzle.all(sql.raw("PRAGMA foreign_key_list('schema_migrations')"));
	const expectedColumns = [
		{ cid: 0, dflt_value: null, name: "id", notnull: 0, pk: 1, type: "TEXT" },
		{ cid: 1, dflt_value: null, name: "applied_at", notnull: 1, pk: 0, type: "TEXT" }
	];
	const hasCanonicalPrimaryKey = indexes.length === 1
		&& indexes[0]?.origin === "pk"
		&& indexes[0].partial === 0
		&& indexes[0].unique === 1;
	const hasCanonicalColumns = columns.length === expectedColumns.length
		&& columns.every((column, index) => {
			const expected = expectedColumns[index];
			return expected !== undefined
				&& column.cid === expected.cid
				&& column.dflt_value === expected.dflt_value
				&& column.name === expected.name
				&& column.notnull === expected.notnull
				&& column.pk === expected.pk
				&& column.type === expected.type;
		});
	if (hasCanonicalColumns && hasCanonicalPrimaryKey && foreignKeys.length === 0) {
		return undefined;
	}
	return `migration ledger shape does not match required columns, nullability, defaults, primary key, and constraints: ${JSON.stringify({ columns, foreignKeys, indexes })}`;
}

function unsupported(
	evidence: SourceProfileResult["evidence"],
	applicationObjects: SchemaObject[],
	ledgerShapeMismatch?: string
): SourceProfileResult {
	return {
		evidence,
		profile: "unsupported",
		reasons: [
			...(ledgerShapeMismatch === undefined ? [] : [ledgerShapeMismatch]),
			`schema signature ${evidence.schemaSignature} from objects: ${applicationObjects.map(({ name }) => name).join(", ") || "none"}`,
			`ordered schema_migrations IDs: ${evidence.ledgerIds.join(", ") || "none"}`
		],
		recoveryPaths: [
			"Keep the source unchanged and take a byte-for-byte copy for inspection.",
			"Repair and verify a copy manually, or start with an empty database."
		],
		supported: false
	};
}