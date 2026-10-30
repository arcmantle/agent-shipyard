output "service_url" {
  description = "URL for `agent-issues auth login --url` and the hosted site."
  value       = var.custom_domain == null ? "https://${azurerm_container_app.api.ingress[0].fqdn}" : "https://${var.custom_domain}"
}

output "container_app_fqdn" {
  description = "Target for the custom domain CNAME record."
  value       = azurerm_container_app.api.ingress[0].fqdn
}

output "custom_domain_verification_id" {
  description = "Value for the asuid.<custom domain> TXT record."
  value       = azurerm_container_app.api.custom_domain_verification_id
  sensitive   = true
}

output "entra_client_id" {
  value = local.client_id
}

output "entra_tenant_id" {
  value = local.tenant_id
}

output "postgresql_fqdn" {
  value = azurerm_postgresql_flexible_server.logbook.fqdn
}
