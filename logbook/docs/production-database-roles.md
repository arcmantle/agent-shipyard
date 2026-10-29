# Production Database Roles

The production API sets up the database itself on every start, before it listens.
There is no separate database workflow or job. PostgreSQL is public with Entra-only
sign-in; the firewall admits only Azure services.

## Terraform Deployment Access

The general Terraform executor uses the existing private Apply identity, not a
new feature-specific identity. Its completed protected access installation granted
subscription Owner to Apply and subscription Reader to Plan. Existing state locks,
firewall permissions, and automation-state access remain. The retired setup identity
is not restored. Terraform updates use OIDC without device-code sign-in or new
resource-type permission bootstraps.

Public **Terraform - Request Update** selects the private Terraform root. The
default is `logbook`; `automation` maintains deployment identities and grants.
Approval binds the root, source revision, plan hash, cost review, and single-use
claim. Apply uses only the saved binary plan and can register AzureRM providers.
The reviewed monthly estimate limit remains USD 60 across configured roots.
New installations use the separate **Terraform - Initial Setup** entry point and
its shared public approval. Do not repeat bootstrap on the existing installation.

Owner is standing ARM authority and can change roles and identity trust, including
its own. Azure does not enforce GitHub approval; the protected workflow controls
execution. This does not grant Microsoft Graph tenant administration. Runtime,
migration, and schema-owner database permissions remain separate.

## Role Contract

`configurePgRoles(pool, roles, passwords?)` is exported by
`@agent-issues/api-pg`. It configures a dedicated database and its `public` schema.
Role names must be distinct lowercase PostgreSQL identifiers, at most 63 bytes.
The operation requires PostgreSQL 16 or newer.

The helper supports a non-superuser setup login with explicit permissions. The
approved setup operation must provide database ownership, administration of the
three application roles, and permission to select the schema owner. Do not use
inherited owner permissions. The helper selects the owner only for schema grants
and default privileges, then restores the setup role before credential changes.
In production the setup identity is a permanent Entra administrator, so its grants
remain valid after setup.

| Role | Access |
| --- | --- |
| `owner` | No login. Owns the application schema and migration-created objects. No superuser, role administration, database creation, replication, or RLS bypass. |
| `migration` | Separate login with no inherited permissions. Can explicitly select the owner role, but cannot grant that membership to other roles. Used only by the API's startup setup. |
| `runtime` | Separate login without memberships or ownership. Can connect and use the schema. Can read and change tables with enabled and forced RLS. Can only read shared instruction bundles and defaults. |

Runtime access excludes schema changes, temporary objects, truncation, role
administration, owner escalation, migration-ledger access, and unprotected setup
tables. Setup rejects unexpected members of application roles, except for the
current setup login and the migration-to-owner membership. Runtime grants on
tables or views outside `public` also stop setup; readiness checks all non-system
schemas. New tables have no default runtime grants. Rerun role setup after every
approved migration to grant only the reviewed permissions. Unexpected role
attributes, memberships, object ownership, or unprotected tenant tables stop setup
and roll back its transaction. Excess direct runtime table, schema, and database
grants are removed during successful setup.

Production uses `configurePgEntraRoles`. The setup identity is a permanent
Microsoft Entra administrator. Azure restricts `azure_pg_admin` (it has no
CREATEROLE and cannot be a durable grantor), so setup creates roles and grants the
migration-to-owner membership as the setup identity. Database-level grants run as
the database owner, because PostgreSQL applies database ACL changes from the owner.

Azure installs the `pgaadauth` functions only in the `postgres` database. Setup
registers runtime and migration principals through a separate setup connection to
`postgres`, then grants permissions through the `logbook` connection. Registration
creates a missing principal and accepts an existing role with the approved name.
Entra workload passwords are cleared and their password validity is expired. A
workload cannot restore its password validity. Live managed-identity login for
runtime and migration passed on Azure.

Use this only for a dedicated Logbook database. Setup removes PUBLIC database
access, PUBLIC schema creation, and PUBLIC table grants. It does not transfer
existing table ownership or silently repair an unsafe role. Review existing state
privately before use.

## Startup Setup

When `DATABASE_SETUP_CONFIG` is set, the API runs `runDatabaseSetup` before it
listens. The setup identity is the server's only Entra administrator; Azure makes
it the owner of the `logbook` database, which setup accepts. Setup then:

1. Registers the runtime and migration principals and applies role grants.
2. Connects as `migration`, selects `owner`, and runs `migratePgDatabase`.
3. Installs the image's instruction bundle as `owner`, then applies role grants
   again so new tables receive only the reviewed runtime grants.
4. Creates a disposable forced-RLS probe table and verifies tenant read and write
   isolation and denied runtime administrative operations.
5. Removes this probe and any marked probe left by an earlier failed start.

A failed setup stops the start; the container restarts and the previous revision
keeps serving. The log reports the failed stage, error code, and a short message,
never tokens or configuration values. The API serves requests only with the
runtime identity.

## Credential Rotation

Production uses separate Microsoft Entra managed identities for runtime and
migration connections. The production host requires
`DATABASE_MANAGED_IDENTITY_CLIENT_ID` and a passwordless `DATABASE_URL` with
`sslmode=verify-full`. The pool obtains tokens for new physical connections. It
does not use CLI credentials or fall back to passwords. API-user Entra sign-in is
unchanged and is separate from this server-to-database connection.

The protected Entra helper registers and verifies principal mappings. Its local
contract uses test replacements for the Azure principal functions and managed
authentication boundary, with real PostgreSQL permission and transaction checks.
These tests do not prove Azure server administration capabilities or Entra token
authentication. The live operation must verify both.

For local password-based verification, provide `passwords.runtime` and
`passwords.migration` as different random secret values of at least 32 characters.
Setup stores SCRAM-SHA-256 verifiers in the same transaction as the grants. It
returns no credential data. Omitting `passwords` preserves existing credentials;
new login roles cannot use password authentication until credentials are set.
This option does not configure Azure Entra database principals or their tokens.

Deliver each new credential only to its intended private secret reference. Test a
new connection, replace the relevant consumer secret, and recycle its connection
pool in the approved operation. Old passwords no longer permit new connections,
but existing sessions remain active until drained. If secret delivery fails after
the database commit, stop release and use a fresh approved rotation; do not expose
the new value in recovery output. Remove owned temporary files and execution
resources on success and failure.

## Validation

The local contract runs setup through a non-superuser login with explicit
temporary permissions. It uses separate database logins and the actual migrations
and HTTP API. It checks tenant isolation, effective denied operations, repeat
setup, unsafe-state rejection, and password rotation. It does not prove Azure
administrator permissions or Entra token authentication; the deployed API's
`/health/ready` check after startup setup verifies those.