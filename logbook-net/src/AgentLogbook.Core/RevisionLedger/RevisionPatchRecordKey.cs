using System.Globalization;
using System.Text;

namespace AgentLogbook.Core.RevisionLedger;

/// <summary>
/// Formats and parses revision patch record keys: <c>&lt;UTF-8 byte length&gt;:&lt;value&gt;</c>.
/// The stored key format is the same for every record kind.
/// </summary>
public static class RevisionPatchRecordKey
{
	private const byte Separator = (byte)':';

	private static readonly Encoding StrictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

	/// <summary>Encodes the identifying value of one record as a record key.</summary>
	public static string Encode(RevisionPatchRecordKind kind, string value)
	{
		ArgumentNullException.ThrowIfNull(value);
		ValidateKind(kind);
		var length = Encoding.UTF8.GetByteCount(value);
		return string.Create(CultureInfo.InvariantCulture, $"{length}:{value}");
	}

	/// <summary>Decodes a record key to the identifying value of one record.</summary>
	/// <exception cref="MalformedRecordKeyException">The key is not exactly one valid length-prefixed value.</exception>
	public static string Decode(RevisionPatchRecordKind kind, string recordKey)
	{
		ArgumentNullException.ThrowIfNull(recordKey);
		ValidateKind(kind);

		var bytes = Encoding.UTF8.GetBytes(recordKey);
		var separator = Array.IndexOf(bytes, Separator);
		if (separator < 0)
		{
			throw new MalformedRecordKeyException();
		}

		var length = ParseLength(bytes.AsSpan(0, separator));
		var valueStart = separator + 1;
		if (length > bytes.Length - valueStart)
		{
			throw new MalformedRecordKeyException();
		}

		if (valueStart + length != bytes.Length)
		{
			throw new MalformedRecordKeyException();
		}

		try
		{
			return StrictUtf8.GetString(bytes, valueStart, (int)length);
		}
		catch (DecoderFallbackException)
		{
			throw new MalformedRecordKeyException();
		}
	}

	private static long ParseLength(ReadOnlySpan<byte> digits)
	{
		if (digits.IsEmpty || (digits.Length > 1 && digits[0] == (byte)'0'))
		{
			throw new MalformedRecordKeyException();
		}

		long length = 0;
		foreach (var digit in digits)
		{
			if (digit is < (byte)'0' or > (byte)'9')
			{
				throw new MalformedRecordKeyException();
			}

			try
			{
				length = checked((length * 10) + (digit - (byte)'0'));
			}
			catch (OverflowException)
			{
				throw new MalformedRecordKeyException();
			}
		}

		return length;
	}

	private static void ValidateKind(RevisionPatchRecordKind kind)
	{
		if (!Enum.IsDefined(kind))
		{
			throw new ArgumentOutOfRangeException(nameof(kind), kind, "Unknown revision patch record kind.");
		}
	}
}
