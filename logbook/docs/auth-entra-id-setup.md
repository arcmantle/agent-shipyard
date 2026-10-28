# Setting up Entra ID for `agent-issues auth login`

This guide walks through creating the Azure Entra ID (formerly Azure AD) app
registration that `agent-issues auth login` needs, and how to plug the
resulting values into the CLI. You only need to do this once per Azure
tenant. Nothing here requires an Azure subscription with billing - Entra ID
app registrations are free.

If you don't have an Azure tenant yet, sign up for a free one at
[azure.microsoft.com/free](https://azure.microsoft.com/free/) - it comes
with its own Entra ID tenant automatically.

## 1. Create the app registration

1. Go to the [Microsoft Entra admin center](https://entra.microsoft.com/) (or
   the Azure Portal → search "Microsoft Entra ID" → "App registrations").
2. Click **New registration**.
3. Fill in:
   - **Name**: something recognizable, e.g. `agent-issues-cli`.
   - **Supported account types**: "Accounts in this organizational directory
     only" (single tenant) is fine for personal/small-team use.
   - **Redirect URI**: leave blank. The device-code flow this CLI uses
     doesn't need one.
4. Click **Register**.

## 2. Note the tenant ID and client ID

On the app registration's **Overview** page, copy two GUIDs:

- **Application (client) ID** identifies the public client used by the service.
- **Directory (tenant) ID** identifies the tenant accepted by the service.

Configure both values on the remote service. The CLI discovers them from the
service metadata endpoint during login.

## 3. Enable public-client (device-code) authentication

The CLI signs in using Entra's device-code flow, which requires the app
registration to allow public-client (no client secret) authentication:

1. In the app registration, go to **Authentication** (left sidebar).
2. Scroll to **Advanced settings**.
3. Set **Allow public client flows** to **Yes**.
4. Click **Save**.

No redirect URI, client secret, or certificate is needed for this flow.

### Expose the API scope

The service accepts only access tokens that are issued for this app
registration and carry the delegated `access_as_user` scope. It rejects
Microsoft Graph tokens and app-only tokens.

1. Go to **Expose an API**. Next to **Application ID URI**, click **Add** and
   accept the default `api://<client-id>`. Click **Save**.
2. Click **Add a scope** and fill in:
   - **Scope name**: `access_as_user`
   - **Who can consent**: Admins and users
   - **Admin consent display name**: `Access Logbook`
   - **Admin consent description**: `Access Logbook as the signed-in user.`
   - **State**: Enabled
3. Go to **Manifest**. Set `requestedAccessTokenVersion` (in the `api`
   object) to `2`, then click **Save**. Version 2 tokens use the client ID as
   the audience and the `/v2.0` issuer that the service validates.
4. Go to **API permissions** and remove `Microsoft Graph → User.Read`. The
   CLI does not use Microsoft Graph.

### Restrict sign-in to assigned users

1. Go to **Enterprise applications**, then open the application with the same
   name.
2. Go to **Properties**, set **Assignment required?** to **Yes**, and click
   **Save**.
3. Go to **Users and groups** and add each user who can use the service. To
   add a person from outside the tenant, invite the person as a guest under
   **Users → Invite external user** first, then assign the guest.

Entra then refuses to issue a token to a user who is not assigned.

## 4. Run the CLI login

Start the interactive login:

```bash
agent-issues auth login
```

The CLI prompts for a saved-login name and service URL. For one-shot or
automated use, supply both explicitly:

```bash
agent-issues auth login --name work --url https://agent-issues.example.com
```

The CLI reads the service's tenant and client IDs from
`/.well-known/agent-issues`, then prints a verification URL (normally
`https://microsoft.com/devicelogin`) and a short code. Open the URL in any
browser, sign in with the Entra ID account you want the CLI to use, and
enter the code when prompted. Once you approve, the CLI finishes signing in
and caches the session locally.

## 5. Everyday commands

Once logged in:

```bash
agent-issues auth list            # lists local first, then remotes in creation order
agent-issues auth status          # shows the globally active login and destination
agent-issues auth switch work     # activates local or a named remote directly
agent-issues auth switch          # advances local -> each remote -> local
agent-issues auth logout work     # removes a remote saved login
```

The active saved login controls the destination of subsequent CLI requests.
Bare `auth switch` follows the order shown by `auth list` and wraps to local
after the last remote. Removing the active remote with `auth logout` changes
the active login to local atomically. The permanent local login cannot be
removed.

`auth status` never prints the raw access token, in either human or
`--json` output; the same redaction applies to the other auth commands.
Remote saved-login credentials live in the OS credential store, not in
plaintext files.

## Troubleshooting

- **"AADSTS7000218: The request body must contain the following parameter:
  'client_assertion' or 'client_secret'"** - public client flows aren't
  enabled yet. Revisit [step 3](#3-enable-public-client-device-code-authentication).
- **"AADSTS50020: User account ... does not exist in tenant"** - you signed
  in with an account from a different tenant than the remote service
  discovered for login. Either sign in with an account that belongs to that
  tenant, or change **Supported account types** on the app registration to
  allow accounts from other organizations/personal Microsoft accounts.
- **The device code expires before you finish signing in** - just re-run
  `agent-issues auth login`; each attempt issues a fresh code.
