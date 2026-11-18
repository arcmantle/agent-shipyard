using System.Text;

namespace AgentLogbook.Core.ProjectIdentity;

public static class PathSegment
{
	/// <summary>
	/// Lower-cases the value, keeps ASCII letters and digits, and joins the runs with one hyphen.
	/// A value with no letter or digit gives an empty string.
	/// </summary>
	public static string Sanitize(string value)
	{
		// JavaScript lower-cases U+0130 to "i" plus a combining mark; the mark is then dropped.
		var lower = value.Replace("İ", "i", StringComparison.Ordinal).ToLowerInvariant();
		var result = new StringBuilder(lower.Length);
		var pendingSeparator = false;

		foreach (var character in lower)
		{
			if (character is (>= 'a' and <= 'z') or (>= '0' and <= '9'))
			{
				if (pendingSeparator && result.Length > 0)
				{
					result.Append('-');
				}

				pendingSeparator = false;
				result.Append(character);
			}
			else
			{
				pendingSeparator = true;
			}
		}

		return result.ToString();
	}
}
