# Azure Terraform

This directory prepares Azure Blob storage for Terraform state. It does not yet
deploy PostgreSQL or the Logbook service.

## Deployment Ownership

Routine planning and application now belong to the private
[arcmantle/agent-shipyard-infra](https://github.com/arcmantle/agent-shipyard-infra)
repository. Its README defines the one-time identity setup and activation steps.
The bootstrap in this directory remains the one-time state-storage setup.

Start deployments through the public `Request Logbook Deployment` workflow.
It requests a private plan. A private callback starts the public
`Approve Logbook Deployment` workflow. The `azure-production` environment requires
RoenLie approval before it can send signed authorization to private Apply.
No Azure credentials, raw plans, or state enter the public workflows.

The private application root uses the separate `logbookstate` container, not the
older application backend reservation below. Do not use this directory's
`logbook` root for routine deployment. No application resources exist yet.

Use two separate Terraform roots:

- `bootstrap`: owns the state resource group, storage account, container, and
  operator role assignment. Its state key is `bootstrap.tfstate`.
- `logbook`: reserves the remote backend for the application. Its state key is
  `logbook-prod.tfstate`. It does not yet contain deployment resources.

Keep Terraform configuration and provider lock files in Git. Do not commit state,
saved plans, credentials, or local variable files. The repository ignores these
files. A state file can contain secrets even when outputs are marked sensitive.

## Requirements

- The organization GitHub App must be installed on both deployment repositories.
- The private repository must have the Azure tenant and subscription variables.
- The account used for first sign-in must have permission to create resources
  and assign Azure roles in the private subscription.
- The Azure tenant must permit device-code sign-in for the one-time identity action.

All Azure operations and Terraform execution must run in GitHub Actions. Do not
sign in to Azure or run Terraform locally. Every Azure apply requires RoenLie approval.

The bootstrap grants its current Azure principal Storage Blob Data Contributor on
the dedicated state account. Use the same principal for later bootstrap changes.
The role covers all state keys in that account. Separate keys do not provide
access isolation. A later deployment identity should receive only the required
container access and resource-management permissions.

The account uses a public HTTPS endpoint restricted to the supplied IPv4
addresses, or no data-plane addresses during initial planning. This is not a
private endpoint. IP rules do not grant data access;
Entra ID authorization is also required. Use individual public IPv4 addresses,
not private addresses or CIDR ranges. Azure-hosted runners in the same region need a separate network design;
IP rules alone are not sufficient for that case.

## First Identity

Run private **One-Time Azure Setup** on `main`, with its callback inputs empty.
It requests approval through public **Approve One-Time Azure Setup** and the
existing `azure-production` environment. Only RoenLie can approve that gate.

After approval, open the new private run and complete Microsoft device-code
sign-in from its live log. The action creates the first setup identity, with
temporary subscription Owner permission and OIDC trust restricted to private
`setup.yml` on `main`. It disables itself before sign-in. No state storage or
application resources are created. The private repository README gives the
complete procedure, approved scope, and recovery steps.

Do not send the sign-in code, authentication tokens, or credentials through chat.

## Move Bootstrap State

Private **Setup Azure Infrastructure** prepares a saved state-storage plan with
setup OIDC. Select operation `plan`, stage `state`, and leave callback fields
empty. The public **Approve Azure Infrastructure Setup** gate requires RoenLie approval
before the exact saved binary can apply. The runner retains private recovery
state before migration to `tfstate/bootstrap.tfstate` with Entra ID authorization.
It verifies state lineage, serial, and resources, then removes its temporary IP
rule. The original binary artifact is consumed once before application.

After state storage is ready, private `setup.yml` operation `plan`, stage
`automation`, uses the separate `tfstate/automation.tfstate` key. Public
**Approve Azure Infrastructure Setup** requires approval of its exact saved plan
before restricted Plan and Apply identities, workflow-specific federation, and
state access can be created. Plan receives application Reader; Apply receives
application Contributor. Neither receives role-assignment permission. Review the
dedicated state-account read/write firewall role in the private plan.

The approved Apply verifies distinct identity outputs, a refreshed no-change
plan, private recovery retention, and owned firewall cleanup. Configure private
identity variables from its verified result. Temporary setup Owner and federation
removal require a later approved Actions operation. Keep `DEPLOYMENT_ENABLED=false`
until setup and live verification are complete. Do not substitute local Azure or
Terraform commands. See the private README for failure recovery; initial state
setup refuses an existing state resource group.

Migration must verify the state resources, the remote blob, and a no-change plan
before it removes a recovery copy. State, plans, and credentials must stay private.
Never run two applies during migration. Do not use account keys or anonymous
access to bypass role or firewall propagation failures.

If resource Apply succeeded but the initial migration failed, use private
`setup.yml` operation `request-recovery` with the failed Apply run ID. Public
**Approve Azure State Recovery** requires a separate approval. The private
callback verifies the exact retained artifact and current target, consumes the
request once, and waits for Entra ID blob-list access. It creates only a missing
state blob with an atomic no-overwrite condition. An existing blob must match;
it is never overwritten. Recovery retains the original state artifact and runs
no Terraform Apply. Its no-change plan uses `-refresh=false`, so it checks
configuration against restored state, not live resource drift. Firewall cleanup
runs after failure as well as success. See the private README for the procedure.

## Existing State

An Actions job for an existing installation must restore its remote backend
configuration before any plan or apply. Do not repeat the first local-state
bootstrap for an account that already exists. Migration and reconfiguration are
different operations; reconfiguration does not copy state.

## Logbook Backend

This root is an earlier backend reservation, not the active deployment root.
PostgreSQL, networking, service hosting, and data migration still need separate
configuration in the private repository. The Actions workflows require a
GitHub App and the approved identity and state setup before activation. Routine
application state belongs in the private `logbookstate` container.

## Protection And Recovery

The account disables shared-key and anonymous blob access. It requires HTTPS and
TLS 1.2. Blob versioning is enabled. Blob and container soft delete retain deleted
data for 30 days. LRS replication protects against local hardware failure, not a
regional outage. Version history is not an independent backup.

Terraform uses Blob leases for state locking. Do not disable locking or break a
lease until you confirm that no operation is active. Stop all Terraform writers
before restoring an earlier state version. Review the next plan before applying
because restored state can differ from actual resources.

Resource group, account, and container deletion have `prevent_destroy` guards.
These guards do not stop Azure portal deletion or protect resources after their
configuration is removed. Restrict Azure permissions and protect recovery copies.
Do not run `terraform destroy` on the bootstrap as routine application cleanup.

## Validation

Public **Logbook Infrastructure Checks** validates these roots in GitHub Actions
without Azure sign-in or resource creation. Private **Check Infrastructure**
validates the private roots and runs the deployment and bootstrap contract tests.

Validation does not prove that live Azure permissions, firewall access, state
migration, recovery, or locking work. Verify those through approved Actions runs
before application deployment.