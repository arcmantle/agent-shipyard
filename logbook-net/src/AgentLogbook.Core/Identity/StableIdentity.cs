namespace AgentLogbook.Core.Identity;

/// <summary>A stable ID and the canonical reference that encodes it.</summary>
public sealed record DerivedIdentity(string StableId, string Reference);

/// <summary>A user ID and the authentication subject it was derived from.</summary>
public sealed record UserIdentity(string Id, string AuthenticationSubject);

/// <summary>
/// Derives the stable IDs that the retained format computes from a name: migrated entities, contexts,
/// context terms and users. The same input always gives the same ID.
/// </summary>
public static class StableIdentity
{
	/// <summary>The authentication subject of the system user.</summary>
	public const string SystemAuthenticationSubject = "agent-issues:system";

	/// <summary>The identity of the entity that a legacy alias names, for example the <c>default</c> project.</summary>
	/// <exception cref="ArgumentOutOfRangeException"><paramref name="kind"/> is not an entity kind.</exception>
	public static DerivedIdentity DeriveEntity(ReferenceKind kind, string legacyAlias)
	{
		ArgumentNullException.ThrowIfNull(legacyAlias);
		if (!ReferenceKinds.IsEntityKind(kind))
		{
			throw new ArgumentOutOfRangeException(nameof(kind), kind, "Only entity kinds have a derived entity identity.");
		}

		var stableId = StableIdDerivation.Derive(IdentityNamespaces.Entity, ReferenceKinds.ToWireName(kind), legacyAlias);
		return new DerivedIdentity(stableId, CanonicalReference.Encode(kind, stableId));
	}

	/// <summary>The identity of the context that a context key names.</summary>
	public static DerivedIdentity DeriveContext(string contextKey)
	{
		ArgumentNullException.ThrowIfNull(contextKey);
		var stableId = StableIdDerivation.Derive(IdentityNamespaces.Context, contextKey);
		return new DerivedIdentity(stableId, CanonicalReference.Encode(ReferenceKind.Context, stableId));
	}

	/// <summary>The ID of a context term. The key and the term are length-prefixed, so a shift between them changes the ID.</summary>
	public static string DeriveContextTermId(string contextKey, string term)
	{
		ArgumentNullException.ThrowIfNull(contextKey);
		ArgumentNullException.ThrowIfNull(term);
		return StableIdDerivation.Derive(IdentityNamespaces.ContextTerm, contextKey, term);
	}

	/// <summary>The user that an authentication subject names.</summary>
	public static UserIdentity DeriveUser(string authenticationSubject)
	{
		ArgumentNullException.ThrowIfNull(authenticationSubject);
		return new UserIdentity(StableIdDerivation.Derive(IdentityNamespaces.User, authenticationSubject), authenticationSubject);
	}
}
