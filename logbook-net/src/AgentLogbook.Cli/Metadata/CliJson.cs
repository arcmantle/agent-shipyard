using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentLogbook.Cli.Metadata;

/// <summary>Writes the JSON that commands print. Keys are camelCase, null members are left out, and line endings are LF on every platform.</summary>
public static class CliJson
{
	private static readonly JsonSerializerOptions Compact = Create(indented: false);
	private static readonly JsonSerializerOptions Pretty = Create(indented: true);

	private static readonly JsonSerializerOptions CompactWithNulls = Create(indented: false, keepNulls: true);
	private static readonly JsonSerializerOptions PrettyWithNulls = Create(indented: true, keepNulls: true);

	/// <summary>Writes <paramref name="value"/>. <paramref name="keepNulls"/> writes a null member as JSON <c>null</c> instead of leaving it out.</summary>
	public static string Serialize<T>(T value, bool pretty, bool keepNulls = false) =>
		JsonSerializer.Serialize(value, (pretty, keepNulls) switch
		{
			(false, false) => Compact,
			(true, false) => Pretty,
			(false, true) => CompactWithNulls,
			(true, true) => PrettyWithNulls,
		}).ReplaceLineEndings("\n");

	private static JsonSerializerOptions Create(bool indented, bool keepNulls = false) => new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		DefaultIgnoreCondition = keepNulls ? JsonIgnoreCondition.Never : JsonIgnoreCondition.WhenWritingNull,
		Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
		WriteIndented = indented,
	};
}
