terraform {
  required_version = ">= 1.11, < 2.0"

  # Add a backend, for example azurerm with the bootstrap state storage, before a shared deployment.

  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 5.10"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

provider "azuread" {}

provider "azapi" {}

variable "subscription_id" {
  type = string
}

variable "location" {
  type    = string
  default = "swedencentral"
}

variable "api_image" {
  type = string
}

variable "custom_domain" {
  type    = string
  default = null
}

variable "user_roles" {
  type    = map(string)
  default = {}
}

resource "azurerm_resource_group" "logbook" {
  name     = "rg-logbook"
  location = var.location
}

module "logbook" {
  source = "../../modules/logbook-backend"

  resource_group_name = azurerm_resource_group.logbook.name
  location            = azurerm_resource_group.logbook.location
  api_image           = var.api_image
  custom_domain       = var.custom_domain
  user_roles          = var.user_roles
}

output "service_url" {
  value = module.logbook.service_url
}

output "container_app_fqdn" {
  value = module.logbook.container_app_fqdn
}

output "custom_domain_verification_id" {
  value     = module.logbook.custom_domain_verification_id
  sensitive = true
}
