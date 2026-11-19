using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using AgentLogbook.Core.Json;

namespace AgentLogbook.Core.RevisionLedger;

/// <summary>One stored reverse field patch with the hashes of the two record states it connects.</summary>
public sealed record ReverseFieldPatchTransition(int PatchFormat, byte[] ReversePatch, string SourceHash, string TargetHash);

/// <summary>
/// Reverse field patches over record states. A state is a JSON object. A field that the state does
/// not have is absent, which is not the same as a field with the value null. Field values are
/// strings, booleans, null and arrays of those values; numbers and objects are not supported.
/// Differences from the TypeScript code, all outside real record data: text fields must be strings
/// (TypeScript turns null into the text "null"), a leading byte order mark in restored text is kept
/// (TypeScript drops it and then fails the target hash check), and the value and UTF-8 failures
/// have their own messages.
/// </summary>
/// <remarks>
/// Patch bytes: for each changed field in registry order, the field identifier (base-128), the
/// encoding (1 reverse text patch, 2 compact JSON of the prior value), the payload length
/// (base-128) and the payload.
/// </remarks>
public static class ReverseFieldPatch
{
	public const int CurrentPatchFormat = 1;

	private const byte TextEncoding = 1;
	private const byte ValueEncoding = 2;

	private static readonly Encoding StrictUtf8 = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

