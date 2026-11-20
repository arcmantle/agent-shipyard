namespace AgentLogbook.Core.Entities;

/// <summary>Trims text the way <c>String.prototype.trim</c> does, so a title has the same hash and the same text in both implementations.</summary>
public static class JavaScriptWhiteSpace
{
	/// <summary>True for the characters that JavaScript counts as white space or as a line terminator.</summary>
	public static bool IsWhiteSpace(char c) => c is '\t' or '\n' or '\v' or '\f' or '\r' or ' ' or '\u00a0' or '\u1680'
		or (>= '\u2000' and <= '\u200a') or '\u2028' or '\u2029' or '\u202f' or '\u205f' or '\u3000' or '\ufeff';

	public static string Trim(string text)
	{
		ArgumentNullException.ThrowIfNull(text);
		var start = 0;
		var end = text.Length;
		while (start < end && IsWhiteSpace(text[start]))
		{
			start++;
		}

		while (end > start && IsWhiteSpace(text[end - 1]))
		{
			end--;
		}

		return text[start..end];
	}
}
