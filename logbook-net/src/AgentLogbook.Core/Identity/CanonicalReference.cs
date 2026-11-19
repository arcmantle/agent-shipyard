using System.Globalization;
using System.Numerics;

namespace AgentLogbook.Core.Identity;

/// <summary>A canonical reference split into its kind and the stable ID that it encodes.</summary>
public sealed record DecodedReference(ReferenceKind Kind, string StableId);

/// <summary>
/// Encodes and decodes canonical references: <c>&lt;PREFIX&gt;_&lt;26 characters of Crockford Base32&gt;</c>, where
/// the 26 characters are the 128 bits of the stable UUID. It also builds the short reference that
/// shows an entity in lists.
/// </summary>
public static class CanonicalReference
{
	private const string Alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	private const int EncodedLength = 26;
	private const char Separator = '_';

	/// <summary>Encodes a stable UUID (with dashes, any letter case) as a canonical reference.</summary>
	/// <exception cref="MalformedReferenceException">The stable ID is not a UUID with dashes.</exception>
	public static string Encode(ReferenceKind kind, string stableId)
	{
		ArgumentNullException.ThrowIfNull(stableId);
		var prefix = ReferenceKinds.ToPrefix(kind);
		var value = ParseUuid(stableId);
		Span<char> encoded = stackalloc char[EncodedLength];
		for (var index = EncodedLength - 1; index >= 0; index--)
		{
			encoded[index] = Alphabet[(int)(value & 31)];
			value >>= 5;
		}

		return string.Concat(prefix, "_", encoded);
	}

	/// <summary>Decodes a canonical reference to its kind and stable UUID.</summary>
	/// <exception cref="MalformedReferenceException">The reference is not a canonical reference.</exception>
	public static DecodedReference Decode(string reference)
	{
		ArgumentNullException.ThrowIfNull(reference);
		if (!string.Equals(reference, reference.ToUpperInvariant(), StringComparison.Ordinal))
		{
			throw new MalformedReferenceException($"Canonical reference must use uppercase Crockford Base32: {reference}");
		}

		ReferenceKind? found = null;
		foreach (var candidate in ReferenceKinds.DecodeOrder)
		{
			if (reference.StartsWith(ReferenceKinds.ToPrefix(candidate), StringComparison.Ordinal))
			{
				found = candidate;
				break;
			}
		}

		if (found is not { } kind)
		{
			throw new MalformedReferenceException($"Invalid canonical reference prefix: {reference}");
		}

		var separatorIndex = ReferenceKinds.ToPrefix(kind).Length;
		if (separatorIndex >= reference.Length || reference[separatorIndex] != Separator)
		{
			throw new MalformedReferenceException($"Canonical reference must separate kind and identity with _: {reference}");
		}

		var encoded = reference[(separatorIndex + 1)..];
		if (encoded.Length != EncodedLength)
		{
			throw new MalformedReferenceException($"Invalid canonical reference length: {reference}");
		}

		BigInteger value = 0;
		for (var index = 0; index < encoded.Length;)
		{
			var width = char.IsHighSurrogate(encoded[index]) && index + 1 < encoded.Length && char.IsLowSurrogate(encoded[index + 1]) ? 2 : 1;
			var digit = width == 1 ? Alphabet.IndexOf(encoded[index], StringComparison.Ordinal) : -1;
			if (digit < 0)
			{
				throw new MalformedReferenceException($"Invalid canonical reference character: {encoded.Substring(index, width)}");
			}

			value = (value << 5) | (uint)digit;
			index += width;
		}

		if (value >> 128 != 0)
		{
			throw new MalformedReferenceException($"Canonical reference exceeds UUID entropy: {reference}");
		}

		var bytes = value.ToByteArray(isUnsigned: true, isBigEndian: true);
		var padded = new byte[16];
		bytes.CopyTo(padded, 16 - bytes.Length);
		return new DecodedReference(kind, StableIdDerivation.FormatUuid(padded));
	}

	/// <summary>
	/// The short reference of an entity: its stored short reference when it has one, otherwise the kind
	/// prefix and six characters of a 32-bit FNV-1a hash of the ID. An unknown kind uses its first four
	/// letters in upper case as the prefix.
	/// </summary>
	public static string ShortReference(string id, string kind, string? storedShortReference = null)
	{
		ArgumentNullException.ThrowIfNull(id);
		ArgumentNullException.ThrowIfNull(kind);
		if (!string.IsNullOrEmpty(storedShortReference))
		{
			return storedShortReference;
		}

		var known = ReferenceKinds.FromWireName(kind);
		var prefix = known is { } referenceKind
			? ReferenceKinds.ToPrefix(referenceKind)
			: (kind.Length > 4 ? kind[..4] : kind).ToUpperInvariant();

		var hash = 0x811c9dc5u;
		foreach (var unit in id)
		{
			hash ^= unit;
			hash = unchecked(hash * 0x01000193u);
		}

		Span<char> code = stackalloc char[6];
		for (var index = 5; index >= 0; index--)
		{
			code[index] = Alphabet[(int)(hash & 31)];
			hash >>= 5;
		}

		return string.Concat(prefix, "_", code);
	}

	/// <summary>Whether a selector names one record directly: a stable UUID or a canonical reference.</summary>
	public static bool IsDirectEntitySelector(string selector)
	{
		ArgumentNullException.ThrowIfNull(selector);
		if (IsUuid(selector))
		{
			return true;
		}

		try
		{
			_ = Decode(selector);
			return true;
		}
		catch (MalformedReferenceException)
		{
			return false;
		}
	}

	private static BigInteger ParseUuid(string stableId)
	{
		if (!IsUuid(stableId))
		{
			throw new MalformedReferenceException($"Invalid stable UUID: {stableId}");
		}

		return BigInteger.Parse("0" + stableId.Replace("-", "", StringComparison.Ordinal), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture);
	}

	private static bool IsUuid(string text)
	{
		if (text.Length != 36)
		{
			return false;
		}

		for (var index = 0; index < text.Length; index++)
		{
			var character = text[index];
			var isDash = index is 8 or 13 or 18 or 23;
			if (isDash ? character != '-' : !char.IsAsciiHexDigit(character))
			{
				return false;
			}
		}

		return true;
	}
}
