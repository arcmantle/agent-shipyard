mock_provider "azapi" {}

mock_provider "azuread" {
  mock_data "azuread_client_config" {
    defaults = {
      object_id = "00000000-0000-4000-8000-000000000005"
    }
  }

  mock_data "azuread_application" {
    defaults = {
      id = "/applications/00000000-0000-4000-8000-000000000031"
    }
  }
}

mock_provider "azurerm" {
  mock_data "azurerm_client_config" {
    defaults = {
      tenant_id       = "00000000-0000-4000-8000-000000000002"
      subscription_id = "00000000-0000-4000-8000-000000000001"
    }
  }
}

variables {
  resource_group_name = "rg-logbook"
  location            = "swedencentral"
  api_image           = "ghcr.io/arcmantle/logbook-api@sha256:1111111111111111111111111111111111111111111111111111111111111111"
  custom_domain       = "logbook.example.com"
}

run "new_backend" {
  command = plan

  assert {
    condition = (
      azurerm_postgresql_flexible_server.logbook.version == "16" &&
      azurerm_postgresql_flexible_server.logbook.public_network_access_enabled &&
      azurerm_postgresql_flexible_server.logbook.delegated_subnet_id == null &&
      one(azurerm_postgresql_flexible_server.logbook.authentication).active_directory_auth_enabled &&
      !one(azurerm_postgresql_flexible_server.logbook.authentication).password_auth_enabled &&
      one(azurerm_postgresql_flexible_server.logbook.authentication).tenant_id == "00000000-0000-4000-8000-000000000002" &&
      azurerm_postgresql_flexible_server_database.logbook.name == "logbook"
    )
    error_message = "PostgreSQL must be version 16 with Entra-only sign-in and the logbook database."
  }

  assert {
    condition = (
      azurerm_postgresql_flexible_server_firewall_rule.azure_services.start_ip_address == "0.0.0.0" &&
      azurerm_postgresql_flexible_server_firewall_rule.azure_services.end_ip_address == "0.0.0.0" &&
      azurerm_postgresql_flexible_server_active_directory_administrator.setup.principal_name == "logbook-db-setup" &&
      azurerm_postgresql_flexible_server_active_directory_administrator.setup.principal_type == "ServicePrincipal" &&
      length(azurerm_user_assigned_identity.database) == 3
    )
    error_message = "Only Azure services may reach PostgreSQL, and the created setup identity must be its Entra administrator."
  }

  assert {
    condition = (
      length(azurerm_container_app_environment.logbook.workload_profile) == 1 &&
      one(azurerm_container_app_environment.logbook.workload_profile).workload_profile_type == "Consumption" &&
      azurerm_container_app_environment.logbook.infrastructure_subnet_id == null &&
      azurerm_container_app_environment.logbook.logs_destination == "log-analytics" &&
      azurerm_log_analytics_workspace.logbook.retention_in_days == 30
    )
    error_message = "The hosting environment must be Consumption only, without a virtual network, with 30-day logs."
  }

  assert {
    condition = (
      azurerm_container_app.api.template[0].min_replicas == 0 &&
      azurerm_container_app.api.workload_profile_name == "Consumption" &&
      azurerm_container_app.api.ingress[0].external_enabled &&
      !azurerm_container_app.api.ingress[0].allow_insecure_connections &&
      azurerm_container_app.api.ingress[0].target_port == 8080 &&
      azurerm_container_app.api.template[0].container[0].image == var.api_image &&
      length(azurerm_container_app.api.secret) == 0 &&
      length(azurerm_container_app.api.registry) == 0
    )
    error_message = "The API must scale to zero, serve HTTPS only, run the exact image with the three database identities, and hold no secrets."
  }

  assert {
    condition = (
      toset([for item in azurerm_container_app.api.template[0].container[0].env : item.name]) == toset(["DATABASE_URL", "DATABASE_MANAGED_IDENTITY_CLIENT_ID", "ENTRA_TENANT_ID", "ENTRA_CLIENT_ID", "DATABASE_SETUP_CONFIG"]) &&
      alltrue([for item in azurerm_container_app.api.template[0].container[0].env : item.secret_name == null]) &&
      length(azurerm_container_app.api.template[0].container[0].startup_probe) == 1
    )
    error_message = "The API must receive only identifiers and passwordless database settings, with a startup probe for database setup."
  }

  assert {
    condition = (
      length(azuread_application_registration.logbook) == 1 &&
      azuread_application_registration.logbook[0].requested_access_token_version == 2 &&
      azuread_application_permission_scope.access_as_user[0].value == "access_as_user" &&
      azuread_application_fallback_public_client.logbook[0].enabled &&
      azuread_service_principal.logbook[0].app_role_assignment_required &&
      [for role in azuread_application_app_role.logbook : role.value] == ["Logbook.Admin", "Logbook.Reader", "Logbook.Writer"]
    )
    error_message = "The new app registration must issue v2 tokens with the access_as_user scope, device-code sign-in, required assignment, and the three roles."
  }

  assert {
    condition = (
      azurerm_container_app_custom_domain.api[0].name == "logbook.example.com" &&
      azapi_update_resource.domain_binding[0].body.properties.configuration.ingress.customDomains[0].bindingType == "SniEnabled" &&
      azurerm_container_app_environment_managed_certificate.api[0].domain_control_validation == "HTTP"
    )
    error_message = "A custom domain must use a managed certificate with SNI binding."
  }
}

