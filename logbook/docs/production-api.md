# Production API Host

The PostgreSQL API has a separate production command. It does not read saved CLI
logins, start the local browser server, or run schema migrations.

## Build And Start

Run these commands from the Logbook workspace:

```sh
pnpm --filter @agent-issues/core build
pnpm --filter @agent-issues/api-pg build
pnpm --filter @agent-issues/api-pg start
```

Supply runtime configuration through the host's private environment configuration.
Do not put credentials in source files, image arguments, or public logs.

| Variable | Requirement | Default |
| --- | --- | --- |
| `DATABASE_URL` | Passwordless PostgreSQL URL with the restricted runtime role, host, database, and `sslmode=verify-full`. No other URL options are accepted. | Required |
| `DATABASE_MANAGED_IDENTITY_CLIENT_ID` | Client UUID of the runtime user-assigned managed identity. Separate from the API audience. | Required |
| `ENTRA_TENANT_ID` | Trusted Entra tenant UUID. | Required |
| `ENTRA_CLIENT_ID` | API audience UUID. | Required |
| `HOST` | Listener IP address or `localhost`. | `0.0.0.0` |
| `PORT` | Integer from 0 to 65535. Zero selects a temporary port for tests. | `8080` |
| `SHUTDOWN_TIMEOUT_MS` | Total shutdown deadline, from 1 to 30000 milliseconds. | `10000` |

Invalid configuration stops the process before it listens. Startup and shutdown
messages do not contain configuration values. SIGTERM and SIGINT stop new
connections, drain HTTP work, and close the shared pool. A deadline failure closes
remaining HTTP connections and exits with code 1. Configure the host's termination
period to be longer than the application deadline.

The pool requests a PostgreSQL token through `ManagedIdentityCredential` for each
new physical connection. The Azure SDK caches and renews tokens. Authentication
does not use saved CLI credentials, a developer credential chain, or a stored
password. Register the managed identity as a restricted PostgreSQL principal in
the separate approved setup operation. Assign only that runtime identity to the
application. Database setup and migration identities must not be assigned there.

## Health Checks

- `GET /health/live` returns 200 without database access.
- `GET /health/ready` checks effective database role restrictions and returns 200
  or a fixed 503 response. Administrator, migration, owner, RLS-bypass, schema
  creation, temporary-object, and excess table permissions fail this check.
  Connection acquisition and queries each have a two-second timeout. This probe
  does not check schema compatibility or change the schema.
- The existing discovery route, authenticated JSON-RPC API, and event channel are
  unchanged. The executable always uses Entra authentication.

Apply compatible migrations through the separate approved private-network
operation before release. Do not provide migration or administrator credentials
to the runtime.

## Container

From the Logbook workspace:

```sh
docker build --file docker/api.Dockerfile --tag logbook-api:local-check .
node --test scripts/production-image.test.mjs
```

The image pins the Node 24 base digest and pnpm version, installs from the frozen
lockfile, and includes the API and core production dependencies. It runs as the
non-root `node` user on port 8080. The build context excludes local state and
credentials. The image health check uses liveness, not database readiness.

`/app/public` is the reserved browser-asset directory. This issue does not serve
browser assets or implement hosted browser authentication. Complete that work
before publishing the first combined browser/API release. TLS termination and
private database connectivity belong to the approved deployment configuration.

## Validation

```sh
pnpm --filter @agent-issues/api-pg exec vitest run
pnpm --filter @agent-issues/api-pg typecheck
```

The API tests use the existing local PostgreSQL fixture. Process tests build core
and API first. Container tests use only the selected local image and synthetic
test identities. Set `LOGBOOK_TEST_IMAGE` to test a different local image. Tests
remove only their own containers. These commands do not publish an image, run
Azure or Terraform, or authorize a deployment.