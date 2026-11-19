using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Npgsql;

namespace AgentLogbook.Api;

/// <summary>
/// The direct query endpoint of the Local API host: <c>POST /direct-query</c> with <c>{"statement":"..."}</c> runs one read-only
/// statement and returns <c>{"rows":[{"column":value}]}</c>. A failure returns <c>{"error":{"message":"...","sqlState":"..."}}</c>.
/// <see cref="ApiHost"/> maps the endpoint only for <see cref="Auth.LocalNoAuthProvider"/>, so a deployment has no such route.
/// </summary>
internal static class DirectQuery
{
	public const string Path = "/direct-query";

	private static readonly TimeSpan StatementTimeout = TimeSpan.FromSeconds(30);

	public static void Map(IEndpointRouteBuilder endpoints, NpgsqlDataSource dataSource)
	{
		// The explicit delegate type keeps the route on the IResult overload; a bare lambda would bind to RequestDelegate and drop the result.
		Func<HttpContext, Task<IResult>> handler = context => RunAsync(context, dataSource);
		endpoints.MapPost(Path, handler);
	}

	private static async Task<IResult> RunAsync(HttpContext context, NpgsqlDataSource dataSource)
	{
		// A browser page can send a text/plain POST to a loopback address without a preflight, and DNS rebinding changes the Host.
		// Requiring JSON forces a preflight that the host never allows, and only loopback host names are accepted.
		if (!context.Request.HasJsonContentType())
		{
			return Failure(StatusCodes.Status415UnsupportedMediaType, "The request content type must be application/json.", null);
		}

		if (!IsLoopbackHost(context.Request.Host.Host))
		{
			return Failure(StatusCodes.Status403Forbidden, "The direct query endpoint accepts loopback host names only.", null);
		}

		string? statement;
		try
		{
			using var body = await JsonDocument.ParseAsync(context.Request.Body, cancellationToken: context.RequestAborted);
			statement = body.RootElement.ValueKind == JsonValueKind.Object
				&& body.RootElement.TryGetProperty("statement", out var value)
				&& value.ValueKind == JsonValueKind.String
					? value.GetString()
					: null;
		}
		catch (JsonException)
		{
			statement = null;
		}

		if (string.IsNullOrWhiteSpace(statement))
		{
			return Failure(StatusCodes.Status400BadRequest, "The request body must be a JSON object with a non-empty string field \"statement\".", null);
		}

		try
		{
			using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
			timeout.CancelAfter(StatementTimeout);

			await using var connection = await dataSource.OpenConnectionAsync(timeout.Token);
			await using var transaction = await connection.BeginTransactionAsync(timeout.Token);
			await using (var readOnly = new NpgsqlCommand($"SET TRANSACTION READ ONLY; SET LOCAL statement_timeout = {(int)StatementTimeout.TotalMilliseconds}", connection, transaction))
			{
				await readOnly.ExecuteNonQueryAsync(timeout.Token);
			}

			// One batch command is one statement. Text with a second statement, such as COMMIT, would end the read-only
			// transaction and let the next statement write, so PostgreSQL must refuse it.
			await using var batch = new NpgsqlBatch(connection, transaction) { BatchCommands = { new NpgsqlBatchCommand(statement) } };
			await using var reader = await batch.ExecuteReaderAsync(timeout.Token);

			var rows = new List<(string Name, object? Value)[]>();
			var names = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray();
			if (names.Distinct(StringComparer.Ordinal).Count() != names.Length)
			{
				return Failure(StatusCodes.Status400BadRequest, "The result has duplicate column names. Give each column a distinct alias.", null);
			}

			while (await reader.ReadAsync(timeout.Token))
			{
				var row = new (string, object?)[names.Length];
				for (var i = 0; i < names.Length; i++)
				{
					row[i] = (names[i], reader.IsDBNull(i) ? null : reader.GetValue(i));
				}

				rows.Add(row);
			}

			return Results.Content(Serialize(rows), "application/json");
		}
		catch (PostgresException exception)
		{
			return Failure(StatusCodes.Status400BadRequest, exception.MessageText, exception.SqlState);
		}
		catch (OperationCanceledException) when (!context.RequestAborted.IsCancellationRequested)
		{
			return Failure(StatusCodes.Status408RequestTimeout, $"The statement did not finish within {StatementTimeout.TotalSeconds:0} seconds.", null);
		}
		catch (Exception exception) when (exception is not OperationCanceledException)
		{
			return Failure(StatusCodes.Status500InternalServerError, exception.Message, null);
		}
	}

	private static bool IsLoopbackHost(string host) =>
		host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
		|| (System.Net.IPAddress.TryParse(host.Trim('[', ']'), out var address) && System.Net.IPAddress.IsLoopback(address));

	private static string Serialize(List<(string Name, object? Value)[]> rows)
	{
		using var stream = new MemoryStream();
		using (var writer = new Utf8JsonWriter(stream))
		{
			writer.WriteStartObject();
			writer.WriteStartArray("rows");
			foreach (var row in rows)
			{
				writer.WriteStartObject();
				foreach (var (name, value) in row)
				{
					writer.WritePropertyName(name);
					JsonSerializer.Serialize(writer, value);
				}

				writer.WriteEndObject();
			}

			writer.WriteEndArray();
			writer.WriteEndObject();
		}

		return System.Text.Encoding.UTF8.GetString(stream.ToArray());
	}

	private static IResult Failure(int statusCode, string message, string? sqlState) =>
		Results.Json(new { error = new { message, sqlState } }, statusCode: statusCode);
}
