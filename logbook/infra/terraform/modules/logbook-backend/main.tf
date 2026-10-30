data "azurerm_client_config" "current" {}

data "azuread_client_config" "current" {}

locals {
  tenant_id    = data.azurerm_client_config.current.tenant_id
  existing_app = var.existing_entra_client_id != null

  names = {
    # PostgreSQL server names are global DNS names; the hash keeps them stable and unique per resource group.
    postgresql_server         = coalesce(var.resource_names.postgresql_server, "psql-${var.name_prefix}-${substr(sha256("${data.azurerm_client_config.current.subscription_id}/${var.resource_group_name}"), 0, 12)}")
    log_analytics_workspace   = coalesce(var.resource_names.log_analytics_workspace, "log-${var.name_prefix}")
    container_app_environment = coalesce(var.resource_names.container_app_environment, "cae-${var.name_prefix}")
    container_app             = coalesce(var.resource_names.container_app, "ca-${var.name_prefix}-api")
  }

  app_roles = {
    reader = { id = "d7515f52-8908-4f2d-b198-9abef697cd00", value = "Logbook.Reader", name = "Logbook Reader", description = "Can read Logbook data." }
    writer = { id = "53b85db7-4789-4a71-9e1b-6a4fc0871f5c", value = "Logbook.Writer", name = "Logbook Writer", description = "Can read and change Logbook project data, but not instructions." }
    admin  = { id = "7e8f467f-8d34-416e-9a54-4bb29c31be78", value = "Logbook.Admin", name = "Logbook Admin", description = "Can change all Logbook data, including instructions." }
  }

  application_id    = local.existing_app ? data.azuread_application.existing[0].id : azuread_application_registration.logbook[0].id
  client_id         = local.existing_app ? var.existing_entra_client_id : azuread_application_registration.logbook[0].client_id
  service_principal = local.existing_app ? one(data.azuread_service_principal.existing[*].object_id) : azuread_service_principal.logbook[0].object_id

  database_roles = {
    setup     = "${var.name_prefix}-db-setup"
    runtime   = "${replace(var.name_prefix, "-", "_")}_runtime"
    migration = "${replace(var.name_prefix, "-", "_")}_migration"
  }
  # Callers can pass identities derived from a sensitive variable; only their presence decides this.
  uses_existing_identities = nonsensitive(var.existing_database_identities != null)
  database_identities = local.uses_existing_identities ? var.existing_database_identities.identities : {
    for kind, role in local.database_roles : kind => {
      id           = azurerm_user_assigned_identity.database[kind].id
      client_id    = azurerm_user_assigned_identity.database[kind].client_id
      principal_id = azurerm_user_assigned_identity.database[kind].principal_id
      role         = role
    }
  }
  database_owner_role = local.uses_existing_identities ? var.existing_database_identities.owner_role : "${replace(var.name_prefix, "-", "_")}_owner"
  database_host       = azurerm_postgresql_flexible_server.logbook.fqdn
}

data "azuread_application" "existing" {
  count     = local.existing_app ? 1 : 0
  client_id = var.existing_entra_client_id
}

data "azuread_service_principal" "existing" {
  count     = local.existing_app && length(var.user_roles) > 0 ? 1 : 0
  client_id = var.existing_entra_client_id
}

# Entra ID app registration: the CLI and the hosted site both sign in with it, and the API accepts only its tokens.
resource "azuread_application_registration" "logbook" {
  count                          = local.existing_app ? 0 : 1
  display_name                   = var.name_prefix
  sign_in_audience               = "AzureADMyOrg"
  requested_access_token_version = 2
}

resource "azuread_application_owner" "logbook" {
  count           = local.existing_app ? 0 : 1
  application_id  = local.application_id
  owner_object_id = data.azuread_client_config.current.object_id
}

resource "azuread_application_fallback_public_client" "logbook" {
  count          = local.existing_app ? 0 : 1
  application_id = local.application_id
  enabled        = true
}

resource "azuread_application_identifier_uri" "logbook" {
  count          = local.existing_app ? 0 : 1
  application_id = local.application_id
  identifier_uri = "api://${local.client_id}"
}

resource "azuread_application_permission_scope" "access_as_user" {
  count                      = local.existing_app ? 0 : 1
  application_id             = local.application_id
  scope_id                   = "0b0e2c7a-3f0b-4f43-9a1e-6a3d1c2f8e51"
  value                      = "access_as_user"
  type                       = "User"
  admin_consent_display_name = "Access Logbook"
  admin_consent_description  = "Access Logbook as the signed-in user."
  user_consent_display_name  = "Access Logbook"
  user_consent_description   = "Access Logbook as you."
}

resource "azuread_application_app_role" "logbook" {
  for_each             = local.app_roles
  application_id       = local.application_id
  role_id              = each.value.id
  value                = each.value.value
  display_name         = each.value.name
  description          = each.value.description
  allowed_member_types = ["User"]
}

resource "azuread_application_redirect_uris" "site" {
  count          = local.existing_app ? 0 : 1
  application_id = local.application_id
  type           = "SPA"
  redirect_uris = compact([
    "https://${azurerm_container_app.api.ingress[0].fqdn}/",
    var.custom_domain == null ? null : "https://${var.custom_domain}/",
  ])
}

resource "azuread_service_principal" "logbook" {
  count                        = local.existing_app ? 0 : 1
  client_id                    = local.client_id
  owners                       = [data.azuread_client_config.current.object_id]
  app_role_assignment_required = var.assignment_required
}

resource "azuread_app_role_assignment" "users" {
  for_each            = var.user_roles
  app_role_id         = azuread_application_app_role.logbook[each.value].role_id
  principal_object_id = each.key
  resource_object_id  = local.service_principal
}

