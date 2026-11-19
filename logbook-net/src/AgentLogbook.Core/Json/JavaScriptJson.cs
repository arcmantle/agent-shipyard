using System.Text;

namespace AgentLogbook.Core.Json;

/// <summary>JSON text writing that matches <c>JSON.stringify</c> byte for byte.</summary>
internal static class JavaScriptJson
{
	/// <summary>Appends a JSON string literal with the escapes of <c>JSON.stringify</c>.</summary>
	// Same escapes as JSON.stringify: quote, backslash, the short control escapes, other control
	// characters as lower-case \u00xx, and lone surrogates as lower-case \udxxx. Nothing else is escaped.
	internal static void AppendString(StringBuilder json, string value)
	{
		json.Append('"');
		for (var i = 0; i < value.Length; i++)
		{
			var c = value[i];
			switch (c)
			{
				case '"': json.Append("\\\""); break;
				case '\\': json.Append("\\\\"); break;
				case '\b': json.Append("\\b"); break;
				case '\f': json.Append("\\f"); break;
				case '\n': json.Append("\\n"); break;
				case '\r': json.Append("\\r"); break;
				case '\t': json.Append("\\t"); break;
				case < ' ':
					AppendUnicodeEscape(json, c);
					break;
				default:
					if (char.IsHighSurrogate(c) && i + 1 < value.Length && char.IsLowSurrogate(value[i + 1]))
					{
						json.Append(c).Append(value[++i]);
					}
					else if (char.IsSurrogate(c))
					{
						AppendUnicodeEscape(json, c);
					}
					else
					{
						json.Append(c);
					}

					break;
			}
		}

		json.Append('"');
	}

	private static void AppendUnicodeEscape(StringBuilder json, char c) => json.Append("\\u").Append(((int)c).ToString("x4", System.Globalization.CultureInfo.InvariantCulture));
}
