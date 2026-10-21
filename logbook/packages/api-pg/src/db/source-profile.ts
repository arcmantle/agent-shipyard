import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import type { SourceProfileResult } from "@agent-issues/core";

const PLAN_ENTRY_CURRENT_FINAL_SCHEMA_SIGNATURE = "85acb3c100b141597768a75ea68dd6bde25498c499dbcc9938f2ebb53e3ec839";
const CURRENT_FINAL_SCHEMA_SIGNATURES = new Set([
	// Approved baseline, user-directory, and provenance schema states.
	"7338aea98e85ac93de5fcfc938d424ba8aa7a75727be17e9bfc39a57c425cde8",
	"7183b76f12b7bcc7034e61a270a69ed7d86888b80799aa201234aeac21801d20",
	"82a0f44eb2dd317d2e736e74c1843e4181589c91e1da7bcdf6481841daaf9363",
	"b5bb9bb161f3232d502a3d9c37d99170a25e4b864a185ff440938ebe74fdb8f4",
	"e57e950cb17f96e5236069ac076664395049b81363c2906ff3580af074d6bbb5",
	"867e63130040b24b7c2d8beaa0e3253f5a435f1291078e7ac4f978bf7708d10f",
	"a6a894d15f5de8420066212c3705b142965f9cf4bfdaefe1637047fcd0504fae",
	"3f931c8581d03d6074a91f9ecfecc8eb2098aaf97e83d3f56031ec157ae56b5a",
	"b5b3b8fb4004aa0a60a1d06fc09df7001df75adc96482b30fd87801b3df01275",
	"cded6c1f630cf7416ad1c9c94bc2b8f54bea4f1290952418ca9b561c05ab9b43",
	"2b114dc6e1b5591c4506aa978d45039128fc9afe40abe1ef1a8a44e6161ed8f6",
	"e2ac00755b2681520a6fe30d91d2fde23b6c3b60c333d580210ed47d8f8d9e09",
	"1371ec3500ba5aabb1e56b2a2f04664451887e3b1fdb810844057d3cb6fe61db",
	"9dc2891e9c000873652567e0a3c7fdb03ac78666895a31d35df7067914d090df",
	PLAN_ENTRY_CURRENT_FINAL_SCHEMA_SIGNATURE,
	"79379ad802462a6bbbb5cfa60650a121c3c4275ff6256bb0da6f4f6ed0e5e88b",
	"fdd9405f73dfea1ba83bd26f816c87a54a6ccb0766c0d4c2a1e024f4ac878be6",
	"01461ca769b00c88898ad7a52b3339a634ae2fda5f86a10f5d7f9596ced9cc92",
	"a61d35984511b4dd89950ba72306b75c2ba154b360a98da0698b68fdc9b3b1d7",
	"4ac0d2e7e9f85483b14da9079db51e832ffdf31be2a4427f3c37297a7798ac2e",
	"dad3faad1f4ee8fa965aa1302da49e7fb0f5af1e9e54c6e52b2878c1def5e527",
	"99f13187259d6ade65560e25aa0e2a3536e2840e58a23b15e19e523673efdb55",
	"68efd6782b53a787eeef04bb6899759728be1a6dc6c797023e44b57d6efec8df",
	"bfff2e6b1dee6d41e31af57add9d5e5713c2d29e4e0bfcf90bafef181104abd7",
	"bbf962f39f9af33ff772d6c7c835cfa678f8df3de96b0e0feb815770dda7769f",
	"b15bdaa8226b16c9aee62179322154970d0de44226d6626865cbd0c0d251f484",
	"b42b97901f55af07e9113ec88ec355152109edd9819650baeb10d234d5c072c1",
	"362de5a8bac02a4754a137401b12ee3c03addf2b7759a24a12576a3b3a154648",
	"9dc1062d3ff63ba34cf2ab732a5169dfb2859effbd7a5a2e63de93c2fc31b735",
	"993ffac825d268f446dbd35b87b9d9b57030314ca1d72e4f8f4a9e49dd5d6ef3",
	"5feec9f3a0204443c972a5b2530b5aaa30efec48c41ef01669b40a809072f1a6",
	"bac889c117dbcbc2ee6d83dc7ae9d92b8200d0e0ba4980930b27ce3012e86275",
	"0affdb76a8cb5391676ed686ab5efcba017dee4d2ab9e58ad5d911825105f522"
]);
const LEGACY_V7_SCHEMA_SIGNATURE = "a56ad7487ddca6b9095b9af7e197da17507f541bd714b627e70cedca54e5f2da";