# The API prepares the database on start: setup is the Entra administrator, runtime serves requests, migration owns schema changes.
resource "azurerm_user_assigned_identity" "database" {
  for_each            = local.uses_existing_identities ? {} : local.database_roles
  name                = "${var.name_prefix}-db-${each.key}"
  resource_group_name = var.resource_group_name
  location            = var.location
}

resource "azurerm_postgresql_flexible_server" "logbook" {
  name                          = local.names.postgresql_server
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = "16"
  sku_name                      = var.postgresql_sku_name
  storage_mb                    = var.postgresql_storage_mb
  storage_tier                  = var.postgresql_storage_tier
  auto_grow_enabled             = false
  backup_retention_days         = var.backup_retention_days
  geo_redundant_backup_enabled  = false
  public_network_access_enabled = true

  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = local.tenant_id
  }

  lifecycle {
    ignore_changes = [zone]
  }
}

# 0.0.0.0 is Azure's marker for "allow Azure services"; it does not open the server to the internet.
resource "azurerm_postgresql_flexible_server_firewall_rule" "azure_services" {
  name             = "allow-azure-services"
  server_id        = azurerm_postgresql_flexible_server.logbook.id
  start_ip_address = "0.0.0.0"
  end_ip_address   = "0.0.0.0"
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "setup" {
  server_name         = azurerm_postgresql_flexible_server.logbook.name
  resource_group_name = var.resource_group_name
  tenant_id           = local.tenant_id
  object_id           = local.database_identities.setup.principal_id
  principal_name      = local.database_identities.setup.role
  principal_type      = "ServicePrincipal"
}

# The API requires the database name "logbook".
resource "azurerm_postgresql_flexible_server_database" "logbook" {
  name      = "logbook"
  server_id = azurerm_postgresql_flexible_server.logbook.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

resource "azurerm_log_analytics_workspace" "logbook" {
  name                = local.names.log_analytics_workspace
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = 30
  daily_quota_gb      = var.log_daily_quota_gb
}

resource "azurerm_container_app_environment" "logbook" {
  name                       = local.names.container_app_environment
  resource_group_name        = var.resource_group_name
  location                   = var.location
  logs_destination           = "log-analytics"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.logbook.id

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

resource "azurerm_container_app" "api" {
  depends_on = [
    azurerm_postgresql_flexible_server_active_directory_administrator.setup,
    azurerm_postgresql_flexible_server_firewall_rule.azure_services,
    azurerm_postgresql_flexible_server_database.logbook,
  ]

  name                         = local.names.container_app
  resource_group_name          = var.resource_group_name
  container_app_environment_id = azurerm_container_app_environment.logbook.id
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [for kind in ["setup", "runtime", "migration"] : local.database_identities[kind].id]
  }

  ingress {
    external_enabled           = true
    allow_insecure_connections = false
    target_port                = 8080
    transport                  = "http"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 0
    max_replicas = var.max_replicas

    container {
      name   = "api"
      image  = var.api_image
      cpu    = 0.25
      memory = "0.5Gi"

      env {
        name  = "DATABASE_URL"
        value = "postgres://${local.database_identities.runtime.role}@${local.database_host}/logbook?sslmode=verify-full"
      }
      env {
        name  = "DATABASE_MANAGED_IDENTITY_CLIENT_ID"
        value = local.database_identities.runtime.client_id
      }
      env {
        name  = "ENTRA_TENANT_ID"
        value = local.tenant_id
      }
      env {
        name  = "ENTRA_CLIENT_ID"
        value = local.client_id
      }
      env {
        name = "DATABASE_SETUP_CONFIG"
        value = jsonencode({
          database_url = "postgres://${local.database_host}/logbook?sslmode=verify-full"
          tenant_id    = local.tenant_id
          owner_role   = local.database_owner_role
          identities = {
            for kind, identity in local.database_identities : kind => {
              client_id    = identity.client_id
              principal_id = identity.principal_id
              role         = identity.role
            }
          }
        })
      }

      # Database setup runs before the server listens; liveness starts only after this probe passes.
      startup_probe {
        transport               = "HTTP"
        port                    = 8080
        path                    = "/health/live"
        interval_seconds        = 30
        failure_count_threshold = 10
      }

      liveness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/health/live"
      }

      readiness_probe {
        transport = "HTTP"
        port      = 8080
        path      = "/health/ready"
      }
    }
  }
}

resource "azurerm_container_app_custom_domain" "api" {
  count            = var.custom_domain == null ? 0 : 1
  name             = var.custom_domain
  container_app_id = azurerm_container_app.api.id

  lifecycle {
    # azapi_update_resource.domain_binding owns the binding; azurerm cannot reference managed certificates.
    ignore_changes = [certificate_binding_type, container_app_environment_certificate_id]
  }
}

resource "azurerm_container_app_environment_managed_certificate" "api" {
  count                        = var.custom_domain == null ? 0 : 1
  depends_on                   = [azurerm_container_app_custom_domain.api]
  name                         = replace(var.custom_domain, ".", "-")
  container_app_environment_id = azurerm_container_app_environment.logbook.id
  subject_name                 = var.custom_domain
  domain_control_validation    = "HTTP"
}

resource "azapi_update_resource" "domain_binding" {
  count       = var.custom_domain == null ? 0 : 1
  type        = "Microsoft.App/containerApps@2024-03-01"
  resource_id = azurerm_container_app.api.id
  body = {
    properties = {
      configuration = {
        ingress = {
          customDomains = [{
            name          = azurerm_container_app_custom_domain.api[0].name
            bindingType   = "SniEnabled"
            certificateId = azurerm_container_app_environment_managed_certificate.api[0].id
          }]
        }
      }
    }
  }
}
