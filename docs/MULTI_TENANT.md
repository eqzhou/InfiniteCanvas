# Multi-tenant accounts (local)

Goal: isolate projects, assets, prompts, generation jobs, secrets, and blobs per account so local multi-user usage does not mix data.

## Model
- **Tenant** = workspace boundary for data
- **User** = login identity belonging to one tenant
- **Session** = opaque token (`X-OpenBoard-Session`) independent of the machine service token

## Auth modes (`OPENBOARD_AUTH_MODE`)
| Mode | Behavior |
|------|----------|
| `off` | No user login; all data stays on tenant `local` (legacy single-user) |
| `optional` | Session scopes data when present; otherwise tenant `local` |
| `required` | Data APIs require a valid user session |

Service token (`OPENBOARD_TOKEN` / Vite proxy `Authorization`) remains for process-level access.
Paid server-owned generation never uses the anonymous `local` fallback in
`optional` mode. It requires a user session, or explicit single-user `off`
mode together with a service token that is revalidated by the generation
endpoint. Encrypted provider-secret reads and writes also require a session
once the first user exists; `off` mode revalidates the same process token.

## First user
The first registered user becomes **owner of tenant `local`**, claiming existing formal-local data. Later registrations create a new empty personal tenant.

## Billing (local foundation)
- Plan + storage/generation quotas on the tenant
- Usage events for generation counts and storage checks
- UI shows plan and monthly generation usage (no payment processor)

## Copyright
Independent OpenBoard feature; not derived from upstream AGPL source.

## API notes
- `GET /api/auth/me` and `GET /api/auth/usage` enforce their own session checks.
- In `required` mode, anonymous `usage` requests return 401.
- Blobs live under `data/blobs/<tenantId>/…`. Reads for tenant `local` also fall back to the pre-migration flat `data/blobs/` layout.
- Claude permission mode defaults to `acceptEdits`; override with `OPENBOARD_CLAUDE_PERMISSION_MODE`.
- Claude SSE subscriber channels close via `sync.Once` so disconnect + session end cannot double-close.
