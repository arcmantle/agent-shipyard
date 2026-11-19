namespace AgentLogbook.Core.LocalApi;

/// <summary>The selected local PostgreSQL setting is not usable. No other setting replaces it.</summary>
public sealed class LocalPostgresSettingsException : Exception
{
	public LocalPostgresSettingsException(string message)
		: base(message)
	{
	}

	public LocalPostgresSettingsException(string message, Exception innerException)
		: base(message, innerException)
	{
	}
}
