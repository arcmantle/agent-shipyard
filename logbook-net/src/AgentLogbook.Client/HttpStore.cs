using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using AgentLogbook.Core.Rpc;

namespace AgentLogbook.Client;

/// <summary>The settings of an <see cref="HttpStore"/>.</summary>
public sealed class HttpStoreOptions
{
	/// <summary>The API base URL, with or without a trailing slash.</summary>
	public required Uri BaseUrl { get; init; }

	/// <summary>The bearer token for every request. Null sends no <c>Authorization</c> header, as the local login does.</summary>
	public string? BearerToken { get; init; }

	public string? ProjectIdentity { get; init; }

	public string? WorkspaceRoot { get; init; }

	public string? CorrelationId { get; init; }

	/// <summary>The client to use. The store does not dispose a client that the caller supplies.</summary>
	public HttpClient? HttpClient { get; init; }
}

/// <summary>
/// The client of the API host: every call is one JSON-RPC 2.0 request to <c>POST /rpc</c>. A JSON-RPC error response becomes
/// an <see cref="RpcException"/>, a missing or failed HTTP answer becomes a transport or status exception. The store holds no
/// connection, but it refuses a call after <see cref="Dispose"/>. Typed methods are added next to <see cref="CallAsync"/>
/// as their slices are ported.
/// </summary>
public sealed class HttpStore : IDisposable
{
	private readonly HttpStoreOptions options;
	private readonly HttpClient client;
	private readonly bool ownsClient;
	private readonly Uri rpcUrl;
	private bool closed;

	public HttpStore(HttpStoreOptions options)
	{
		ArgumentNullException.ThrowIfNull(options);
		this.options = options;
		client = options.HttpClient ?? new HttpClient();
		ownsClient = options.HttpClient is null;
		rpcUrl = new Uri(options.BaseUrl.GetLeftPart(UriPartial.Path).TrimEnd('/') + RpcWire.Path);
	}

	/// <summary>The API base URL of this store, as it was given.</summary>
	public Uri BaseUrl => options.BaseUrl;

	/// <summary>
	/// Calls a method. <paramref name="parameters"/> null leaves out <c>params</c>; a JSON <c>null</c> element sends <c>"params":null</c>.
	/// The result is the <c>result</c> member as it came, so a JSON <c>null</c> stays <see cref="JsonValueKind.Null"/>.
	/// A response without <c>result</c> gives a default element (<see cref="JsonValueKind.Undefined"/>).
	/// </summary>
	public async Task<JsonElement> CallAsync(string method, JsonElement? parameters = null, CancellationToken cancellationToken = default)
	{
		ArgumentException.ThrowIfNullOrEmpty(method);
		if (closed)
		{
			throw new InvalidOperationException("HttpStore is closed; open a new store instead of reusing a closed one.");
		}

		using var request = new HttpRequestMessage(HttpMethod.Post, rpcUrl) { Content = BuildBody(method, parameters) };
		if (options.BearerToken is not null)
		{
			request.Headers.TryAddWithoutValidation("authorization", $"Bearer {options.BearerToken}");
		}

		AddHeader(request, RpcWire.ProjectIdentityHeader, options.ProjectIdentity);
		AddHeader(request, RpcWire.CorrelationIdHeader, options.CorrelationId);
		AddHeader(request, RpcWire.WorkspaceRootHeader, options.WorkspaceRoot);

		HttpResponseMessage response;
		try
		{
			response = await client.SendAsync(request, cancellationToken);
		}
		catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
		{
			throw new HttpStoreTransportException(method, rpcUrl, exception);
		}

		using (response)
		{
			if (!response.IsSuccessStatusCode)
			{
				throw new HttpStoreStatusException(method, (int)response.StatusCode);
			}

			try
			{
				return await ReadResponseAsync(method, response, cancellationToken);
			}
			catch (Exception exception) when (exception is HttpRequestException or IOException or TaskCanceledException && !cancellationToken.IsCancellationRequested)
			{
				throw new HttpStoreTransportException(method, rpcUrl, exception);
			}
		}
	}

	/// <summary>Calls a method with typed parameters and a typed result. Null fields stay JSON <c>null</c> on the wire.</summary>
	public async Task<TResult?> CallAsync<TResult>(string method, object? parameters = null, CancellationToken cancellationToken = default)
	{
		JsonElement? element = parameters is null ? null : JsonSerializer.SerializeToElement(parameters, RpcWire.JsonOptions);
		var result = await CallAsync(method, element, cancellationToken);
		return result.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null
			? default
			: result.Deserialize<TResult>(RpcWire.JsonOptions);
	}

