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

- Terraform 1.10 or newer, below version 2.
- Azure CLI for the manual deployment steps below.
- An Azure subscription and a selected region.
- Permission to create resource groups and storage accounts, and to assign Azure
  roles. Subscription Owner is sufficient. Contributor alone cannot assign roles.
- The public IPv4 address of the machine that runs Terraform.

The bootstrap grants its current Azure principal Storage Blob Data Contributor on
the dedicated state account. Use the same principal for later bootstrap changes.
The role covers all state keys in that account. Separate keys do not provide
access isolation. A later deployment identity should receive only the required
container access and resource-management permissions.

The account uses a public HTTPS endpoint restricted to the supplied IPv4
addresses. This is not a private endpoint. IP rules do not grant data access;
Entra ID authorization is also required. Use individual public IPv4 addresses,
not private addresses or CIDR ranges. Replace the documentation address in the
example. Azure-hosted runners in the same region need a separate network design;
IP rules alone are not sufficient for that case.

## First Bootstrap

Run these commands from this directory. This section is only for the first
creation of a new state account. If the account already exists, use
[Existing State](#existing-state) before any plan or apply.

Sign in and select the subscription. The subscription ID is not a secret.

```sh
az login
export ARM_SUBSCRIPTION_ID="<subscription-id>"
az account set --subscription "$ARM_SUBSCRIPTION_ID"
export ARM_USE_CLI=true
```

Prepare the local variables:

```sh
cp bootstrap/terraform.tfvars.example bootstrap/terraform.tfvars
```

Set the region, a globally unique storage account name, and your public IPv4
address in `bootstrap/terraform.tfvars`. The sample region is not a requirement.
Changing the region or account name later can require resource replacement,
which the deletion guards will reject.

Do not create `bootstrap/backend.tf` yet. The first apply uses local state.

```sh
terraform -chdir=bootstrap init -input=false
terraform -chdir=bootstrap plan -out=bootstrap.tfplan
terraform -chdir=bootstrap apply bootstrap.tfplan
terraform -chdir=bootstrap output backend
```

Review the plan before the apply. These commands create billable Azure resources.
Keep the local state and its backup secure until migration is verified. Do not
publish terminal output or plans that contain secrets.

Azure role assignments and firewall changes can take time to become effective.
If container creation returns an authorization error, check the identity, role,
and public IP. After Azure has applied the changes, rerun the plan and apply.
Do not enable account keys or anonymous access to bypass the error.

## Move Bootstrap State

After the first apply succeeds, prepare the remote backend:

```sh
cp bootstrap/backend.hcl.example bootstrap/state.backend.hcl
cp bootstrap/backend.tf.example bootstrap/backend.tf
```

Set the account name and tenant ID in `bootstrap/state.backend.hcl` from the
`backend` output. Retain the `bootstrap.tfstate` key. The backend block enables
Entra ID access; it does not use account keys. Do not put credentials in backend
configuration files.

```sh
terraform -chdir=bootstrap init -migrate-state -backend-config=state.backend.hcl
terraform -chdir=bootstrap state list
terraform -chdir=bootstrap plan
```

Approve the state copy when Terraform asks. Verify that the state list contains
the bootstrap resources and the plan reports no changes. Check that the
`bootstrap.tfstate` blob exists in the `tfstate` container. Keep the local backup
until these checks succeed. Never run two applies during migration.

## Existing State

On a new checkout, create `bootstrap/backend.tf` and `bootstrap/state.backend.hcl`
from the examples **before any bootstrap plan or apply**. Restore the same account
name, tenant ID, key, and variables. Then run:

```sh
terraform -chdir=bootstrap init -backend-config=state.backend.hcl -input=false
terraform -chdir=bootstrap state list
```

Do not repeat the local-state bootstrap for an existing installation. Do not use
`-reconfigure` instead of `-migrate-state` when moving existing local state.

## Logbook Backend

After the bootstrap state is in Azure:

```sh
cp logbook/backend.hcl.example logbook/state.backend.hcl
```

Set the same account name and tenant ID in this file. Keep the distinct
`logbook-prod.tfstate` key. Use another key for a later development environment.

```sh
terraform -chdir=logbook init -backend-config=state.backend.hcl -input=false
terraform -chdir=logbook validate
```

This root is an earlier backend reservation, not the active deployment root.
PostgreSQL, networking, service hosting, and data migration still need separate
configuration in the private repository. The Actions workflows require a
GitHub App, the one-time Azure setup, and publication before activation.

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

## Local Validation

These checks need provider downloads but no Azure login or resource creation:

```sh
terraform fmt -check -recursive
terraform -chdir=bootstrap init -backend=false -input=false
terraform -chdir=bootstrap validate
terraform -chdir=logbook init -backend=false -input=false
terraform -chdir=logbook validate
```

Validation does not prove that Azure permissions, firewall access, state
migration, recovery, or locking work. Check those during the first deployment.
After validation with `-backend=false`, run the normal backend initialization
before any plan or apply against an existing installation.