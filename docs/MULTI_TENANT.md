# Multi-tenant accounts (local)

Goal: isolate projects, assets, prompts, generation jobs, secrets, and blobs per account so local multi-user usage does not mix data.

## Model
- **Tenant** = workspace boundary for data
- **User** = login identity belonging to one tenant
- **Session** = opaque token (`X-OpenBoard-Session`) independent of the machine service token

## Auth modes (`OPENBOARD_AUTH_MODE`)
| Mode | Behavior |
|------|----------|
| `off` | No user login; all data stays on tenant `local`. Process-sensitive routes still validate `OPENBOARD_TOKEN` |
| `optional` | Zero-user bootstrap on tenant `local` is allowed only with a valid process token; after the first user exists, protected data-plane routes require a valid session |
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

## Platform administration and invitations
Set `OPENBOARD_PLATFORM_ADMIN_EMAILS` to a comma-separated list of exact,
normalized account emails. Those accounts receive a separate platform-admin
capability and can inspect all tenants, change a tenant's monthly generation
quota, adjust credits, and suspend or restore users through the `/admin`
platform panel. This capability is deployment-controlled; it is not a tenant
role and cannot be granted by an HTTP request. Auth-off deployments continue
to use the process token for platform routes.

Tenant owners and admins can create one-time invitations from the same admin
panel. The raw token is returned only when the invitation is created and is
stored as a hash. A new registration can follow the invite URL; the
registration transaction verifies the email, expiry, role, and consumes the
token before joining the existing tenant. Accounts remain single-tenant for
now, so an already registered account cannot join a second tenant without a
future membership/active-tenant migration.
Invite links use a URL fragment so the one-time token is not sent as an HTTP
Referer; the registration page removes it after a successful sign-in.

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