	/// <summary>Opens the workspace of this store: its tenant and its project identity. Calling it again returns the same workspace.</summary>
	public async Task<InitializedWorkspace> InitializeWorkspaceAsync(CancellationToken cancellationToken = default) =>
		await CallAsync<InitializedWorkspace>(WorkspaceRpc.InitializeMethod, cancellationToken: cancellationToken)
		?? throw new HttpStoreProtocolException(WorkspaceRpc.InitializeMethod, "the result is empty.");

	/// <summary>Creates an entity, optionally under a structural parent. The result has the stored status, not the derived one.</summary>
	public async Task<EntitySummary> CreateEntityAsync(CreateEntityRequest request, CancellationToken cancellationToken = default) =>
		await CallAsync<EntitySummary>(EntityRpc.CreateMethod, request, cancellationToken)
		?? throw new HttpStoreProtocolException(EntityRpc.CreateMethod, "the result is empty.");

	/// <summary>Reads an entity by stable ID, reference or short reference, with the relations around it.</summary>
	public async Task<EntityDetails> GetEntityDetailsAsync(string entityId, CancellationToken cancellationToken = default) =>
		await CallAsync<EntityDetails>(EntityRpc.GetDetailsMethod, new GetEntityDetailsRequest(entityId), cancellationToken)
		?? throw new HttpStoreProtocolException(EntityRpc.GetDetailsMethod, "the result is empty.");

	/// <summary>Lists the entities of one kind in the workspace, by ID.</summary>
	public async Task<IReadOnlyList<EntitySummary>> ListEntitiesAsync(string kind, CancellationToken cancellationToken = default) =>
		await CallAsync<List<EntitySummary>>(EntityRpc.ListMethod, new ListEntitiesRequest(kind), cancellationToken)
		?? throw new HttpStoreProtocolException(EntityRpc.ListMethod, "the result is empty.");

	/// <summary>Lists the entities of one kind that match the filters, with the total before the limit.</summary>
	public async Task<QueryEntitiesResult> QueryEntitiesAsync(QueryEntitiesRequest request, CancellationToken cancellationToken = default) =>
		await CallAsync<QueryEntitiesResult>(EntityRpc.QueryMethod, request, cancellationToken)
		?? throw new HttpStoreProtocolException(EntityRpc.QueryMethod, "the result is empty.");

	public void Dispose()
	{
		closed = true;
		if (ownsClient)
		{
			client.Dispose();
		}
	}

	private static ByteArrayContent BuildBody(string method, JsonElement? parameters)
	{
		using var stream = new MemoryStream();
		using (var writer = new Utf8JsonWriter(stream, new JsonWriterOptions { Encoder = RpcWire.JsonOptions.Encoder }))
		{
			writer.WriteStartObject();
			writer.WriteString("jsonrpc", RpcWire.Version);
			writer.WriteString("id", Guid.NewGuid().ToString());
			writer.WriteString("method", method);
			if (parameters is { } value)
			{
				writer.WritePropertyName("params");
				value.WriteTo(writer);
			}

			writer.WriteEndObject();
		}

		var content = new ByteArrayContent(stream.ToArray());
		content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
		return content;
	}

	private static void AddHeader(HttpRequestMessage request, string name, string? value)
	{
		if (value is not null)
		{
			request.Headers.TryAddWithoutValidation(name, value);
		}
	}

	private static async Task<JsonElement> ReadResponseAsync(string method, HttpResponseMessage response, CancellationToken cancellationToken)
	{
		JsonDocument document;
		try
		{
			await using var body = await response.Content.ReadAsStreamAsync(cancellationToken);
			document = await JsonDocument.ParseAsync(body, cancellationToken: cancellationToken);
		}
		catch (JsonException exception)
		{
			throw new HttpStoreProtocolException(method, "the body is not JSON.", exception);
		}

		using (document)
		{
			var root = document.RootElement;
			if (root.ValueKind != JsonValueKind.Object)
			{
				throw new HttpStoreProtocolException(method, "the body is not a JSON object.");
			}

			if (root.TryGetProperty("error", out var error))
			{
				throw RpcErrorMapper.Map(error);
			}

			return root.TryGetProperty("result", out var result) ? result.Clone() : default;
		}
	}
}
