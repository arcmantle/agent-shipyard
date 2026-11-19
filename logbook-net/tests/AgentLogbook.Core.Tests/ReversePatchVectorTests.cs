using System.Text.Json;
using System.Text.Json.Nodes;
using AgentLogbook.Core.RevisionLedger;

namespace AgentLogbook.Core.Tests;

public class ReversePatchVectorTests
{
	private static readonly Lazy<IReadOnlyList<JsonElement>> PatchVectors = new(() => Load("reverse-patches.json"));

	private static readonly string[] RegistryNames = ["context", "context-term", "entity", "issue-comment", "plan-entry"];

	private static readonly Lazy<IReadOnlyList<JsonElement>> HashVectors = new(() => Load("content-hashes.json"));

	public static IEnumerable<(int Index, string Name)> TextCreateVectors() => Select(PatchVectors, "reverse-text-patch");

	public static IEnumerable<(int Index, string Name)> TextApplyVectors() => Select(PatchVectors, "apply-reverse-text-patch");

	public static IEnumerable<(int Index, string Name)> FieldCreateVectors() => Select(PatchVectors, "reverse-field-patch");

	public static IEnumerable<(int Index, string Name)> FieldApplyVectors() => Select(PatchVectors, "apply-reverse-field-patch");

	public static IEnumerable<(int Index, string Name)> StateHashVectors() => Select(HashVectors, "canonical-state-hash");

	[Test]
	[MethodDataSource(nameof(TextCreateVectors))]
	public async Task Text_patch_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var input = PatchVectors.Value[index].GetProperty("input");
		var value = PatchVectors.Value[index].GetProperty("expected").GetProperty("value");
		var successor = input.GetProperty("successor").GetString()!;

		var patch = ReverseTextPatch.Create(successor, input.GetProperty("predecessor").GetString()!);

