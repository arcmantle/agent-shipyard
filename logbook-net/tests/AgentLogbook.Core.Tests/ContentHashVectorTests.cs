using System.Text.Json;
using AgentLogbook.Core.ContentHashes;

namespace AgentLogbook.Core.Tests;

public class ContentHashVectorTests
{
	private static readonly Lazy<IReadOnlyList<JsonElement>> Vectors = new(LoadVectors);

	private static readonly string[] LiteralBehaviors =
	[
		"entity-content-hash",
		"context-content-hash",
		"context-term-content-hash",
		"issue-comment-content-hash",
		"plan-entry-content-hash"
	];

	// The TypeScript hash follows the property order of the object a caller passes. This vector passes a
	// reordered object. The .NET helper has one fixed order, the order every TypeScript caller uses, so
	// this input cannot be expressed. The canonical-order result is asserted separately below.
	private const string CallerOrderVector = "key order of input does not matter";

	public static IEnumerable<(int Index, string Behavior, string Name)> LiteralHashVectors()
	{
		for (var i = 0; i < Vectors.Value.Count; i++)
		{
			var behavior = Vectors.Value[i].GetProperty("behavior").GetString()!;
			var name = Vectors.Value[i].GetProperty("name").GetString()!;
			if (LiteralBehaviors.Contains(behavior) && name != CallerOrderVector)
			{
				yield return (i, behavior, name);
			}
		}
	}

	[Test]
	[MethodDataSource(nameof(LiteralHashVectors))]
	public async Task Hash_matches_the_exported_vector(int index, string behavior, string name)
	{
		_ = name;
		var vector = Vectors.Value[index];

		await Assert.That(Compute(behavior, vector.GetProperty("input"))).IsEqualTo(vector.GetProperty("expected").GetProperty("value").GetString());
	}

	[Test]
	public async Task The_vector_file_covers_every_literal_hash_behavior_including_edge_cases()
	{
		var behaviors = LiteralHashVectors().Select(v => v.Behavior).Distinct().Order().ToArray();
		await Assert.That(behaviors).IsEquivalentTo(LiteralBehaviors.Order().ToArray());

		var names = LiteralHashVectors().Where(v => v.Behavior == "entity-content-hash").Select(v => v.Name).ToArray();
		await Assert.That(names).Contains("empty");
		await Assert.That(names).Contains("crlf");
		await Assert.That(names).Contains("unicode");
	}

	[Test]
	public async Task A_reordered_typescript_object_is_the_only_vector_not_replayed()
	{
		var skipped = Vectors.Value
			.Where(v => LiteralBehaviors.Contains(v.GetProperty("behavior").GetString()!))
			.Select(v => v.GetProperty("name").GetString()!)
			.Count(n => n == CallerOrderVector);
		await Assert.That(skipped).IsEqualTo(1);

		var reordered = Vectors.Value.Single(v => v.GetProperty("name").GetString() == CallerOrderVector);
		await Assert.That(reordered.GetProperty("expected").GetProperty("value").GetString())
			.IsNotEqualTo(ContentHash.ForPlanEntry("decision", "o", null, [], [], false));

		// Canonical order for the same values; computed with the TypeScript function.
		await Assert.That(ContentHash.ForPlanEntry("decision", "o", null, [], [], false))
			.IsEqualTo("1218d8c6764e52b595db10fb69da2d1bc218094a22293eb51b6b1e4456d96c04");
	}

	[Test]
	public async Task A_changed_payload_gives_a_different_hash()
	{
		await Assert.That(ContentHash.ForEntity("t", "b")).IsNotEqualTo(ContentHash.ForEntity("t", "b2"));
		await Assert.That(ContentHash.ForContext("t", "s")).IsNotEqualTo(ContentHash.ForContext("t2", "s"));
		await Assert.That(ContentHash.ForContextTerm("t", "d", ["a", "b"], false)).IsNotEqualTo(ContentHash.ForContextTerm("t", "d", ["b", "a"], false));
		await Assert.That(ContentHash.ForIssueComment("b", [], false)).IsNotEqualTo(ContentHash.ForIssueComment("b", [], true));
		await Assert.That(ContentHash.ForPlanEntry("scope", "b", "in", [], [], false)).IsNotEqualTo(ContentHash.ForPlanEntry("scope", "b", "out", [], [], false));
	}

	[Test]
	public async Task A_null_scope_direction_is_not_the_empty_string_or_the_text_null()
	{
		var none = ContentHash.ForPlanEntry("scope", "b", null, [], [], false);

		await Assert.That(none).IsNotEqualTo(ContentHash.ForPlanEntry("scope", "b", "", [], [], false));
		await Assert.That(none).IsNotEqualTo(ContentHash.ForPlanEntry("scope", "b", "null", [], [], false));
	}

