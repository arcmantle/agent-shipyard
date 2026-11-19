using System.Security.Cryptography;
using System.Text;
using Dapper;
using Npgsql;

namespace AgentLogbook.Storage.Postgres;

/// <summary>Reads the schema of the current database schema and reduces it to a signature.</summary>
internal static class PostgresSchemaCatalog
{
	/// <summary>Number of schema objects, whatever their kind. Zero means a schema with nothing in it.</summary>
	private const string ObjectCountSql = """
		SELECT
			(SELECT count(*) FROM pg_class relation WHERE relation.relnamespace = current_schema()::regnamespace
				AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
				AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = relation.oid AND d.deptype IN ('e', 'a', 'i')))
			+ (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = current_schema()::regnamespace
				AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'))
			+ (SELECT count(*) FROM pg_type t WHERE t.typnamespace = current_schema()::regnamespace AND t.typtype IN ('d', 'e', 'm', 'r'))
			+ (SELECT count(*) FROM pg_extension e WHERE e.extnamespace = current_schema()::regnamespace)
		""";

	/// <summary>
	/// One line for each schema fact that the contract depends on. Names are free of the schema name so
	/// that the same schema gives the same signature in any database schema.
	/// </summary>
	private const string SignatureSql = """
		SELECT line FROM (
			SELECT 'relation ' || relation.relkind::text || ' ' || relation.relname
				|| ' rls=' || relation.relrowsecurity || ' force=' || relation.relforcerowsecurity AS line
			FROM pg_class relation
			WHERE relation.relnamespace = current_schema()::regnamespace
				AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f', 'c')
			UNION ALL
			SELECT 'column ' || relation.relname || '.' || attribute.attname || ' ' || format_type(attribute.atttypid, attribute.atttypmod)
				|| ' notnull=' || attribute.attnotnull || ' default=' || COALESCE(pg_get_expr(definition.adbin, definition.adrelid), '')
				|| ' identity=' || attribute.attidentity::text || ' generated=' || attribute.attgenerated::text
			FROM pg_attribute attribute
			JOIN pg_class relation ON relation.oid = attribute.attrelid
			LEFT JOIN pg_attrdef definition ON definition.adrelid = attribute.attrelid AND definition.adnum = attribute.attnum
			WHERE relation.relnamespace = current_schema()::regnamespace AND relation.relkind IN ('r', 'p')
				AND attribute.attnum > 0 AND NOT attribute.attisdropped
			UNION ALL
			SELECT 'constraint ' || relation.relname || ' ' || constraint_row.conname || ' ' || replace(pg_get_constraintdef(constraint_row.oid), current_schema() || '.', '')
			FROM pg_constraint constraint_row
			JOIN pg_class relation ON relation.oid = constraint_row.conrelid
			WHERE relation.relnamespace = current_schema()::regnamespace
			UNION ALL
			SELECT 'index ' || indexes.tablename || ' ' || replace(indexes.indexdef, current_schema() || '.', '')
			FROM pg_indexes indexes
			WHERE indexes.schemaname = current_schema()
			UNION ALL
			SELECT 'policy ' || policies.tablename || ' ' || policies.policyname || ' ' || policies.permissive || ' ' || policies.roles::text
				|| ' ' || policies.cmd || ' ' || COALESCE(policies.qual, '') || ' ' || COALESCE(policies.with_check, '')
			FROM pg_policies policies
			WHERE policies.schemaname = current_schema()
			UNION ALL
			SELECT 'function ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
			FROM pg_proc p
			WHERE p.pronamespace = current_schema()::regnamespace
			UNION ALL
			SELECT 'trigger ' || relation.relname || ' ' || pg_get_triggerdef(trigger_row.oid)
			FROM pg_trigger trigger_row
			JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
			WHERE relation.relnamespace = current_schema()::regnamespace AND NOT trigger_row.tgisinternal
		) facts
		ORDER BY line COLLATE "C"
		""";

	public static async Task<long> CountObjectsAsync(NpgsqlConnection connection) =>
		await connection.ExecuteScalarAsync<long>(ObjectCountSql);

	public static async Task<string> ComputeSignatureAsync(NpgsqlConnection connection)
	{
		var lines = await connection.QueryAsync<string>(SignatureSql);
		return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', lines))));
	}
}
