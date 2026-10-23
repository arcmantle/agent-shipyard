terraform {
  required_version = ">= 1.10, < 2.0"

  backend "azurerm" {
    use_azuread_auth = true
  }
}