	/// <summary>Computes the hash of the registry fields of a state. An absent field counts as null.</summary>
	public static string ComputeCanonicalStateHash(JsonObject state, IReadOnlyList<ReversePatchField> registry)
	{
		ArgumentNullException.ThrowIfNull(state);
		ArgumentNullException.ThrowIfNull(registry);

		var json = new StringBuilder("[");
		for (var i = 0; i < registry.Count; i++)
		{
			if (i > 0)
			{
				json.Append(',');
			}

			json.Append('[').Append(registry[i].Id).Append(',');
			AppendValue(json, state.TryGetPropertyValue(registry[i].Key, out var value) ? value : null);
			json.Append(']');
		}

		json.Append(']');
		return Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(json.ToString())));
	}

	/// <summary>Creates the transition that turns <paramref name="successor"/> back into <paramref name="predecessor"/>.</summary>
	/// <exception cref="ArgumentException">
	/// A text field is not a string, a value is not supported, or a changed field is absent in the predecessor.
	/// </exception>
	public static ReverseFieldPatchTransition Create(JsonObject successor, JsonObject predecessor, IReadOnlyList<ReversePatchField> registry)
	{
		ArgumentNullException.ThrowIfNull(successor);
		ArgumentNullException.ThrowIfNull(predecessor);
		ArgumentNullException.ThrowIfNull(registry);

		var output = new List<byte>();
		foreach (var field in registry)
		{
			var hasSuccessor = successor.TryGetPropertyValue(field.Key, out var successorValue);
			var hasPredecessor = predecessor.TryGetPropertyValue(field.Key, out var predecessorValue);
			if (hasSuccessor == hasPredecessor && (!hasSuccessor || Stringify(successorValue) == Stringify(predecessorValue)))
			{
				continue;
			}

			if (!hasPredecessor)
			{
				throw new ArgumentException($"The predecessor has no field '{field.Key}' to restore.", nameof(predecessor));
			}

			byte[] payload;
			if (field.Kind == ReversePatchFieldKind.Text)
			{
				payload = ReverseTextPatch.Create(TextOf(successorValue, field, nameof(successor)), TextOf(predecessorValue, field, nameof(predecessor)));
			}
			else
			{
				payload = Encoding.UTF8.GetBytes(Stringify(predecessorValue));
			}

			Varint.Write(output, field.Id);
			output.Add(field.Kind == ReversePatchFieldKind.Text ? TextEncoding : ValueEncoding);
			Varint.Write(output, payload.Length);
			output.AddRange(payload);
		}

		return new ReverseFieldPatchTransition(
			CurrentPatchFormat,
			[.. output],
			ComputeCanonicalStateHash(successor, registry),
			ComputeCanonicalStateHash(predecessor, registry));
	}

	/// <summary>
	/// Reconstructs the predecessor state. The successor is not changed. Fields outside the patch,
	/// including fields outside the registry, are copied as they are.
	/// </summary>
	/// <exception cref="ReversePatchException">
	/// The format is unsupported, the hash chain is broken, or the patch is malformed.
	/// </exception>
	public static JsonObject Apply(JsonObject successor, ReverseFieldPatchTransition transition, IReadOnlyList<ReversePatchField> registry)
	{
		ArgumentNullException.ThrowIfNull(successor);
		ArgumentNullException.ThrowIfNull(transition);
		ArgumentNullException.ThrowIfNull(registry);

		if (transition.PatchFormat != CurrentPatchFormat)
		{
			throw new ReversePatchException($"Unsupported reverse field patch format {transition.PatchFormat}.");
		}

		if (HashOfStateToApply(successor, registry) != transition.SourceHash)
		{
			throw new ReversePatchException("Broken reverse field patch chain: source hash mismatch.");
		}

		var patch = transition.ReversePatch;
		var predecessor = (JsonObject)successor.DeepClone();
		var applied = new HashSet<long>();
		var offset = 0;
		while (offset < patch.Length)
		{
			var fieldId = Varint.Read(patch, ref offset);
			if (!applied.Add(fieldId))
			{
				throw new ReversePatchException($"Malformed reverse field patch: duplicate field {fieldId}.");
			}

			// The encoding byte and the length need one more byte; a patch that ends here has no length.
			if (offset >= patch.Length)
			{
				throw new ReversePatchException(Varint.UnterminatedMessage);
			}

			var encoding = patch[offset++];
			var length = Varint.Read(patch, ref offset);
			if (length > patch.Length - offset)
			{
				throw new ReversePatchException("Malformed reverse field patch: payload is out of range.");
			}

			var field = registry.FirstOrDefault(f => f.Id == fieldId)
				?? throw new ReversePatchException($"Malformed reverse field patch: unknown field {fieldId}.");
			var payload = patch.AsSpan(offset, (int)length);
			predecessor[field.Key] = encoding switch
			{
				TextEncoding => JsonValue.Create(ReverseTextPatch.Apply(CurrentText(predecessor, field), payload)),
				ValueEncoding => ParseValue(payload),
				_ => throw new ReversePatchException($"Malformed reverse field patch: unknown encoding {encoding}."),
			};
			offset += (int)length;
		}

		if (HashOfStateToApply(predecessor, registry) != transition.TargetHash)
		{
			throw new ReversePatchException("Broken reverse field patch chain: target hash mismatch.");
		}

		return predecessor;
	}

	private static string HashOfStateToApply(JsonObject state, IReadOnlyList<ReversePatchField> registry)
	{
		try
		{
			return ComputeCanonicalStateHash(state, registry);
		}
		catch (Exception e) when (e is ArgumentException or InvalidOperationException)
		{
			throw new ReversePatchException("Malformed reverse field patch: a field value is not supported.");
		}
	}

	private static string TextOf(JsonNode? value, ReversePatchField field, string parameter) =>
		value is JsonValue json && json.TryGetValue<string>(out var text)
			? text
			: throw new ArgumentException($"The text field '{field.Key}' is not a string.", parameter);

	private static string CurrentText(JsonObject state, ReversePatchField field) =>
		state[field.Key] is JsonValue json && json.TryGetValue<string>(out var text)
			? text
			: throw new ReversePatchException($"Malformed reverse field patch: field {field.Id} is not text.");

	private static JsonNode? ParseValue(ReadOnlySpan<byte> payload)
	{
		JsonNode? value;
		try
		{
			value = JsonNode.Parse(StrictUtf8.GetString(payload));
		}
		catch (Exception e) when (e is JsonException or DecoderFallbackException)
		{
			throw new ReversePatchException("Malformed reverse field patch: the value is not valid JSON.");
		}

		if (!IsSupported(value))
		{
			throw new ReversePatchException("Malformed reverse field patch: the value is not supported.");
		}

		return value;
	}

	private static bool IsSupported(JsonNode? value) => value switch
	{
		null => true,
		JsonArray array => array.All(IsSupported),
		_ => value.GetValueKind() switch
		{
			JsonValueKind.True or JsonValueKind.False => true,
			JsonValueKind.String => IsReadableString(value),
			_ => false,
		},
	};

	// A JSON escape for a lone surrogate parses, but the text cannot be read back as a .NET string.
	private static bool IsReadableString(JsonNode value)
	{
		try
		{
			_ = value.GetValue<string>();
			return true;
		}
		catch (InvalidOperationException)
		{
			return false;
		}
	}

	// Absent values do not reach this: the callers test presence first.
	private static string Stringify(JsonNode? value)
	{
		var json = new StringBuilder();
		AppendValue(json, value);
		return json.ToString();
	}

	private static void AppendValue(StringBuilder json, JsonNode? value)
	{
		switch (value)
		{
			case null:
				json.Append("null");
				break;
			case JsonArray array:
				json.Append('[');
				for (var i = 0; i < array.Count; i++)
				{
					if (i > 0)
					{
						json.Append(',');
					}

					AppendValue(json, array[i]);
				}

				json.Append(']');
				break;
			default:
				switch (value.GetValueKind())
				{
					case JsonValueKind.String:
						JavaScriptJson.AppendString(json, value.GetValue<string>());
						break;
					case JsonValueKind.True:
						json.Append("true");
						break;
					case JsonValueKind.False:
						json.Append("false");
						break;
					default:
						throw new ArgumentException("A field value is not a string, boolean, null or array.");
				}

				break;
		}
	}
}
