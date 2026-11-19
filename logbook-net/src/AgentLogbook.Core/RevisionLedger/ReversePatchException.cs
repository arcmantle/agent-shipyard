namespace AgentLogbook.Core.RevisionLedger;

/// <summary>
/// A reverse patch cannot be applied: it has an unsupported format, a broken hash chain, or
/// malformed content. The message is the message of the TypeScript contract.
/// </summary>
public sealed class ReversePatchException(string message) : FormatException(message);
