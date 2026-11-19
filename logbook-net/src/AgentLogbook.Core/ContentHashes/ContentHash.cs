using System.Security.Cryptography;
using System.Text;
using AgentLogbook.Core.Json;

namespace AgentLogbook.Core.ContentHashes;

/// <summary>
/// Computes the literal content hashes of the retained record contract: lower-case SHA-256 hex
/// of the UTF-8 bytes of a fixed input text. Entity and context hashes hash
/// <c>title + "\n\n" + body</c>. The other record kinds hash a compact JSON object with a fixed
/// property order, written the way <c>JSON.stringify</c> writes it. Null and absent values are
/// rejected; only the plan entry scope direction may be null, and it is written as JSON null.
/// </summary>
public static class ContentHash
{
	/// <summary>Hash of an entity title and body.</summary>
	public static string ForEntity(string title, string body)
	{
		ArgumentNullException.ThrowIfNull(title);
		ArgumentNullException.ThrowIfNull(body);
		return Sha256Hex(string.Concat(title, "\n\n", body));
	}

	/// <summary>Hash of a context title and summary.</summary>
	public static string ForContext(string title, string summary)
	{
		ArgumentNullException.ThrowIfNull(title);
		ArgumentNullException.ThrowIfNull(summary);
		return Sha256Hex(string.Concat(title, "\n\n", summary));
	}

	/// <summary>Hash of a context term. The order of <paramref name="avoid"/> is part of the hash.</summary>
	public static string ForContextTerm(string term, string definition, IReadOnlyList<string> avoid, bool tombstone)
	{
		ArgumentNullException.ThrowIfNull(term);
		ArgumentNullException.ThrowIfNull(definition);
		ArgumentNullException.ThrowIfNull(avoid);

		var json = new StringBuilder("{");
		JavaScriptJson.AppendString(json.Append("\"term\":"), term);
		JavaScriptJson.AppendString(json.Append(",\"definition\":"), definition);
		AppendStringArray(json.Append(",\"avoid\":"), avoid);
		AppendBool(json.Append(",\"tombstone\":"), tombstone);
		return Sha256Hex(json.Append('}').ToString());
	}

	/// <summary>Hash of an issue comment.</summary>
	public static string ForIssueComment(string body, IReadOnlyList<string> referencedIssueIds, bool tombstone)
	{
		ArgumentNullException.ThrowIfNull(body);
		ArgumentNullException.ThrowIfNull(referencedIssueIds);

		var json = new StringBuilder("{");
		JavaScriptJson.AppendString(json.Append("\"body\":"), body);
		AppendStringArray(json.Append(",\"referencedIssueIds\":"), referencedIssueIds);
		AppendBool(json.Append(",\"tombstone\":"), tombstone);
		return Sha256Hex(json.Append('}').ToString());
	}

	/// <summary>Hash of a Plan entry. <paramref name="scopeDirection"/> may be null.</summary>
	public static string ForPlanEntry(
		string role,
		string body,
		string? scopeDirection,
		IReadOnlyList<string> referencedEntityIds,
		IReadOnlyList<string> supersededEntryIds,
		bool tombstone)
	{
		ArgumentNullException.ThrowIfNull(role);
		ArgumentNullException.ThrowIfNull(body);
		ArgumentNullException.ThrowIfNull(referencedEntityIds);
		ArgumentNullException.ThrowIfNull(supersededEntryIds);

		var json = new StringBuilder("{");
		JavaScriptJson.AppendString(json.Append("\"role\":"), role);
		JavaScriptJson.AppendString(json.Append(",\"body\":"), body);
		json.Append(",\"scopeDirection\":");
		if (scopeDirection is null)
		{
			json.Append("null");
		}
		else
		{
			JavaScriptJson.AppendString(json, scopeDirection);
		}

		AppendStringArray(json.Append(",\"referencedEntityIds\":"), referencedEntityIds);
		AppendStringArray(json.Append(",\"supersededEntryIds\":"), supersededEntryIds);
		AppendBool(json.Append(",\"tombstone\":"), tombstone);
		return Sha256Hex(json.Append('}').ToString());
	}

	// Lone surrogates become U+FFFD here, the same as the TypeScript UTF-8 conversion.
	private static string Sha256Hex(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

	private static void AppendBool(StringBuilder json, bool value) => json.Append(value ? "true" : "false");

	private static void AppendStringArray(StringBuilder json, IReadOnlyList<string> values)
	{
		json.Append('[');
		for (var i = 0; i < values.Count; i++)
		{
			if (i > 0)
			{
				json.Append(',');
			}

			JavaScriptJson.AppendString(json, values[i] ?? throw new ArgumentException("A list item is null.", nameof(values)));
		}

		json.Append(']');
	}
}
