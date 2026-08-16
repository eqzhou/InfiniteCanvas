# Multi-tenant accounts (local)

Goal: isolate projects, assets, prompts, generation jobs, secrets, and blobs per account so local multi-user usage does not mix data.

## Model
- **Tenant** = workspace boundary for data
- **User** = login identity belonging to one tenant
- **Tenant Owner** = tenant-scoped administrator for members, tenant resources,
  policies, and tenant-owned provider channels
- **Tenant User** = ordinary tenant member; can use resources and channels that
  are available to the tenant, but cannot administer them
- **Platform Admin** = deployment-controlled global operator; this is a
  capability separate from the tenant role and may coexist with a normal user
  or Owner role in that user's own tenant
- **Session** = opaque token (`X-OpenBoard-Session`) independent of the machine service token

## Settings ownership

Platform administration and tenant ownership are independent capabilities.
The UI and API split settings by the resource being changed, not by a generic
"admin" label:

| Scope | Who may write | Settings and operations |
|------|---------------|-------------------------|
| Platform | Platform Admin | Registration policy; all-tenant and all-account visibility; account suspension/restoration; tenant hard quota; credit issuance; global model credit costs; platform channel catalog, publishing audience, and platform provider secrets; approval of new server-side private-network storage destinations; explicitly enabled account-backed host execution |
| Tenant | Tenant Owner of that tenant | Member invitations and tenant roles; tenant model/channel policy; tenant-owned shared channels and secrets; prompt catalog and sources; shared material library; tenant storage pool; AI-call-log retention; full-workspace backup/restore, complete-project import, project deletion, and generation-history cleanup; read-only quota, usage, and credit ledgers |
| Personal | The signed-in user | Theme, language, canvas preferences, personal system prompts; direct-connect channels and API keys; personal integrations and object-storage credentials; personal workflow templates, single-project export, and other per-user configuration |

A Platform Admin who is a normal user in a tenant gets only the Platform row
plus their Personal row. They do not inherit Tenant Owner access. Likewise, a
Tenant Owner cannot issue credits, raise the tenant hard quota, change global
model pricing, publish a platform channel, or grant Platform Admin capability.
Ordinary users can consume tenant channels and platform channels published to
their tenant, but cannot read either channel's stored provider credential.

## Auth modes (`OPENBOARD_AUTH_MODE`)
| Mode | Behavior |
|------|----------|
| `off` | No user login; all data stays on tenant `local`. Process-sensitive routes still validate `OPENBOARD_TOKEN` |
| `optional` | Zero-user bootstrap on tenant `local` requires the dedicated one-time bootstrap token; after the first user exists, protected data-plane routes require a valid session |
| `required` | Protected data-plane routes require a valid session from the start |

Service token (`OPENBOARD_TOKEN` / Vite proxy `Authorization`) remains for
process-level access and zero-user bootstrap. In account modes it never grants
a tenant identity and cannot bypass the login wall once accounts exist.
Projects, state, blobs, files, generation history, and shared channels
and paid generation require a session after the first user (or always in
`required`). Encrypted provider-secret reads and writes use the same rule;
`off` mode revalidates the process token.

## First user
The first registered user becomes **owner of tenant `local`**, claiming existing formal-local data. Later registrations create a new empty personal tenant.

## Role boundaries and compatibility
The business role model has two tenant roles: `owner` and `user`. The
platform-admin capability is orthogonal and is never granted by changing a
tenant role. Platform Admins own the global tenant/user operations surface,
the platform channel catalog, and platform provider secrets. Owners administer
only their current tenant. Users consume enabled tenant or published platform
channels and have no administrative write access.

The legacy database values `admin` and `member` remain readable during rolling
upgrades. Because the former `admin` role already had tenant-management
authority, it is canonicalized to `owner`; silently mapping it to a normal user
would be a breaking privilege loss. Schema migration 27 rewrites existing
legacy `admin` accounts to `owner`. A pending legacy admin invitation is also
canonicalized to Owner when consumed. New invitations create only ordinary
users, and new role changes create only `owner` or `member` (`member` is the
storage value for the business `user` role).

Schema migration 28 adds immutable `user_id` ownership to generation history.
Existing rows first recover their original active account from same-tenant
billing, usage, AI-call, or trusted server-executor evidence. Film-stage parents
inherit an account only when every child resolves to the same account; only rows
without reliable evidence fall back to a deterministic active account, preferring
an Owner. Account-mode workers refuse to claim any row that still has no owner.
On a zero-user installation, the first bootstrap Owner atomically claims the
legacy tasks and personal configuration. Deploy this migration with a stop/start
cutover: stop every old API and generation worker, wait for the processes to
exit, start the new binary so it runs the migration, and only then restore
traffic. Do not run pre-v28 and v28 workers together. Tenant/platform policy
writes keep the legacy `sitePolicy` projection synchronized for rollback
compatibility, but that projection is not an authorization boundary.

## Platform administration and invitations
The first account is the only registration that may claim the existing `local`
tenant. Set a random `OPENBOARD_BOOTSTRAP_TOKEN` and send it once in the
`X-OpenBoard-Bootstrap-Token` header. The normal process token is not accepted
for this operation because a reverse proxy may inject it into every request.
After the first account exists, clear the bootstrap token.
The first account must use the password-registration bootstrap flow; OAuth may
log in an existing linked account or create later accounts only while platform
registration is enabled, but it cannot claim the initial `local` tenant.

