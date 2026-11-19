using System.Text.Json;
using AgentLogbook.Core.Identity;

namespace AgentLogbook.Core.Tests.Identity;

/// <summary>Runs the exported TypeScript vectors (<c>stable-ids.json</c>, <c>references.json</c>, <c>namespaces.json</c>) without normalization.</summary>
public class IdentityVectorTests
{
	private static readonly IReadOnlyList<JsonElement> StableIds = Load("stable-ids.json");
	private static readonly IReadOnlyList<JsonElement> References = Load("references.json");
	private static readonly IReadOnlyList<JsonElement> Namespaces = Load("namespaces.json");

	private static readonly string[] StableIdBehaviors = ["context-identity", "context-term-id", "entity-identity", "user-identity"];
	private static readonly string[] ReferenceBehaviors = ["decode-reference", "direct-selector", "encode-reference", "short-reference"];

	public static IEnumerable<(string Name, string Behavior)> StableIdVectors() => Select(StableIds, null);

	public static IEnumerable<(string Name, string Behavior)> ReferenceVectors() => Select(References, null);

	public static IEnumerable<(string Name, string Behavior)> EntityVectors() => Select(StableIds, "entity-identity");

	[Test]
	[MethodDataSource(nameof(StableIdVectors))]
	public async Task Stable_id_derivation_matches_the_exported_vector(string name, string behavior)
	{
		var vector = Find(StableIds, behavior, name);
		var input = vector.GetProperty("input");
		var expected = vector.GetProperty("expected").GetProperty("value");

		switch (behavior)
		{
			case "entity-identity":
				var entity = StableIdentity.DeriveEntity(Kind(input.GetProperty("kind").GetString()!), input.GetProperty("legacyAlias").GetString()!);
				await Assert.That(entity).IsEqualTo(new DerivedIdentity(expected.GetProperty("stableId").GetString()!, expected.GetProperty("reference").GetString()!));
				break;
			case "context-identity":
				var context = StableIdentity.DeriveContext(input.GetProperty("contextKey").GetString()!);
				await Assert.That(context).IsEqualTo(new DerivedIdentity(expected.GetProperty("stableId").GetString()!, expected.GetProperty("reference").GetString()!));
				break;
			case "context-term-id":
				await Assert.That(StableIdentity.DeriveContextTermId(input.GetProperty("contextKey").GetString()!, input.GetProperty("term").GetString()!))
					.IsEqualTo(expected.GetString());
				break;
			case "user-identity":
				var user = StableIdentity.DeriveUser(input.GetProperty("authenticationSubject").GetString()!);
				await Assert.That(user).IsEqualTo(new UserIdentity(expected.GetProperty("id").GetString()!, expected.GetProperty("authenticationSubject").GetString()!));
				break;
			default:
				throw new InvalidOperationException($"Unknown behavior {behavior}.");
		}
	}

	[Test]
	[MethodDataSource(nameof(ReferenceVectors))]
	public async Task Reference_helpers_match_the_exported_vector(string name, string behavior)
	{
		var vector = Find(References, behavior, name);
		var input = vector.GetProperty("input");
		var expected = vector.GetProperty("expected");

		if (expected.TryGetProperty("error", out var error))
		{
			var thrown = Assert.Throws<MalformedReferenceException>(() => _ = behavior switch
			{
				"encode-reference" => CanonicalReference.Encode(Kind(input.GetProperty("kind").GetString()!), input.GetProperty("stableId").GetString()!),
				"decode-reference" => CanonicalReference.Decode(input.GetProperty("reference").GetString()!).StableId,
				_ => throw new InvalidOperationException($"Unexpected error vector for {behavior}."),
			});
			await Assert.That(thrown.Message).IsEqualTo(error.GetString());
			return;
		}

		var value = expected.GetProperty("value");
		switch (behavior)
		{
			case "encode-reference":
				await Assert.That(CanonicalReference.Encode(Kind(input.GetProperty("kind").GetString()!), input.GetProperty("stableId").GetString()!)).IsEqualTo(value.GetString());
				break;
			case "decode-reference":
				var decoded = CanonicalReference.Decode(input.GetProperty("reference").GetString()!);
				await Assert.That(decoded).IsEqualTo(new DecodedReference(Kind(value.GetProperty("kind").GetString()!), value.GetProperty("stableId").GetString()!));
				break;
			case "short-reference":
				var entity = input.GetProperty("entity");
				var stored = entity.TryGetProperty("shortReference", out var s) ? s.GetString() : null;
				await Assert.That(CanonicalReference.ShortReference(entity.GetProperty("id").GetString()!, entity.GetProperty("kind").GetString()!, stored)).IsEqualTo(value.GetString());
				break;
			case "direct-selector":
				await Assert.That(CanonicalReference.IsDirectEntitySelector(input.GetProperty("selector").GetString()!)).IsEqualTo(value.GetBoolean());
				break;
			default:
				throw new InvalidOperationException($"Unknown behavior {behavior}.");
		}
	}

