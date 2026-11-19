namespace AgentLogbook.Storage.Postgres;

/// <summary>
/// The database has a schema that this storage did not create. The initializer changes nothing and
/// does not adopt it.
/// </summary>
public sealed class UnrecognizedSchemaException(string message) : Exception(message);