Set `OPENBOARD_PLATFORM_ADMIN_USER_IDS` to a comma-separated list of exact,
server-generated account IDs. Those accounts receive a separate platform-admin
capability and can inspect all tenants, change monthly quotas, adjust credits,
manage platform channels, and suspend or restore accounts. Email allowlists are
not accepted: password registration does not prove mailbox ownership. This
capability is deployment-controlled, is not a tenant role, and cannot be
granted by an HTTP request. Auth-off deployments continue to use the process
token for platform routes.

Tenant owners can create one-time invitations from the same admin panel. The
raw token is returned only when the invitation is created and is
stored as a hash. A new registration can follow the invite URL; the
registration transaction verifies the email, expiry, role, and consumes the
token before joining the existing tenant. Accounts remain single-tenant for
now, so an already registered account cannot join a second tenant without a
future membership/active-tenant migration.
Invite links use a URL fragment so the one-time token is not sent as an HTTP
Referer; the registration page removes it after a successful sign-in.

### Platform channel catalog
Platform Admins maintain a global channel catalog at `/api/platform/channels`.
Each channel is published either to all tenants (`publishToAll: true`) or to
an explicit `tenantIds` list. Provider destinations and secrets remain
platform-admin-only; tenant `GET /api/shared-channels` responses expose only
the public selectable metadata. Tenant-owned channels continue to take
precedence when their ID overlaps a platform channel, which allows a tenant
to override or disable a global definition without changing the global
catalog.

To move an existing tenant channel into the platform catalog, use the migration
endpoint as an account that has both Platform Admin capability and Owner role
in the source tenant. Requiring both prevents a platform-only operator from
copying a tenant-owned secret. The operation leaves the source channel intact
for rollback and is safe to retry:

```sh
curl -X POST https://<host>/api/platform/channels/migrate-local \
  -H 'X-OpenBoard-Session: <dual-capability-account-session>' \
  -H 'Content-Type: application/json' \
  -d '{"sourceTenantId":"local","channelIds":["<channel-id>"],"publishToAll":true}'
```

After deployment, migrate the existing `gpt-imager2` channel by replacing
`<channel-id>` with the ID shown in the local tenant channel catalog, then
verify it from every tenant through `GET /api/shared-channels` and a test
generation. Remove the source tenant copy only after verification and a
rollback window.

## Billing (local foundation)
- Plan + storage/generation quotas on the tenant
- Usage events for generation counts and storage checks
- UI shows plan and monthly generation usage (no payment processor)

## Copyright
Independent OpenBoard feature; not derived from upstream AGPL source.

## API notes
- Public/auth bootstrap routes are limited to health/version, register/login/logout,
  OAuth callbacks, `auth/me`, `auth/usage`, site policy, billing estimate,
  public model metadata, short-lived media-reference reads, and
  `GET /api/runtime/ws` (ticket-authenticated WebSocket upgrade). Each handler may
  still apply stricter checks; for example `auth/me` returns a self-identifying
  guest only in `optional`, while `required` returns 401.
- `GET /api/auth/usage` always returns 401 without a session in account modes
  (`optional` and `required`) so guests cannot read default-tenant counters.
- Optional zero-user bootstrap still requires `OPENBOARD_TOKEN` on protected
  data-plane routes; after the first user exists, anonymous optional-mode
  requests receive 401 for projects, state, blobs, files and shared channels.
- Login navigation preserves the originally requested SPA route and returns to
  it after successful authentication.
- Blobs live under `data/blobs/<tenantId>/…` (or the configured object store with
  hashed tenant prefixes). Reads for tenant `local` also fall back to the
  pre-migration flat `data/blobs/` layout.
- Runtime/agent file drops live under `data/files/<tenantId>/…`; downloads set
  `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, and
  `Cache-Control: private, no-store`.
- Public media-reference tokens are tenant-bound, short-lived, and single-purpose.
  Non-media content types are served as attachments; image/audio/video stay
  inline for provider fetch.
- Runtime tickets/clients and Codex/Claude profiles, sessions, events, approvals,
  and attachments are isolated by tenant plus user. Ticket minting
  (`POST /api/runtime/ticket`) is on the protected data plane; the WebSocket
  upgrade authenticates only with the single-use ticket.
- Account-backed host CLI execution fails closed unless the deployer explicitly
  sets `OPENBOARD_AGENT_ACCOUNT_EXECUTION=true`; this is for trusted self-hosted
  accounts and is not an OS/container tenant sandbox.
- `OPENBOARD_AGENT_WORKSPACE_ROOTS` bounds canonical Codex/Claude CWDs and rejects
  traversal or symlink escape; agent subprocesses receive a minimal environment
  allowlist instead of server credentials.
- Local MCP stdio (`openboard-mcp`) executes tools under tenant `local` unless a
  remote connection file points at `/api/agent/execute`. Process tokens
  (`{"token":"..."}`) work for auth-off / zero-user bootstrap; after accounts
  exist use a session credential (`{"token":"...","session":true}`) so the
  request carries `X-OpenBoard-Session` and runs under that user/tenant.
  Account-owned Claude sessions do not receive the machine connection file
  until a turn-scoped grant exists.
- Claude permission mode defaults to `default`; `bypassPermissions` is rejected,
  and `acceptEdits` is honored only with authentication disabled.
- Claude SSE subscriber channels close via `sync.Once` so disconnect + session end cannot double-close.
- Linux.do OAuth no longer auto-links an existing password account by email; an
  unlinked email collision returns HTTP 409 instead of account takeover.