type CatalogColumn = {
	column_default: string | null;
	column_name: string;
	data_type: string;
	is_nullable: string;
	ordinal_position: number;
	table_name: string;
	udt_name: string;
};

type CatalogConstraint = {
	constraint_name: string;
	constraint_type: string;
	definition: string;
	table_name: string;
};

type SchemaObject = {
	object_kind: string;
	object_name: string;
};

/**
 * Rewrites schema-qualified references (`public.entities`) so the same schema
 * hashes identically wherever it is installed - production runs in `public`,
 * the migration tests each create their own schema.
 *
 * Only the fields that can carry a qualified name are rewritten. Replacing the
 * schema name throughout the serialized catalog instead also rewrites values
 * that merely happen to equal it: `pg_policies.roles` is `{public}` for a
 * policy with no explicit `TO` clause, which every `tenant_isolation` policy
 * here relies on, so an install in `public` hashed differently from an
 * identical one in a test schema and was rejected as an unsupported profile.
 */
function normalizeSchemaReferences(value: string | null, schemaName: string): string | null {
	return value === null ? null : value.split(`${schemaName}.`).join("<current_schema>.");
}

export async function inspectPgSourceProfile(client: Pick<PoolClient, "query">, expectedLedgerIds: string[]): Promise<SourceProfileResult> {
	const schemaResult = await client.query<{ current_schema: string }>("SELECT current_schema() AS current_schema");
	const schemaName = schemaResult.rows[0]?.current_schema ?? "public";
	const objects = await client.query<SchemaObject>(
		`SELECT object_kind, object_name FROM (
			SELECT CASE relation.relkind
				WHEN 'r' THEN 'table'
				WHEN 'p' THEN 'partitioned table'
				WHEN 'v' THEN 'view'
				WHEN 'm' THEN 'materialized view'
				WHEN 'S' THEN 'sequence'
				WHEN 'f' THEN 'foreign table'
			END AS object_kind, relation.relname AS object_name
			FROM pg_class AS relation
			JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
			WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation.oid AND dependency.deptype = 'e'
				)
				AND (relation.relkind <> 'S' OR NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_class'::regclass
						AND dependency.objid = relation.oid AND dependency.deptype IN ('a', 'i')
				))
			UNION ALL
			SELECT 'function', procedure.proname || '(' || pg_get_function_identity_arguments(procedure.oid) || ')'
			FROM pg_proc AS procedure
			JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_proc'::regclass
						AND dependency.objid = procedure.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT CASE type_row.typtype
				WHEN 'c' THEN 'composite type'
				WHEN 'd' THEN 'domain'
				WHEN 'e' THEN 'enum type'
				WHEN 'm' THEN 'multirange type'
				WHEN 'r' THEN 'range type'
			END, type_row.typname
			FROM pg_type AS type_row
			JOIN pg_namespace AS namespace ON namespace.oid = type_row.typnamespace
			LEFT JOIN pg_class AS relation ON relation.oid = type_row.typrelid
			WHERE namespace.nspname = $1
				AND (type_row.typtype IN ('d', 'e', 'm', 'r') OR (type_row.typtype = 'c' AND relation.relkind = 'c'))
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_type'::regclass
						AND dependency.objid = type_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'collation', collation_row.collname
			FROM pg_collation AS collation_row
			JOIN pg_namespace AS namespace ON namespace.oid = collation_row.collnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_collation'::regclass
						AND dependency.objid = collation_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'conversion', conversion_row.conname
			FROM pg_conversion AS conversion_row
			JOIN pg_namespace AS namespace ON namespace.oid = conversion_row.connamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_conversion'::regclass
						AND dependency.objid = conversion_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search configuration', configuration.cfgname
			FROM pg_ts_config AS configuration
			JOIN pg_namespace AS namespace ON namespace.oid = configuration.cfgnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_config'::regclass
						AND dependency.objid = configuration.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search dictionary', dictionary.dictname
			FROM pg_ts_dict AS dictionary
			JOIN pg_namespace AS namespace ON namespace.oid = dictionary.dictnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_dict'::regclass
						AND dependency.objid = dictionary.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search parser', parser.prsname
			FROM pg_ts_parser AS parser
			JOIN pg_namespace AS namespace ON namespace.oid = parser.prsnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_parser'::regclass
						AND dependency.objid = parser.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'text search template', template.tmplname
			FROM pg_ts_template AS template
			JOIN pg_namespace AS namespace ON namespace.oid = template.tmplnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_ts_template'::regclass
						AND dependency.objid = template.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'operator', operator_row.oprname || '(' ||
				CASE WHEN operator_row.oprleft = 0 THEN 'NONE' ELSE format_type(operator_row.oprleft, NULL) END || ', ' ||
				CASE WHEN operator_row.oprright = 0 THEN 'NONE' ELSE format_type(operator_row.oprright, NULL) END || ')'
			FROM pg_operator AS operator_row
			JOIN pg_namespace AS namespace ON namespace.oid = operator_row.oprnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_operator'::regclass
						AND dependency.objid = operator_row.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'operator class', operator_class.opcname
			FROM pg_opclass AS operator_class
			JOIN pg_namespace AS namespace ON namespace.oid = operator_class.opcnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_opclass'::regclass
						AND dependency.objid = operator_class.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'operator family', operator_family.opfname
			FROM pg_opfamily AS operator_family
			JOIN pg_namespace AS namespace ON namespace.oid = operator_family.opfnamespace
			WHERE namespace.nspname = $1
				AND NOT EXISTS (
					SELECT 1 FROM pg_depend AS dependency
					WHERE dependency.classid = 'pg_opfamily'::regclass
						AND dependency.objid = operator_family.oid AND dependency.deptype = 'e'
				)
			UNION ALL
			SELECT 'extension', extension.extname
			FROM pg_extension AS extension
			JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
			WHERE namespace.nspname = $1
		) AS schema_objects
		ORDER BY object_kind, object_name`,
		[schemaName]
	);
	const tables = await client.query(
		`SELECT table_name FROM information_schema.tables
		 WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		 ORDER BY table_name`,
		[schemaName]
	);
	const columns = await client.query<CatalogColumn>(
		`SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable, column_default
		 FROM information_schema.columns
		 WHERE table_schema = $1
		 ORDER BY table_name, ordinal_position`,
		[schemaName]
	);
	const constraints = await client.query<CatalogConstraint>(
		`SELECT relation.relname AS table_name, constraint_row.conname AS constraint_name,
			constraint_row.contype AS constraint_type, pg_get_constraintdef(constraint_row.oid, true) AS definition
		 FROM pg_constraint AS constraint_row
		 JOIN pg_class AS relation ON relation.oid = constraint_row.conrelid
		 JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		 WHERE namespace.nspname = $1
		 ORDER BY relation.relname, constraint_row.conname`,
		[schemaName]
	);
	const indexes = await client.query(
		`SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
		 FROM pg_indexes WHERE schemaname = $1
		 ORDER BY tablename, indexname`,
		[schemaName]
	);
	const policies = await client.query(
		`SELECT tablename AS table_name, policyname AS policy_name, permissive, roles, cmd, qual, with_check
		 FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`,
		[schemaName]
	);
	const tableSecurity = await client.query(
		`SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity
		 FROM pg_class AS relation
		 JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
		 WHERE namespace.nspname = $1 AND relation.relkind = 'r'
		 ORDER BY relation.relname`,
		[schemaName]
	);
	const canonicalCatalog = JSON.stringify({
		columns: columns.rows.map((row) => ({ ...row, column_default: normalizeSchemaReferences(row.column_default, schemaName) })),
		constraints: constraints.rows,
		indexes: indexes.rows.map((row) => ({ ...row, definition: normalizeSchemaReferences(row.definition, schemaName) })),
		objects: objects.rows,
		policies: policies.rows,
		tableSecurity: tableSecurity.rows,
		tables: tables.rows
	});
	const schemaSignature = createHash("sha256").update(canonicalCatalog).digest("hex");
	const ledgerExists = await client.query<{ exists: boolean }>(
		`SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = $1 AND table_name = 'schema_migrations' AND table_type = 'BASE TABLE'
		) AS exists`,
		[schemaName]
	);
	const hasLedger = ledgerExists.rows[0]?.exists === true;
	const ledgerShapeMismatch = hasLedger ? inspectLedgerShape(columns.rows, constraints.rows) : undefined;
	const ledgerIds = hasLedger
		? ledgerShapeMismatch === undefined
			? (await client.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY applied_at, id")).rows.map(({ id }) => id)
			: []
		: [];
	const evidence = { dialect: "postgres" as const, ledgerIds, schemaSignature };
	if (ledgerShapeMismatch !== undefined) {
		return unsupported(evidence, objects.rows, ledgerShapeMismatch);
	}

	const applicationObjects = objects.rows.filter(({ object_kind, object_name }) => object_kind !== "table" || object_name !== "schema_migrations");
	if (applicationObjects.length === 0 && !hasLedger) {
		return { evidence, profile: "empty", supported: true };
	}
	if (schemaSignature === LEGACY_V7_SCHEMA_SIGNATURE && !hasLedger) {
		return { evidence, profile: "legacy-postgres-v7", supported: true };
	}
	const hasSupportedLedger = (ledgerIds.length > 0
			&& ledgerIds.every((id, index) => id === expectedLedgerIds[index]))
			|| (ledgerIds.length === expectedLedgerIds.length
				&& ledgerIds[0] === "legacy-v7-direct"
				&& expectedLedgerIds.every((id) => ledgerIds.includes(id)))
			|| (ledgerIds.length === 1 && ledgerIds[0] === "legacy-v7-direct");
	if (CURRENT_FINAL_SCHEMA_SIGNATURES.has(schemaSignature) && hasSupportedLedger) {
		return { evidence, profile: "current-final", supported: true };
	}
	return unsupported(evidence, applicationObjects);
}

function inspectLedgerShape(columns: CatalogColumn[], constraints: CatalogConstraint[]): string | undefined {
	const ledgerColumns = columns.filter(({ table_name }) => table_name === "schema_migrations");
	const ledgerConstraints = constraints.filter(({ table_name }) => table_name === "schema_migrations");
	const expectedColumns = [
		{ column_default: null, column_name: "id", data_type: "text", is_nullable: "NO", ordinal_position: 1, table_name: "schema_migrations", udt_name: "text" },
		{ column_default: "now()", column_name: "applied_at", data_type: "timestamp with time zone", is_nullable: "NO", ordinal_position: 2, table_name: "schema_migrations", udt_name: "timestamptz" }
	];
	const hasCanonicalPrimaryKey = ledgerConstraints.length === 1
		&& ledgerConstraints[0]?.constraint_type === "p"
		&& ledgerConstraints[0].definition === "PRIMARY KEY (id)";
	const hasCanonicalColumns = ledgerColumns.length === expectedColumns.length
		&& ledgerColumns.every((column, index) => {
			const expected = expectedColumns[index];
			return expected !== undefined
				&& column.column_default === expected.column_default
				&& column.column_name === expected.column_name
				&& column.data_type === expected.data_type
				&& column.is_nullable === expected.is_nullable
				&& column.ordinal_position === expected.ordinal_position
				&& column.table_name === expected.table_name
				&& column.udt_name === expected.udt_name;
		});
	if (hasCanonicalColumns && hasCanonicalPrimaryKey) {
		return undefined;
	}
	return `migration ledger shape does not match required columns, nullability, defaults, primary key, and constraints: ${JSON.stringify({ columns: ledgerColumns, constraints: ledgerConstraints })}`;
}

function unsupported(
	evidence: SourceProfileResult["evidence"],
	objects: SchemaObject[],
	ledgerShapeMismatch?: string
): SourceProfileResult {
	return {
		evidence,
		profile: "unsupported",
		reasons: [
			...(ledgerShapeMismatch === undefined ? [] : [ledgerShapeMismatch]),
			`schema signature ${evidence.schemaSignature} from objects: ${objects.map(({ object_kind, object_name }) => `${object_kind} ${object_name}`).join(", ") || "none"}`,
			`ordered schema_migrations IDs: ${evidence.ledgerIds.join(", ") || "none"}`
		],
		recoveryPaths: [
			"Keep the source unchanged and capture its catalog and row-count evidence.",
			"Repair and verify a copy manually, or migrate an empty schema."
		],
		supported: false
	};
}