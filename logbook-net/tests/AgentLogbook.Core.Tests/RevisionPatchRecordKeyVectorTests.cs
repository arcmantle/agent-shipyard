using System.Text.Json;
using AgentLogbook.Core.RevisionLedger;

namespace AgentLogbook.Core.Tests;

public class RevisionPatchRecordKeyVectorTests
{
	private static readonly Lazy<IReadOnlyList<JsonElement>> Vectors = new(LoadVectors);

	private static readonly string[] KindNames = ["entity", "context", "context-term", "issue-comment", "plan-entry"];

	private static readonly string[] DecodedFieldNames = ["entityId", "contextKey", "contextTermId", "issueCommentId", "planEntryId"];

	public static IEnumerable<(int Index, string Name)> EncodeVectors() => Select("encode-record-key");

	public static IEnumerable<(int Index, string Name)> DecodeVectors() => Select("decode-record-key");

	[Test]
	[MethodDataSource(nameof(EncodeVectors))]
	public async Task Encode_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var vector = Vectors.Value[index];
		var input = vector.GetProperty("input");
		var kind = ParseKind(input.GetProperty("recordKind").GetString()!);

		var key = RevisionPatchRecordKey.Encode(kind, input.GetProperty("value").GetString()!);

		await Assert.That(key).IsEqualTo(vector.GetProperty("expected").GetProperty("value").GetString());
	}

	[Test]
	[MethodDataSource(nameof(DecodeVectors))]
	public async Task Decode_matches_the_exported_vector(int index, string name)
	{
		_ = name;
		var vector = Vectors.Value[index];
		var input = vector.GetProperty("input");
		var kindName = input.GetProperty("recordKind").GetString()!;
		var kind = ParseKind(kindName);
		var recordKey = input.GetProperty("recordKey").GetString()!;
		var expected = vector.GetProperty("expected");

		if (expected.TryGetProperty("error", out var error))
		{
			var thrown = Assert.Throws<MalformedRecordKeyException>(() => RevisionPatchRecordKey.Decode(kind, recordKey));
			await Assert.That(thrown.Message).IsEqualTo(error.GetString());
			return;
		}

		var value = expected.GetProperty("value");
		var field = DecodedFieldNames[Array.IndexOf(KindNames, kindName)];
		await Assert.That(value.EnumerateObject().Select(p => p.Name).ToArray()).IsEquivalentTo(new[] { field });
		await Assert.That(RevisionPatchRecordKey.Decode(kind, recordKey)).IsEqualTo(value.GetProperty(field).GetString());
	}

	[Test]
	public async Task Every_encode_vector_round_trips()
	{
		foreach (var (index, _) in EncodeVectors())
		{
			var input = Vectors.Value[index].GetProperty("input");
			var kind = ParseKind(input.GetProperty("recordKind").GetString()!);
			var value = input.GetProperty("value").GetString()!;

			await Assert.That(RevisionPatchRecordKey.Decode(kind, RevisionPatchRecordKey.Encode(kind, value))).IsEqualTo(value);
		}
	}

	[Test]
	public async Task The_vector_file_covers_every_record_kind_for_both_directions()
	{
		foreach (var behavior in new[] { "encode-record-key", "decode-record-key" })
		{
			var kinds = Vectors.Value
				.Where(v => v.GetProperty("behavior").GetString() == behavior)
				.Select(v => v.GetProperty("input").GetProperty("recordKind").GetString()!)
				.Distinct()
				.Order()
				.ToArray();

			await Assert.That(kinds).IsEquivalentTo(KindNames.Order().ToArray());
		}
	}

	[Test]
	public async Task Unknown_record_kind_is_rejected()
	{
		var unknown = (RevisionPatchRecordKind)99;

		await Assert.That(() => RevisionPatchRecordKey.Encode(unknown, "a")).Throws<ArgumentOutOfRangeException>();
		await Assert.That(() => RevisionPatchRecordKey.Decode(unknown, "1:a")).Throws<ArgumentOutOfRangeException>();
	}

	[Test]
	public async Task Lone_surrogate_is_counted_and_decoded_as_the_replacement_character()
	{
		var key = RevisionPatchRecordKey.Encode(RevisionPatchRecordKind.Entity, "\uD800");

		await Assert.That(key).IsEqualTo("3:\uD800");
		await Assert.That(RevisionPatchRecordKey.Decode(RevisionPatchRecordKind.Entity, key)).IsEqualTo("\uFFFD");
	}

	[Test]
	public async Task A_literal_replacement_character_round_trips()
	{
		var key = RevisionPatchRecordKey.Encode(RevisionPatchRecordKind.Context, "a\uFFFDb");

		await Assert.That(key).IsEqualTo("5:a\uFFFDb");
		await Assert.That(RevisionPatchRecordKey.Decode(RevisionPatchRecordKind.Context, key)).IsEqualTo("a\uFFFDb");
	}

	[Test]
	[Arguments("\uFF11:a")]
	[Arguments("\u0661:a")]
	[Arguments("+1:a")]
	[Arguments("1 :a")]
	public async Task Only_ascii_digits_make_a_length(string recordKey)
	{
		await Assert.That(() => RevisionPatchRecordKey.Decode(RevisionPatchRecordKind.PlanEntry, recordKey)).Throws<MalformedRecordKeyException>();
	}

	private static IEnumerable<(int Index, string Name)> Select(string behavior)
	{
		for (var i = 0; i < Vectors.Value.Count; i++)
		{
			if (Vectors.Value[i].GetProperty("behavior").GetString() == behavior)
			{
				yield return (i, Vectors.Value[i].GetProperty("name").GetString()!);
			}
		}
	}

	private static RevisionPatchRecordKind ParseKind(string name) => RevisionPatchRecordKinds.FromWireName(name);

	private static List<JsonElement> LoadVectors()
	{
		var path = Path.Combine(AppContext.BaseDirectory, "test-vectors", "record-keys.json");
		using var document = JsonDocument.Parse(File.ReadAllText(path));
		return [.. document.RootElement.GetProperty("vectors").EnumerateArray().Select(v => v.Clone())];
	}
}
