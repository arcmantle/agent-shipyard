using System.Security.Cryptography;
using System.Text;

namespace AgentLogbook.Core.Identity;

/// <summary>
/// Derives a version-8 style UUID from a namespace and length-prefixed parts: the first 16 bytes of
/// SHA-256 over <c>namespace, 0x00, "&lt;UTF-8 byte length&gt;:&lt;part&gt;"...</c>, with the version and
/// variant bits set.
/// </summary>
internal static class StableIdDerivation
{
	public static string Derive(string identityNamespace, params ReadOnlySpan<string> parts)
	{
		using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
		hash.AppendData(Encoding.UTF8.GetBytes(identityNamespace));
		hash.AppendData([0]);
		foreach (var part in parts)
		{
			ArgumentNullException.ThrowIfNull(part);
			hash.AppendData(Encoding.UTF8.GetBytes($"{Encoding.UTF8.GetByteCount(part)}:{part}"));
		}

		Span<byte> bytes = stackalloc byte[32];
		hash.GetHashAndReset(bytes);
		bytes[6] = (byte)((bytes[6] & 0x0f) | 0x80);
		bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
		return FormatUuid(bytes[..16]);
	}

	public static string FormatUuid(ReadOnlySpan<byte> sixteenBytes)
	{
		var hex = Convert.ToHexStringLower(sixteenBytes);
		return $"{hex[..8]}-{hex[8..12]}-{hex[12..16]}-{hex[16..20]}-{hex[20..]}";
	}
}