	[Test]
	public async Task The_namespace_constants_match_the_exported_values()
	{
		var exported = Namespaces.ToDictionary(v => v.GetProperty("input").GetProperty("namespace").GetString()!, v => v.GetProperty("expected").GetProperty("value").GetString()!);

		await Assert.That(IdentityNamespaces.Entity).IsEqualTo(exported["entity"]);
		await Assert.That(IdentityNamespaces.Context).IsEqualTo(exported["context"]);
		await Assert.That(IdentityNamespaces.ContextTerm).IsEqualTo(exported["contextTerm"]);
		await Assert.That(IdentityNamespaces.User).IsEqualTo(exported["user"]);
		await Assert.That(exported.Count).IsEqualTo(4);
	}

	[Test]
	public async Task The_vector_files_cover_every_helper_and_the_default_alias_of_every_entity_kind()
	{
		await Assert.That(StableIdVectors().Select(v => v.Behavior).Distinct().Order().ToArray())
			.IsEquivalentTo(StableIdBehaviors);
		await Assert.That(ReferenceVectors().Select(v => v.Behavior).Distinct().Order().ToArray())
			.IsEquivalentTo(ReferenceBehaviors);

		var defaults = EntityVectors().Where(v => v.Name.EndsWith("/ default alias", StringComparison.Ordinal)).Select(v => v.Name.Split(' ')[0]).Order().ToArray();
		await Assert.That(defaults.Length).IsEqualTo(11);
	}

	[Test]
	[MethodDataSource(nameof(EntityVectors))]
	public async Task A_changed_namespace_does_not_reproduce_the_exported_stable_id(string name, string behavior)
	{
		var vector = Find(StableIds, behavior, name);
		var input = vector.GetProperty("input");
		var exported = vector.GetProperty("expected").GetProperty("value").GetProperty("stableId").GetString();
		var kind = input.GetProperty("kind").GetString()!;
		var alias = input.GetProperty("legacyAlias").GetString()!;

		await Assert.That(StableIdDerivation.Derive(IdentityNamespaces.Entity, kind, alias)).IsEqualTo(exported);
		await Assert.That(StableIdDerivation.Derive("logbook/entity-stable-id/v1", kind, alias)).IsNotEqualTo(exported);
		await Assert.That(StableIdDerivation.Derive(IdentityNamespaces.Entity.Replace("/v1", "/v2", StringComparison.Ordinal), kind, alias)).IsNotEqualTo(exported);
	}

	[Test]
	public async Task Only_entity_kinds_have_a_derived_entity_identity()
	{
		await Assert.That(() => StableIdentity.DeriveEntity(ReferenceKind.Context, "default")).Throws<ArgumentOutOfRangeException>();
		await Assert.That(() => StableIdentity.DeriveEntity(ReferenceKind.PlanEntry, "default")).Throws<ArgumentOutOfRangeException>();
		await Assert.That(StableIdentity.DeriveEntity(ReferenceKind.Plan, "default").Reference).StartsWith("PLAN_");
	}

	[Test]
	public async Task Null_inputs_are_rejected()
	{
		await Assert.That(() => StableIdentity.DeriveContext(null!)).Throws<ArgumentNullException>();
		await Assert.That(() => StableIdentity.DeriveContextTermId("k", null!)).Throws<ArgumentNullException>();
		await Assert.That(() => StableIdentity.DeriveUser(null!)).Throws<ArgumentNullException>();
		await Assert.That(() => CanonicalReference.Decode(null!)).Throws<ArgumentNullException>();
		await Assert.That(() => CanonicalReference.ShortReference("id", null!)).Throws<ArgumentNullException>();
	}

	[Test]
	public async Task The_system_authentication_subject_derives_the_exported_system_user()
	{
		var vector = Find(StableIds, "user-identity", "system subject");

		await Assert.That(StableIdentity.SystemAuthenticationSubject).IsEqualTo(vector.GetProperty("input").GetProperty("authenticationSubject").GetString());
	}

	private static ReferenceKind Kind(string wireName) => ReferenceKinds.FromWireName(wireName) ?? throw new InvalidOperationException($"Unknown kind {wireName}.");

	private static IEnumerable<(string Name, string Behavior)> Select(IReadOnlyList<JsonElement> vectors, string? behavior) =>
		vectors.Where(v => behavior is null || v.GetProperty("behavior").GetString() == behavior)
			.Select(v => (v.GetProperty("name").GetString()!, v.GetProperty("behavior").GetString()!));

	private static JsonElement Find(IReadOnlyList<JsonElement> vectors, string behavior, string name) =>
		vectors.Single(v => v.GetProperty("behavior").GetString() == behavior && v.GetProperty("name").GetString() == name);

	private static List<JsonElement> Load(string file)
	{
		var path = Path.Combine(AppContext.BaseDirectory, "test-vectors", file);
		using var document = JsonDocument.Parse(File.ReadAllText(path));
		return [.. document.RootElement.GetProperty("vectors").EnumerateArray().Select(v => v.Clone())];
	}
}
