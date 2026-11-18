namespace AgentLogbook.Core.RevisionLedger;

/// <summary>A revision patch record key is not one length-prefixed UTF-8 value.</summary>
public sealed class MalformedRecordKeyException : FormatException
{
	public const string DefaultMessage = "Malformed revision patch record key.";

	public MalformedRecordKeyException() : base(DefaultMessage)
	{
	}
}
