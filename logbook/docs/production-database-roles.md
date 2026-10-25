# Production Database Roles

This operation uses protected GitHub Actions execution. Its local contracts have
passed against a disposable PostgreSQL database. Live Azure verification is not
complete. A separate protected database setup workflow is in the private
infrastructure repository. Do not use a public runner to connect to PostgreSQL or
reopen retired setup access. Local preparation is not publication or execution
approval.

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
execution. This does not grant Microsoft Graph tenant administration. The
separate database executor remains available for its protected operation, but its
resource-group boundary does not constrain the general Owner identity. Runtime,
migration, and schema-owner database permissions remain separate and unchanged.

## Role Contract

`configurePgRoles(pool, roles, passwords?)` is exported by
`@agent-issues/api-pg`. It configures a dedicated database and its `public` schema.
Role names must be distinct lowercase PostgreSQL identifiers, at most 63 bytes.
The operation requires PostgreSQL 16 or newer.

The helper supports a non-superuser setup login with explicit permissions. The
approved setup operation must provide database ownership, administration of the
three application roles, permission to select the schema owner, and database
CREATE permission for the schema owner during ownership setup. Do not use
inherited owner permissions. The helper selects the owner only for schema grants
and default privileges, then restores the setup role before credential changes.
It does not grant or remove the setup identity's temporary capabilities.

| Role | Access |
| --- | --- |
| `owner` | No login. Owns the application schema and migration-created objects. No superuser, role administration, database creation, replication, or RLS bypass. |
| `migration` | Separate login with no inherited permissions. Can explicitly select the owner role, but cannot grant that membership to other roles. Available only to the approved migration operation. |
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

Production uses `configurePgEntraRoles`. Its separate setup login must be able to
select the existing `azure_pg_admin` server administration role. This permanent
NOLOGIN role, not the temporary setup login, grants the migration-to-owner
membership. Memberships from this server administration role are allowed only in
the Entra setup path. Other incoming members still stop setup. The local
password-based helper does not add this exception.

Entra registration and grants share one transaction. Existing principal mappings
must match the approved object ID, tenant, service type, and non-administrator
attributes. An unmapped existing login or changed mapping stops setup. Setup does
not silently relabel roles. Entra workload passwords are cleared and their
password validity is expired. A workload cannot restore its password validity.
The live managed-identity login must still pass; local tests do not prove that the
Azure Entra authentication path accepts this restriction.

Use this only for a dedicated Logbook database. Setup removes PUBLIC database
access, PUBLIC schema creation, and PUBLIC table grants. It does not transfer
existing table ownership or silently repair an unsafe role. Review existing state
privately before use.

## Approved Execution Procedure

1. Obtain permission to publish the reviewed source and image. Build the setup
   image through the manual image workflow. The private callback verifies its
   GitHub provenance, exact source revision, digest, and anonymous pull access.
   A newly created GHCR package can require a separate public-visibility change.
2. Use the normal protected infrastructure Plan and Apply to enable Entra
   authentication while retaining password recovery. Do not restore retired setup
   access. Use the reviewed general Terraform access model above.
3. Install the separate database executor's GitHub OIDC trust once through the
   protected `bootstrap-oidc` operation. Its initial Azure administrator sign-in
   creates only the reviewed custom role assignments: administrator management
   on the exact PostgreSQL server, join access to the existing environment, and
   managed identities and jobs in the isolated setup group. It grants no Owner
   role, role administration, password reset, or routine deployment permissions.
   Keep the exact returned executor client ID in the private target.
4. Request protected approval for identity provisioning, then for database setup.
   The private review binds the target, three distinct managed identities, source,
   image, operation, total monthly estimate, and expiry. Provisioning and setup
   have separate single-use claims. The privileged job and identities use an
   isolated resource group. This does not restrict general Terraform Owner. The job
   uses the existing private Consumption environment, one replica, no automatic
   retry, no ingress, and a finite timeout. After each public approval, the
   private callback verifies approval and signs in automatically with the
   separate executor. No device code or second approval is required. The
   database setup identity receives no ARM roles or GitHub federation.
5. The setup command verifies exact Entra mappings and effective grants. A
   disposable forced-RLS table verifies both tenant read and write isolation and
   denied runtime administrative operations. It is not an application migration.
   The command removes this table, temporary schema-owner CREATE permission, and
   setup grants that it can revoke. It rejects retained setup object ownership.
6. The controller stops and removes the job, removes the temporary Entra
   administrator assignment, and starts a fresh verification job. Authentication
   denial alone is insufficient: the runtime connection must also verify that no
   setup membership or ownership remains. The migration identity must still be
   able to select the owner. Network, TLS, token, or timeout errors do not count as
   verified login denial. Remove the verification job before reporting success.
7. In the separate approved migration operation, connect as `migration` and select
   `owner` on every connection, for example with PostgreSQL connection option
   `-c role=<approved-owner-role>`. Run `migratePgDatabase`, then run the approved
   role setup operation again. The transaction-local tenant setting remains the
   API's tenant-isolation boundary. Runtime credentials are trusted only by the
   API, never by browser users or direct untrusted database clients.
8. Supply only the runtime connection to the application. Do not supply setup or
   migration credentials to the application container or browser. Retain a
   sanitized effective-grant and two-tenant verification result privately. A
   successful connection alone does not prove isolation.

All Azure and Terraform execution stays in Actions. Cancellation cleanup is a
separate always-run step. Runner loss or failed cleanup is not a success: stop
release and request a new reconciliation approval tied to the original
verification table. Do not replay a consumed approval. Keep request and result
artifacts private. Do not log tokens, passwords, raw database errors, or private
target values.

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

## Validation And Remaining Gate

The local contract runs setup through a non-superuser login with explicit
temporary permissions. It uses separate database logins and the actual migrations
and HTTP API. It checks tenant isolation, effective denied operations, repeat
setup, unsafe-state rejection, and password rotation. It does not prove Azure
administrator permissions, private Azure network access, production grants,
secret delivery, or approval enforcement.

Live completion requires an approved private-network setup operation, an approved
setup identity, verified Entra mappings and cleanup, and
sanitized production verification. Do not mark the issue complete before these
checks pass. No local Azure or Terraform execution is permitted.