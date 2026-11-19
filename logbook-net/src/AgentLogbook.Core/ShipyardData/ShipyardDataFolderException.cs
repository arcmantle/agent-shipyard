namespace AgentLogbook.Core.ShipyardData;

/// <summary>The Shipyard Logbook data folder cannot be selected or used. The tool never falls back to another location.</summary>
public sealed class ShipyardDataFolderException : Exception
{
	public ShipyardDataFolderException(string message) : base(message)
	{
	}

	public ShipyardDataFolderException(string message, Exception innerException) : base(message, innerException)
	{
	}
}
