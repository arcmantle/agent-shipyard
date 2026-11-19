using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace AgentLogbook.Cli.Metadata;

/// <summary>Writes the JSON that commands print. Keys are camelCase, null members are left out, and line endings are LF on every platform.</summary>
public static class CliJson
{
	private static readonly JsonSerializerOptions Compact = Create(indented: false);
	private static readonly JsonSerializerOptions Pretty = Create(indented: true);

	public static string Serialize<T>(T value, bool pretty) =>
		JsonSerializer.Serialize(value, pretty ? Pretty : Compact).ReplaceLineEndings("\n");

	private static JsonSerializerOptions Create(bool indented) => new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
		DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
		Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
		WriteIndented = indented,
	};
}