run "existing_resources" {
  command = plan

  variables {
    existing_entra_client_id = "00000000-0000-4000-8000-000000000004"
    log_daily_quota_gb       = 0.1
    resource_names = {
      postgresql_server         = "psql-logbook-existing"
      log_analytics_workspace   = "log-logbook-prod"
      container_app_environment = "cae-logbook-prod"
      container_app             = "ca-logbook-api"
    }
    existing_database_identities = {
      owner_role = "logbook_owner"
      identities = {
        setup     = { id = "/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/logbook-db-setup", client_id = sensitive("00000000-0000-4000-8000-000000000011"), principal_id = "00000000-0000-4000-8000-000000000021", role = "logbook-db-setup" }
        runtime   = { id = "/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/logbook-db-runtime", client_id = "00000000-0000-4000-8000-000000000012", principal_id = "00000000-0000-4000-8000-000000000022", role = "logbook_runtime" }
        migration = { id = "/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/logbook-db-migration", client_id = "00000000-0000-4000-8000-000000000013", principal_id = "00000000-0000-4000-8000-000000000023", role = "logbook_migration" }
      }
    }
  }

  assert {
    condition = (
      length(azuread_application_registration.logbook) == 0 &&
      length(azuread_service_principal.logbook) == 0 &&
      length(azuread_application_redirect_uris.site) == 0 &&
      length(azurerm_user_assigned_identity.database) == 0 &&
      alltrue([for role in azuread_application_app_role.logbook : role.application_id == "/applications/00000000-0000-4000-8000-000000000031"])
    )
    error_message = "With existing resources, the module must manage only the app roles of the existing app registration and create no identities."
  }

  assert {
    condition = (
      azurerm_postgresql_flexible_server.logbook.name == "psql-logbook-existing" &&
      azurerm_log_analytics_workspace.logbook.name == "log-logbook-prod" &&
      azurerm_log_analytics_workspace.logbook.daily_quota_gb == 0.1 &&
      azurerm_container_app_environment.logbook.name == "cae-logbook-prod" &&
      azurerm_container_app.api.name == "ca-logbook-api"
    )
    error_message = "Name overrides must keep the existing resource names."
  }

  assert {
    condition = (
      azurerm_postgresql_flexible_server_active_directory_administrator.setup.object_id == "00000000-0000-4000-8000-000000000021" &&
      azurerm_postgresql_flexible_server_active_directory_administrator.setup.principal_name == "logbook-db-setup" &&
      one(azurerm_container_app.api.identity).identity_ids == toset([for kind in ["setup", "runtime", "migration"] : "/subscriptions/s/resourceGroups/g/providers/Microsoft.ManagedIdentity/userAssignedIdentities/logbook-db-${kind}"]) &&
      !issensitive(one(azurerm_container_app.api.identity).identity_ids) &&
      one([for item in azurerm_container_app.api.template[0].container[0].env : item.value if item.name == "ENTRA_CLIENT_ID"]) == "00000000-0000-4000-8000-000000000004" &&
      one([for item in azurerm_container_app.api.template[0].container[0].env : item.value if item.name == "DATABASE_MANAGED_IDENTITY_CLIENT_ID"]) == "00000000-0000-4000-8000-000000000012"
    )
    error_message = "The API and PostgreSQL must use the supplied identities and client ID."
  }
}
