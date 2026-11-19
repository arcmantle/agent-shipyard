namespace AgentLogbook.Core.RevisionLedger;

/// <summary>Unsigned base-128 integers of the reverse patch formats.</summary>
internal static class Varint
{
	public const string UnterminatedMessage = "Malformed reverse text patch: unterminated length.";

	public static void Write(List<byte> output, long value)
	{
		do
		{
			var next = (byte)(value % 128);
			value /= 128;
			output.Add(value == 0 ? next : (byte)(next | 0x80));
		}
		while (value > 0);
	}

	/// <summary>
	/// Reads one value. A value above <see cref="long.MaxValue"/> saturates, so the caller's range
	/// check rejects it the same way as any other length that is too large.
	/// </summary>
	public static long Read(ReadOnlySpan<byte> bytes, ref int offset)
	{
		long value = 0;
		var overflow = false;
		for (var shift = 0; offset < bytes.Length; shift += 7)
		{
			var b = bytes[offset++];
			var part = (long)(b & 0x7f);
			if (shift >= 63 ? part != 0 : (part << shift) >> shift != part || value > long.MaxValue - (part << shift))
			{
				overflow = true;
			}
			else if (shift < 63)
			{
				value += part << shift;
			}

			if ((b & 0x80) == 0)
			{
				return overflow ? long.MaxValue : value;
			}
		}

		throw new ReversePatchException(UnterminatedMessage);
	}
}
