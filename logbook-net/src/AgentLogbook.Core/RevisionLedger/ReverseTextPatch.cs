using System.Text;

namespace AgentLogbook.Core.RevisionLedger;

/// <summary>
/// The reverse text patch: bytes that turn a successor text back into its predecessor text.
/// Format: one version byte (1), then copy (1), skip (2), insert (3) or replace (4) operations,
/// each as an opcode and a base-128 length. Insert and replace carry that many UTF-8 bytes.
/// </summary>
public static class ReverseTextPatch
{
	private const byte FormatVersion = 1;
	private const byte CopyOpcode = 1;
	private const byte SkipOpcode = 2;
	private const byte InsertOpcode = 3;
	private const byte ReplaceOpcode = 4;

	// A lone surrogate becomes U+FFFD in the bytes, the same as the TypeScript text encoder.
	private static readonly Encoding Utf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false);

	private static readonly Encoding StrictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

	/// <summary>Creates the patch that turns <paramref name="successor"/> back into <paramref name="predecessor"/>.</summary>
	public static byte[] Create(string successor, string predecessor)
	{
		ArgumentNullException.ThrowIfNull(successor);
		ArgumentNullException.ThrowIfNull(predecessor);

		var successorPoints = CodePoints(successor);
		var predecessorPoints = CodePoints(predecessor);

		var prefix = 0;
		while (prefix < successorPoints.Count
			&& prefix < predecessorPoints.Count
			&& successorPoints[prefix].Value == predecessorPoints[prefix].Value)
		{
			prefix++;
		}

		var suffix = 0;
		while (suffix < successorPoints.Count - prefix
			&& suffix < predecessorPoints.Count - prefix
			&& successorPoints[^(suffix + 1)].Value == predecessorPoints[^(suffix + 1)].Value)
		{
			suffix++;
		}

		var prefixBytes = Slice(successor, successorPoints, 0, prefix);
		var removed = Slice(successor, successorPoints, prefix, successorPoints.Count - suffix);
		var inserted = Slice(predecessor, predecessorPoints, prefix, predecessorPoints.Count - suffix);
		var suffixBytes = Slice(successor, successorPoints, successorPoints.Count - suffix, successorPoints.Count);

		var output = new List<byte> { FormatVersion };
		if (prefixBytes.Length > 0)
		{
			WriteOperation(output, CopyOpcode, prefixBytes.Length, []);
		}

		if (removed.Length > 0)
		{
			WriteOperation(output, SkipOpcode, removed.Length, []);
		}

		if (inserted.Length > 0)
		{
			WriteOperation(output, InsertOpcode, inserted.Length, inserted);
		}

		if (suffixBytes.Length > 0)
		{
			WriteOperation(output, CopyOpcode, suffixBytes.Length, []);
		}

		var predecessorBytes = Utf8.GetBytes(predecessor);
		var replacement = new List<byte> { FormatVersion };
		WriteOperation(replacement, ReplaceOpcode, predecessorBytes.Length, predecessorBytes);

		return [.. replacement.Count < output.Count ? replacement : output];
	}

	/// <summary>Applies a patch to the successor text and returns the predecessor text.</summary>
	/// <exception cref="ReversePatchException">The patch has an unsupported format or is malformed.</exception>
	public static string Apply(string successor, ReadOnlySpan<byte> patch)
	{
		ArgumentNullException.ThrowIfNull(successor);
		if (patch.IsEmpty || patch[0] != FormatVersion)
		{
			throw new ReversePatchException("Unsupported reverse text patch format.");
		}

		var source = Utf8.GetBytes(successor);
		var output = new List<byte>();
		var sourceOffset = 0;
		var patchOffset = 1;
		while (patchOffset < patch.Length)
		{
			var opcode = patch[patchOffset++];
			var length = Varint.Read(patch, ref patchOffset);
			switch (opcode)
			{
				case CopyOpcode or SkipOpcode:
					if (length > source.Length - sourceOffset)
					{
						throw new ReversePatchException("Malformed reverse text patch: source read is out of range.");
					}

					var end = sourceOffset + (int)length;
					if (!IsUtf8Boundary(source, sourceOffset) || !IsUtf8Boundary(source, end))
					{
						throw new ReversePatchException("Malformed reverse text patch: operation splits a UTF-8 boundary.");
					}

					if (opcode == CopyOpcode)
					{
						output.AddRange(source.AsSpan(sourceOffset, end - sourceOffset));
					}

					sourceOffset = end;
					break;
				case InsertOpcode:
					if (length > patch.Length - patchOffset)
					{
						throw new ReversePatchException("Malformed reverse text patch: inserted bytes are out of range.");
					}

					output.AddRange(patch.Slice(patchOffset, (int)length));
					patchOffset += (int)length;
					break;
				case ReplaceOpcode:
					if (length != patch.Length - patchOffset)
					{
						throw new ReversePatchException("Malformed reverse text patch: replacement bytes are out of range.");
					}

					return Decode(patch[patchOffset..]);
				default:
					throw new ReversePatchException($"Malformed reverse text patch: unknown opcode {opcode}.");
			}
		}

		if (sourceOffset != source.Length)
		{
			throw new ReversePatchException("Malformed reverse text patch: source bytes were not fully consumed.");
		}

		return Decode([.. output]);
	}

	private static string Decode(ReadOnlySpan<byte> bytes)
	{
		try
		{
			return StrictUtf8.GetString(bytes);
		}
		catch (DecoderFallbackException)
		{
			throw new ReversePatchException("Malformed reverse text patch: the result is not valid UTF-8.");
		}
	}

	private static void WriteOperation(List<byte> output, byte opcode, int length, byte[] bytes)
	{
		output.Add(opcode);
		Varint.Write(output, length);
		output.AddRange(bytes);
	}

	private static bool IsUtf8Boundary(byte[] bytes, int offset) =>
		offset == 0 || offset == bytes.Length || (bytes[offset] & 0xc0) != 0x80;

	private static byte[] Slice(string text, List<(int Start, int Value)> points, int from, int to)
	{
		var start = from < points.Count ? points[from].Start : text.Length;
		var end = to < points.Count ? points[to].Start : text.Length;
		return Utf8.GetBytes(text.Substring(start, end - start));
	}

	// One entry for each code point, as Array.from(text) splits a string. A lone surrogate is one entry
	// that keeps its own value, so two different lone surrogates stay different.
	private static List<(int Start, int Value)> CodePoints(string text)
	{
		var points = new List<(int, int)>(text.Length);
		for (var i = 0; i < text.Length; i++)
		{
			if (char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]))
			{
				points.Add((i, char.ConvertToUtf32(text[i], text[i + 1])));
				i++;
			}
			else
			{
				points.Add((i, text[i]));
			}
		}

		return points;
	}
}