	[Test]
	public async Task Null_inputs_are_rejected()
	{
		await Assert.That(() => ContentHash.ForEntity(null!, "b")).Throws<ArgumentNullException>();
		await Assert.That(() => ContentHash.ForContext("t", null!)).Throws<ArgumentNullException>();
		await Assert.That(() => ContentHash.ForContextTerm("t", "d", null!, false)).Throws<ArgumentNullException>();
		await Assert.That(() => ContentHash.ForIssueComment("b", [null!], false)).Throws<ArgumentException>();
		await Assert.That(() => ContentHash.ForPlanEntry(null!, "b", null, [], [], false)).Throws<ArgumentNullException>();
	}

	[Test]
	public async Task Json_string_escapes_match_JSON_stringify()
	{
		// Expected values computed with Node: sha256(JSON.stringify({ body, referencedIssueIds: [], tombstone: false })).
		await Assert.That(ContentHash.ForIssueComment("\b\f\n\r\t\u0000\u001f\u007f\u2028\"\\</>&", [], false))
			.IsEqualTo(EscapeExpectation);
		await Assert.That(ContentHash.ForIssueComment("\uD800 \uDC00 \uD83D\uDE00", [], false))
			.IsEqualTo(SurrogateExpectation);
	}

	[Test]
	public async Task Lone_surrogates_and_line_separators_match_TypeScript_for_every_hash()
	{
		// Expected values computed with Node from the same TypeScript hash expressions.
		const string text = "a\uD800b\u2028\u2029\uDC00\u0001";

		await Assert.That(ContentHash.ForEntity(text, text)).IsEqualTo("6e58850e74d6e5c921f8593f7a1b2bf0f7bc533805689e43fdef53712728c343");
		await Assert.That(ContentHash.ForContext(text, text)).IsEqualTo("6e58850e74d6e5c921f8593f7a1b2bf0f7bc533805689e43fdef53712728c343");
		await Assert.That(ContentHash.ForContextTerm(text, text, [text], false)).IsEqualTo("2a36b52822d5ff45fb9e614dc9603bc004cee708fe1fd1238122a8738b6cd299");
		await Assert.That(ContentHash.ForPlanEntry(text, text, text, [text], [text], true)).IsEqualTo("3154cee719e7e6ec012d3355394fd3a65d8274dccbfd1a986235185c3cc5e9ce");
		await Assert.That(ContentHash.ForEntity("\uD800", "\uD800")).IsEqualTo(ContentHash.ForEntity("\uFFFD", "\uFFFD"));
	}

	private const string EscapeExpectation = "c905db866e61cdf100558024bf56c5e705afad7ea8e09d6933010bb50459836e";

	private const string SurrogateExpectation = "e87de18cbe4ad3fb07213bf19dd545768c4f03a962b97111907dc3d7c125ce30";

	private static string Compute(string behavior, JsonElement input) => behavior switch
	{
		"entity-content-hash" => ContentHash.ForEntity(Str(input, "title"), Str(input, "body")),
		"context-content-hash" => ContentHash.ForContext(Str(input, "title"), Str(input, "summary")),
		"context-term-content-hash" => ContentHash.ForContextTerm(Str(input, "term"), Str(input, "definition"), List(input, "avoid"), Bool(input, "tombstone")),
		"issue-comment-content-hash" => ContentHash.ForIssueComment(Str(input, "body"), List(input, "referencedIssueIds"), Bool(input, "tombstone")),
		"plan-entry-content-hash" => ContentHash.ForPlanEntry(
			Str(input, "role"),
			Str(input, "body"),
			input.GetProperty("scopeDirection").GetString(),
			List(input, "referencedEntityIds"),
			List(input, "supersededEntryIds"),
			Bool(input, "tombstone")),
		_ => throw new InvalidOperationException($"Unknown behavior {behavior}."),
	};

	private static string Str(JsonElement input, string name) => input.GetProperty(name).GetString()!;

	private static bool Bool(JsonElement input, string name) => input.GetProperty(name).GetBoolean();

	private static List<string> List(JsonElement input, string name) => [.. input.GetProperty(name).EnumerateArray().Select(e => e.GetString()!)];

	private static List<JsonElement> LoadVectors()
	{
		var path = Path.Combine(AppContext.BaseDirectory, "test-vectors", "content-hashes.json");
		using var document = JsonDocument.Parse(File.ReadAllText(path));
		return [.. document.RootElement.GetProperty("vectors").EnumerateArray().Select(v => v.Clone())];
	}
}
