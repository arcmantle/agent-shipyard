-- RLS (ADR9) only restricts non-superuser roles: Postgres superusers bypass
-- row-level security unconditionally, regardless of ENABLE/FORCE ROW LEVEL
-- SECURITY. The docker-compose `POSTGRES_USER` (agent_issues) is created as
-- a superuser by the official postgres image, so it must stay reserved for
-- migrations/admin tasks only. This creates a second, ordinary role for the
-- application (PgStore) to connect as, so RLS is actually enforced in local
-- dev the same way it will be in the real Azure deployment (where the app's
-- Managed Identity is never a database superuser).
CREATE ROLE agent_issues_app LOGIN PASSWORD 'agent_issues_app_dev_only' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT CONNECT ON DATABASE agent_issues TO agent_issues_app;
GRANT USAGE ON SCHEMA public TO agent_issues_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agent_issues_app;

-- Tables created by later migrations (run as the admin/superuser role) are
-- granted to the app role automatically, so this script never needs
-- updating when new tenant-scoped tables are added.
ALTER DEFAULT PRIVILEGES FOR ROLE agent_issues IN SCHEMA public
	GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agent_issues_app;
