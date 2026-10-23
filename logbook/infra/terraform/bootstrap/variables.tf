variable "location" {
  description = "Azure region for Terraform state storage."
  type        = string
  nullable    = false
}

variable "storage_account_name" {
  description = "Globally unique state storage account name."
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9]{3,24}$", var.storage_account_name))
    error_message = "Use 3 to 24 lowercase letters or digits."
  }
}

variable "allowed_ipv4_addresses" {
  description = "Approved public IPv4 addresses. An empty set keeps data-plane access closed."
  type        = set(string)
  nullable    = false

  validation {
    condition = alltrue([
      for address in var.allowed_ipv4_addresses :
      can(cidrhost("${address}/32", 0)) && !strcontains(address, ":")
    ])
    error_message = "Supply at least one IPv4 address without a CIDR suffix."
  }
}
