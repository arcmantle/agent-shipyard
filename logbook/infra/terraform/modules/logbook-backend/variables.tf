variable "resource_group_name" {
  description = "Resource group for all Logbook resources."
  type        = string
}

variable "location" {
  description = "Azure region of the resource group."
  type        = string
}

variable "name_prefix" {
  description = "Prefix for resource and app registration names."
  type        = string
  default     = "logbook"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.name_prefix))
    error_message = "The name prefix must be 2-21 lowercase letters, digits, or hyphens, and start with a letter."
  }
}

variable "api_image" {
  description = "Logbook API container image. Use a digest reference, for example ghcr.io/arcmantle/logbook-api@sha256:<digest>."
  type        = string
}

variable "custom_domain" {
  description = "Optional custom domain for the API and site. Its DNS CNAME must point to the Container App before apply."
  type        = string
  default     = null
}

variable "user_roles" {
  description = "Entra user or group object IDs mapped to a Logbook role: reader, writer, or admin."
  type        = map(string)
  default     = {}

  validation {
    condition     = alltrue([for role in values(var.user_roles) : contains(["reader", "writer", "admin"], role)])
    error_message = "Each role must be reader, writer, or admin."
  }
}

variable "assignment_required" {
  description = "Allow only users with a role assignment to sign in."
  type        = bool
  default     = true
}

variable "postgresql_sku_name" {
  type    = string
  default = "B_Standard_B1ms"
}

variable "postgresql_storage_mb" {
  type    = number
  default = 32768
}

variable "postgresql_storage_tier" {
  type    = string
  default = null
}

variable "log_daily_quota_gb" {
  description = "Daily Log Analytics ingestion cap. Null means no cap."
  type        = number
  default     = null
}

variable "resource_names" {
  description = "Optional name overrides, for example to adopt existing resources."
  type = object({
    postgresql_server         = optional(string)
    log_analytics_workspace   = optional(string)
    container_app_environment = optional(string)
    container_app             = optional(string)
  })
  default = {}
}

variable "existing_entra_client_id" {
  description = "Use this existing app registration instead of creating one. The module then manages only its app roles."
  type        = string
  default     = null
}

variable "existing_database_identities" {
  description = "Use these existing managed identities and PostgreSQL roles instead of creating them."
  type = object({
    owner_role = string
    identities = map(object({
      id           = string
      client_id    = string
      principal_id = string
      role         = string
    }))
  })
  default = null

  validation {
    condition     = var.existing_database_identities == null || try(toset(keys(var.existing_database_identities.identities)) == toset(["setup", "runtime", "migration"]), false)
    error_message = "Existing database identities must be exactly setup, runtime, and migration."
  }
}

variable "backup_retention_days" {
  type    = number
  default = 7
}

variable "max_replicas" {
  type    = number
  default = 1
}
