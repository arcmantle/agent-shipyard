namespace AgentLogbook.Client;

/// <summary>The request did not get an HTTP response (the host is down, refuses the connection, or does not answer in time).</summary>
public sealed class HttpStoreTransportException(string method, Uri url, Exception innerException)
	: Exception($"HttpStore request to {method} could not reach {url}: {innerException.Message}", innerException)
{
	public string Method { get; } = method;

	public Uri Url { get; } = url;
}

/// <summary>The host answered with an HTTP status that is not a success.</summary>
public sealed class HttpStoreStatusException(string method, int statusCode)
	: Exception($"HttpStore request to {method} failed with HTTP {statusCode}.")
{
	public string Method { get; } = method;

	public int StatusCode { get; } = statusCode;
}

/// <summary>The host answered with a success status, but the body is not a JSON-RPC 2.0 response.</summary>
public sealed class HttpStoreProtocolException(string method, string detail, Exception? innerException = null)
	: Exception($"HttpStore request to {method} got an invalid JSON-RPC response: {detail}", innerException)
{
	public string Method { get; } = method;
}

/// <summary>The selected backend is the Local API host, and no running host answers. The message says what to do.</summary>
public sealed class LocalApiUnavailableException(string message, Exception? innerException = null) : Exception(message, innerException);

/// <summary>The process routing setting is not usable.</summary>
public sealed class InvalidBackendRouteException(string message) : Exception(message);
