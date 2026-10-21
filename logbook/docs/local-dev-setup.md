# Local development setup

This guide covers `LocalAuthProvider`, the dev-only second implementation of
the auth-provider seam (ADR12, ADR21). It supports API tests and local service
development without a real Entra ID tenant.

If you're looking for the production Entra ID setup instead, see
[`docs/auth-entra-id-setup.md`](auth-entra-id-setup.md).

## Why this exists

The cloud path (auth seam, cloud API, Postgres) is otherwise only
verifiable against real Azure infrastructure: a tenant app registration and
a human completing an interactive device-code login. That's a real barrier
for local development, CI, and AFK agent work. `LocalAuthProvider` behind
the same `AuthProvider` seam removes that barrier for anything that isn't a
production deployment.

**`LocalAuthProvider` is dev-only tooling.** It must never be wired up as
the default provider in a deployed environment - only ever behind an
explicit opt-in.

## Using it today

`LocalAuthProvider` is available only to API service tests and local API
service setup code. The CLI does not expose local credential issuance. Its
permanent built-in `local` saved login routes directly to local storage, is
active by default, and cannot be removed or overwritten. It is a request
destination, not a `LocalAuthProvider` session.

## What this does not cover yet

Running the cloud API and Postgres locally (so the whole dual-mode cloud
path - not just the auth seam - runs without any Azure dependency) was
tracked under ISS39 (cloud API single Postgres gate) and ISS40
(HttpStore/backend switch). Both are now complete: `PgStore`, the Express
JSON-RPC gate, the change/event stream, saved remote logins, and `synchronize`
work end to end against the local Postgres started
below (see "Local Postgres"). There's no bundled long-running local cloud
API server yet, though - starting one for manual testing still means
writing a small script that calls `createApiServer` directly with a
`LocalAuthProvider`.

One known gap: `synchronize` currently replicates the `entities` and
`history_entries` tables but not `relations`, so data that depends on
relations (e.g. derived initiative status) can disagree between the local
and cloud copies of the same project until that's fixed (tracked as ISS60).

## Local Postgres (ISS39, partial)

```bash
docker compose up -d
```

This starts a single Postgres 16 container (`agent-issues-local-postgres`,
port 5433, named volume `agent-issues-postgres-data`) with two roles,
created by `docker/postgres-init/01-app-role.sql` the first time the
container initializes its data volume:

- `agent_issues` / `agent_issues_dev_only` - a Postgres **superuser**
  (created automatically by the official image's `POSTGRES_USER`). Used
  only to run migrations (`migratePgDatabase`) and install official instruction bundles. **Never use this role for
  application queries** - Postgres superusers bypass row-level security
  unconditionally, even with `FORCE ROW LEVEL SECURITY` set, so RLS
  (ADR9) would silently do nothing.
- `agent_issues_app` / `agent_issues_app_dev_only` - an ordinary,
  non-superuser role with table-level `SELECT`/`INSERT`/`UPDATE`/`DELETE`
  grants (via `ALTER DEFAULT PRIVILEGES`, so future migrations don't need
  this script updated). `PgStore` always connects as this role, so RLS
  actually applies in local dev the same way it will for the real Azure
  Managed Identity role in production.

Connection strings (plain connection string, matching ADR21's commitment -
no code branching vs. the Azure Managed Identity path):

```
postgres://agent_issues:agent_issues_dev_only@127.0.0.1:5433/agent_issues       # migrations only
postgres://agent_issues_app:agent_issues_app_dev_only@127.0.0.1:5433/agent_issues  # PgStore
```

If you already had a container from before this role was introduced, the
init script won't retroactively run - reset the volume once:
`docker compose down -v && docker compose up -d`.

## Install official cloud instructions

The service release process installs official bundles before it starts the API.
Use the bundle from each supported CLI release. The CLI build writes it to
`packages/cli/dist/plugin/instruction-defaults.json`.

```ts
import { readFile } from "node:fs/promises";
import { createPgPool, installInstructionBundle, migratePgDatabase } from "@agent-issues/api-pg";

const adminPool = createPgPool({ connectionString: process.env.AGENT_ISSUES_PG_ADMIN_URL! });
try {
  await migratePgDatabase(adminPool);
  const bundle = JSON.parse(await readFile("packages/cli/dist/plugin/instruction-defaults.json", "utf8"));
  await installInstructionBundle(adminPool, bundle);
} finally {
  await adminPool.end();
}
```

Set `AGENT_ISSUES_PG_ADMIN_URL` in the service release environment. Do not give
this connection to `createApiServer`. The API must use the application role.
Repeat installation of an identical bundle is safe. Changed content for an
installed release is rejected. Installation does not remove older bundles.

The application role can read official defaults but cannot write them. There is
no RPC operation for bundle installation. Retrieval uses the requesting CLI
release, not the service release. Missing release defaults cause an error.
Personal overrides use the authenticated tenant and user and apply across
projects. Request parameters cannot select another instruction owner.

## Browsing the local Postgres data (pgAdmin)

`docker compose up -d` also starts
[pgAdmin 4](https://www.pgadmin.org/) (`agent-issues-local-pgadmin`,
port 8978) - a web UI for browsing tables, running ad-hoc SQL, and
inspecting data without a desktop client.

```
http://localhost:8978
```

The container runs pgAdmin in **desktop mode** (`PGADMIN_CONFIG_SERVER_MODE=False`),
so the normal pgAdmin login screen is skipped entirely for this local-only
setup. It also disables pgAdmin's master-password prompt
(`PGADMIN_CONFIG_MASTER_PASSWORD_REQUIRED=False`) and supplies the database
passwords through `docker/pgadmin/pgpass`, so the bundled connections can
open immediately without any extra credential entry.

Two connections are pre-configured from `docker/pgadmin/servers.json` and
re-applied on every startup (`PGADMIN_REPLACE_SERVERS_ON_STARTUP=True`):

- **agent-issues (admin, bypasses RLS)** - connects as the `agent_issues`
  superuser. Use this to see all tenants' data at once (RLS doesn't apply to
  superusers - see above).
- **agent-issues (app role, RLS enforced)** - connects as `agent_issues_app`,
  the same role `PgStore` uses. Use this to see exactly what a given
  session/tenant sees.

If you reset the pgAdmin volume (`docker compose down -v` or manually
removing `agent-issues-pgadmin-data`), these connections are rebuilt
automatically on next startup - nothing to reconfigure by hand.

If you were already running the old CloudBeaver service, refresh with
`docker compose up -d --remove-orphans` once so Docker cleans up the old
container.