		await Assert.That(Convert.ToHexStringLower(patch)).IsEqualTo(value.GetProperty("patch").GetString());
		await Assert.That(ReverseTextPatch.Apply(successor, patch)).IsEqualTo(value.GetProperty("applied").GetString());
	}

	[Test]
	[MethodDataSource(nameof(TextApplyVectors))]
	public async Task Text_patch_application_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var vector = PatchVectors.Value[index];
		var input = vector.GetProperty("input");
		var successor = input.GetProperty("successor").GetString()!;
		var patch = Convert.FromHexString(input.GetProperty("patch").GetString()!);
		var expected = vector.GetProperty("expected");

		if (expected.TryGetProperty("error", out var error))
		{
			var thrown = Assert.Throws<ReversePatchException>(() => ReverseTextPatch.Apply(successor, patch));
			await Assert.That(thrown.Message).IsEqualTo(error.GetString());
			return;
		}

		await Assert.That(ReverseTextPatch.Apply(successor, patch)).IsEqualTo(expected.GetProperty("value").GetString());
	}

	[Test]
	[MethodDataSource(nameof(FieldCreateVectors))]
	public async Task Field_patch_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var input = PatchVectors.Value[index].GetProperty("input");
		var value = PatchVectors.Value[index].GetProperty("expected").GetProperty("value");
		var registry = RegistryOf(input);
		var successor = StateOf(input, "successor");

		var transition = ReverseFieldPatch.Create(successor, StateOf(input, "predecessor"), registry);

		await Assert.That(transition.PatchFormat).IsEqualTo(value.GetProperty("patchFormat").GetInt32());
		await Assert.That(Convert.ToHexStringLower(transition.ReversePatch)).IsEqualTo(value.GetProperty("reversePatch").GetString());
		await Assert.That(transition.SourceHash).IsEqualTo(value.GetProperty("sourceHash").GetString());
		await Assert.That(transition.TargetHash).IsEqualTo(value.GetProperty("targetHash").GetString());

		var applied = ReverseFieldPatch.Apply(successor, transition, registry);
		await Assert.That(JsonNode.DeepEquals(applied, JsonNode.Parse(value.GetProperty("applied").GetRawText()))).IsTrue();
	}

	[Test]
	[MethodDataSource(nameof(FieldApplyVectors))]
	public async Task Field_patch_application_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var vector = PatchVectors.Value[index];
		var input = vector.GetProperty("input");
		var transition = new ReverseFieldPatchTransition(
			input.GetProperty("patchFormat").GetInt32(),
			Convert.FromHexString(input.GetProperty("reversePatch").GetString()!),
			input.GetProperty("sourceHash").GetString()!,
			input.GetProperty("targetHash").GetString()!);
		var successor = StateOf(input, "successor");
		var registry = RegistryOf(input);

		var thrown = Assert.Throws<ReversePatchException>(() => ReverseFieldPatch.Apply(successor, transition, registry));

		await Assert.That(thrown.Message).IsEqualTo(vector.GetProperty("expected").GetProperty("error").GetString());
	}

	[Test]
	[MethodDataSource(nameof(StateHashVectors))]
	public async Task Canonical_state_hash_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var vector = HashVectors.Value[index];
		var input = vector.GetProperty("input");

		var hash = ReverseFieldPatch.ComputeCanonicalStateHash(StateOf(input, "state"), RegistryOf(input));

		await Assert.That(hash).IsEqualTo(vector.GetProperty("expected").GetProperty("value").GetString());
	}

	[Test]
	public async Task The_vector_file_covers_every_patch_behavior_and_registry()
	{
		foreach (var behavior in new[] { "reverse-text-patch", "apply-reverse-text-patch", "reverse-field-patch", "apply-reverse-field-patch" })
		{
			await Assert.That(Select(PatchVectors, behavior).Any()).IsTrue();
		}

		var registries = Select(PatchVectors, "reverse-field-patch")
			.Select(v => PatchVectors.Value[v.Index].GetProperty("input").GetProperty("registry").GetString()!)
			.Distinct()
			.Order()
			.ToArray();
		await Assert.That(registries).IsEquivalentTo(RegistryNames);
	}

	[Test]
	public async Task Applying_a_patch_does_not_change_the_successor()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.IssueComment);
		var successor = Obj("""{"body":"b2","referencedIssueIds":["x"],"tombstone":true,"extra":1}""");
		var predecessor = Obj("""{"body":"b1","referencedIssueIds":[],"tombstone":false,"extra":1}""");
		var before = successor.ToJsonString();

		var applied = ReverseFieldPatch.Apply(successor, ReverseFieldPatch.Create(successor, predecessor, registry), registry);

		await Assert.That(successor.ToJsonString()).IsEqualTo(before);
		await Assert.That(applied.ToJsonString()).IsEqualTo(predecessor.ToJsonString());
	}

	[Test]
	public async Task Array_order_is_part_of_the_value()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.ContextTerm);
		var successor = Obj("""{"term":"t","definition":"d","avoid":["b","a"],"tombstone":false}""");
		var predecessor = Obj("""{"term":"t","definition":"d","avoid":["a","b"],"tombstone":false}""");

		var transition = ReverseFieldPatch.Create(successor, predecessor, registry);

		await Assert.That(Convert.ToHexStringLower(transition.ReversePatch)).IsEqualTo("0202095b2261222c2262225d");
		await Assert.That(ReverseFieldPatch.Apply(successor, transition, registry).ToJsonString()).IsEqualTo(predecessor.ToJsonString());
	}

	[Test]
	public async Task Null_and_absent_are_different_values_and_a_string_is_not_its_text()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Entity);
		var withNull = Obj("""{"title":"T","body":"B","parentId":null}""");
		var absent = Obj("""{"title":"T","body":"B"}""");
		var withText = Obj("""{"title":"T","body":"B","parentId":"null"}""");

		// Absent in the successor, null in the predecessor: a change, restored as an explicit null.
		var restoreNull = ReverseFieldPatch.Create(absent, withNull, registry);
		await Assert.That(Convert.ToHexStringLower(restoreNull.ReversePatch)).IsEqualTo("0502046e756c6c");
		await Assert.That(ReverseFieldPatch.Apply(absent, restoreNull, registry).ToJsonString()).IsEqualTo(withNull.ToJsonString());

		// Null and the string "null" differ.
		var restoreString = ReverseFieldPatch.Create(withNull, withText, registry);
		await Assert.That(Convert.ToHexStringLower(restoreString.ReversePatch)).IsEqualTo("050206226e756c6c22");
		await Assert.That(restoreString.SourceHash).IsNotEqualTo(restoreString.TargetHash);

		// Same values: no change, absent equals absent, null equals null.
		await Assert.That(ReverseFieldPatch.Create(absent, absent, registry).ReversePatch.Length).IsEqualTo(0);
		await Assert.That(ReverseFieldPatch.Create(withNull, withNull, registry).ReversePatch.Length).IsEqualTo(0);
	}

	[Test]
	public async Task A_changed_field_that_the_predecessor_lacks_cannot_be_restored()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Entity);

		await Assert.That(() => ReverseFieldPatch.Create(Obj("""{"title":"T","body":"B","parentId":"p"}"""), Obj("""{"title":"T","body":"B"}"""), registry))
			.Throws<ArgumentException>();
	}

	[Test]
	[Arguments("""{"title":"T","body":"B","status":1}""")]
	[Arguments("""{"title":"T","body":"B","status":{"a":1}}""")]
	[Arguments("""{"title":"T","body":"B","status":["a",2]}""")]
	public async Task Numbers_and_objects_are_not_supported_values(string successorJson)
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Entity);
		var predecessor = Obj("""{"title":"T","body":"B","status":"todo"}""");

		await Assert.That(() => ReverseFieldPatch.Create(Obj(successorJson), predecessor, registry)).Throws<ArgumentException>();
	}

	[Test]
	public async Task A_text_field_that_is_not_a_string_is_rejected()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Context);

		await Assert.That(() => ReverseFieldPatch.Create(Obj("""{"title":null,"summary":"s"}"""), Obj("""{"title":"T","summary":"s"}"""), registry))
			.Throws<ArgumentException>();
	}

	[Test]
	public async Task A_text_patch_on_a_field_that_is_not_text_fails_without_partial_success()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Context);
		var successor = Obj("""{"title":"T2","summary":"s"}""");
		var valid = ReverseFieldPatch.Create(successor, Obj("""{"title":"T1","summary":"s"}"""), registry);
		var broken = Obj("""{"title":null,"summary":"s"}""");
		var transition = valid with { SourceHash = ReverseFieldPatch.ComputeCanonicalStateHash(broken, registry) };

		var thrown = Assert.Throws<ReversePatchException>(() => ReverseFieldPatch.Apply(broken, transition, registry));

		await Assert.That(thrown.Message).IsEqualTo("Malformed reverse field patch: field 1 is not text.");
	}

	[Test]
	[Arguments("80")]
	[Arguments("01")]
	[Arguments("0102")]
	[Arguments("010280")]
	public async Task A_truncated_patch_fails_with_the_length_error(string patchHex)
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Context);
		var successor = Obj("""{"title":"T","summary":"s"}""");
		var transition = new ReverseFieldPatchTransition(1, Convert.FromHexString(patchHex), ReverseFieldPatch.ComputeCanonicalStateHash(successor, registry), "");

		var thrown = Assert.Throws<ReversePatchException>(() => ReverseFieldPatch.Apply(successor, transition, registry));

		await Assert.That(thrown.Message).IsEqualTo("Malformed reverse text patch: unterminated length.");
	}

	[Test]
	public async Task A_value_payload_that_is_not_a_supported_json_value_fails()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Entity);
		var successor = Obj("""{"title":"T","body":"B"}""");
		var hash = ReverseFieldPatch.ComputeCanonicalStateHash(successor, registry);

		foreach (var (payload, message) in new[]
		{
			("7b", "Malformed reverse field patch: the value is not valid JSON."),
			("ff", "Malformed reverse field patch: the value is not valid JSON."),
			("31", "Malformed reverse field patch: the value is not supported."),
			("225c756438303022", "Malformed reverse field patch: the value is not supported."),
		})
		{
			var patch = Convert.FromHexString("0402" + (payload.Length / 2).ToString("x2", System.Globalization.CultureInfo.InvariantCulture) + payload);
			var thrown = Assert.Throws<ReversePatchException>(() => ReverseFieldPatch.Apply(successor, new ReverseFieldPatchTransition(1, patch, hash, hash), registry));
			await Assert.That(thrown.Message).IsEqualTo(message);
		}
	}

	[Test]
	public async Task A_successor_with_an_unsupported_field_value_fails_with_the_patch_exception()
	{
		var registry = ReversePatchRegistry.For(RevisionPatchRecordKind.Entity);
		var successor = Obj("""{"title":"T","body":"B","status":1}""");
		var transition = new ReverseFieldPatchTransition(1, [], "", "");

		var thrown = Assert.Throws<ReversePatchException>(() => ReverseFieldPatch.Apply(successor, transition, registry));

		await Assert.That(thrown.Message).IsEqualTo("Malformed reverse field patch: a field value is not supported.");
	}

	[Test]
	public async Task A_text_patch_that_builds_invalid_utf8_fails()
	{
		var thrown = Assert.Throws<ReversePatchException>(() => ReverseTextPatch.Apply("", Convert.FromHexString("010301ff")));

		await Assert.That(thrown.Message).IsEqualTo("Malformed reverse text patch: the result is not valid UTF-8.");
	}

	[Test]
	public async Task A_length_above_the_range_of_a_long_is_out_of_range_not_a_crash()
	{
		var thrown = Assert.Throws<ReversePatchException>(() => ReverseTextPatch.Apply("abc", Convert.FromHexString("0101ffffffffffffffffff7f")));

		await Assert.That(thrown.Message).IsEqualTo("Malformed reverse text patch: source read is out of range.");
	}

	[Test]
	public async Task Text_round_trips_for_lone_surrogates_and_a_byte_order_mark()
	{
		foreach (var (successor, predecessor) in new[] { ("a﻿b", "ab"), ("ab", "﻿ab"), ("x\uD800y", "x\uD801y") })
		{
			var restored = ReverseTextPatch.Apply(successor, ReverseTextPatch.Create(successor, predecessor));

			// A lone surrogate is written as U+FFFD, like the TypeScript text encoder.
			await Assert.That(restored).IsEqualTo(predecessor.Replace('\uD801', '�'));
		}
	}

	[Test]
	public async Task Every_registry_has_unique_field_ids_and_keys()
	{
		foreach (var kind in Enum.GetValues<RevisionPatchRecordKind>())
		{
			var fields = ReversePatchRegistry.For(kind);

			await Assert.That(fields.Select(f => f.Id).Distinct().Count()).IsEqualTo(fields.Count);
			await Assert.That(fields.Select(f => f.Key).Distinct().Count()).IsEqualTo(fields.Count);
		}

		await Assert.That(() => ReversePatchRegistry.For((RevisionPatchRecordKind)99)).Throws<ArgumentOutOfRangeException>();
	}

	private static JsonObject Obj(string json) => (JsonObject)JsonNode.Parse(json)!;

	private static JsonObject StateOf(JsonElement input, string property) => (JsonObject)JsonNode.Parse(input.GetProperty(property).GetRawText())!;

	private static IReadOnlyList<ReversePatchField> RegistryOf(JsonElement input) =>
		ReversePatchRegistry.For(RevisionPatchRecordKinds.FromWireName(input.GetProperty("registry").GetString()!));

	private static IEnumerable<(int Index, string Name)> Select(Lazy<IReadOnlyList<JsonElement>> vectors, string behavior)
	{
		for (var i = 0; i < vectors.Value.Count; i++)
		{
			if (vectors.Value[i].GetProperty("behavior").GetString() == behavior)
			{
				yield return (i, vectors.Value[i].GetProperty("name").GetString()!);
			}
		}
	}

	private static List<JsonElement> Load(string file)
	{
		using var document = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "test-vectors", file)));
		return [.. document.RootElement.GetProperty("vectors").EnumerateArray().Select(v => v.Clone())];
	}
}
