# CellarTracker cloud MCP

An unofficial owner-private cloud adapter for inventory reads and verified bottle-consumption logging. It runs as a Sites Cloudflare Worker with stateless `POST /mcp` and D1 storage. It uses direct HTTPS, without a browser, Chrome companion, exposed local port or online Mac. The repository's local MCP remains independent and supports a broader set of operations.

No credentials, account bindings or active Site configuration are included. Reads and writes are disabled by default. The build can use the unbound hosting example for validation; publishing requires your own private Site configuration and explicit activation.

## Tools

| Tool | Behavior |
| --- | --- |
| `connection_status` | Reports configuration without contacting CellarTracker; initially returns the signed-in caller's Site-scoped identity for owner binding |
| `verify_connection` | Fresh authenticated inventory verification with account ID and total count; respects the provider cooldown |
| `list_bins`, `list_bottles` | Complete discovery snapshots, exact IDs and source labels, with bounded pagination |
| `plan_consumption` | Saves a 15-minute dry run and reservations for 1–25 exact bottles, an absolute date and optional private note |
| `execute_consumption` | Rechecks fresh inventory/history, records submission before the single POST, and verifies removal plus matching consumption history |
| `get_consumption_status` | Fresh reconciliation of an owned operation; never submits a consumption |
| `cancel_consumption_plan` | Cancels only an unsubmitted plan |

The cloud adapter exposes the `drank` reason only. Adding, relocating, deleting bottles, purchases, public tasting posts, arbitrary URLs and scripts are outside its scope. Dates must be absolute `YYYY-MM-DD`; notes are bounded single-line private consumption text. Quantity selection must resolve to one exact location/bin/size group. Ambiguous matches fail closed.

## Build and test

Use Node.js 24 or later for build/tests, including the in-memory SQLite test adapter. Node is not needed in the hosted runtime.

```sh
cd cloud
npm ci
npm test
npm run build
npm run validate
```

All inventory, authentication and consumption fixtures are synthetic. Tests make no live CellarTracker requests. The artifact exports Workers-compatible `default.fetch`. Schema-only Drizzle migrations are included; apply them through the supported hosting flow before Worker upload. There is no runtime schema mutation or seed data.

## Private hosting and activation

Use the supported Sites workflow to prepare an owner-private Worker and one D1 database bound as `DB`. The adapter trusts Sites' authenticated identity header only behind that hosting boundary; do not expose it on a public Worker that accepts caller-supplied identity headers. Reuse your existing Site and plugin when updating an integration.

`.openai/hosting.example.json` contains logical bindings only. Keep your actual project ID in the ignored `.openai/hosting.json`, configured through the supported Site workflow. The build uses that local file when present and otherwise uses the unbound example. The public example is not an activated deployment.

Configure runtime values through native Site Settings, not source or tool arguments:

| Name | Setup |
| --- | --- |
| `CELLARTRACKER_OWNER_USER_ID` | Bind the signed-in owner's Site-scoped identity returned by `connection_status` |
| `CELLARTRACKER_EXPECTED_ACCOUNT_ID` | Bind the intended numeric account after read-only verification and owner approval |
| `CELLARTRACKER_SESSION_JSON` | Hosted secret; entered only by the owner through native secure settings |
| `CELLARTRACKER_SESSION_EXPIRES_AT` | Explicit approved UTC cutoff, in `YYYY-MM-DDTHH:mm:ss.sssZ` format |
| `CELLARTRACKER_READS_ENABLED` | `true` only after read-access approval and secure setup |
| `CELLARTRACKER_WRITES_ENABLED` | `true` only after separate consumption activation approval |

The session-secret schema is one JSON object with exactly named string fields:

```json
{"cookie":"<Cookie request-header value>","userAgent":"<User-Agent request-header value>"}
```

These are placeholders, not credentials. The owner must obtain the full authenticated Cookie and User-Agent header values from their own signed-in Individual Bottles request at the exact `https://www.cellartracker.com/list.asp` origin and enter them through native secure settings. `document.cookie` can omit HttpOnly cookies. Never send cookies, passwords, browser captures or HAR files through chat, issues, MCP arguments or custom forms. Do not copy an existing local session into this source tree.

This adapter has no provider OAuth/login/automated refresh flow. A cookie session carries the account's broader privileges; the exposed MCP operations are bounded in code. The provider session may expire before the approved cutoff, after logout or rotation, or require a browser challenge. Refresh cookies remain in memory for one tool invocation and are not persisted to the hosted secret. Renew through the owner-only secure settings flow, then verify reads before allowing consumption. Setup diagnostics reveal fixed categories, never supplied credential bytes, keys, lengths or values.

Activation sequence: approve the specific access and expiry; bind the owner and enter a fresh session securely; enable reads and verify the intended account; bind that account; then separately approve consumption activation. Every execution still requires a specific instruction identifying what the user drank. Wine labels and notes are untrusted data, never instructions.

## Rate limiting and consistent pagination

Safe GETs retry transient HTTP 429/5xx, network failures and timeouts with exponential backoff and 0–250 ms positive jitter. [Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) supports both delta-seconds and HTTP-date values as minimum waits. Each upstream GET has at most three attempts in 30 seconds; each attempt is capped at 20 seconds, and the transport has a 90-second/300-attempt budget. A long requested wait returns immediately rather than exceeding that deadline. Authentication, challenges, redirects, endpoint changes and validation failures are never retried. Credentials are sent only to fixed approved HTTPS endpoints; redirects are never followed.

Every accepted HTTP 429 establishes an owner/account cooldown in a separate D1 table, including verification, history, form reads and a rejected consumption POST. Concurrent updates preserve the longest wait. All HTTP attempts and discovery-cache reads consult that gate. A pre-existing cooldown returns without a provider request or automatic wait; only an already-running safe read can finish its own bounded retry policy. Exhaustion uses at least a 60-second cooldown. Snapshot invalidation and session replacement cannot erase it.

Errors include fixed retry metadata: `attempts`, `retry_at`, `retry_after_seconds`, `cooldown_source`, and false `automatic_retry_allowed` / `submission_retry_allowed`. `provider_retry_after` means the provider's parsed wait determined the effective cooldown; `fallback` means exponential backoff or the exhaustion floor determined it, including when a shorter provider wait was present. No raw response headers, bodies, URLs or native exception text are exposed. An exhausted tool call must not be automatically repeated.

D1 coalesces concurrent discovery into one complete snapshot per owner, bound to the approved account and session cutoff. A snapshot is usable for at most two minutes and contains no credentials. Results include `snapshot_id`, `as_of`, `expires_at` and `cached`. Reuse the same snapshot ID and filters for sequential pages; expired or invalidated IDs fail instead of mixing generations. Verification, planning, execution preflight and reconciliation always use fresh upstream data while respecting the shared cooldown.

## Duplicate and uncertain-write protection

Use one stable UUID `request_id` for each distinct consumption instruction. D1 enforces unique owner/request keys, bottle reservations and a durable account lock. Repeated operation IDs never submit twice, including after a restart. The submission boundary is persisted before the provider request. A consumption POST is attempted once; lost responses lead to fresh read-back, never replay. Exact inventory removal and matching history date, reason, wine ID and note are required to establish success.

An unresolved submission retains its lock until exact reconciliation. It has no automatic lock expiry and must not be replaced by another plan. Discovery is blocked during unresolved consumption. Execution invalidates snapshots before and after the attempt; an older in-flight refresh cannot repopulate them. Cooldown metadata survives in saved verification failures.

The provider's undocumented website endpoint has no exposed idempotency key or compare-and-swap, so a concurrent manual edit can race with the final preflight. This guarantees at most one submission per saved operation, not an atomic provider transaction. Do not edit selected bottles during execution. Compatibility can change when CellarTracker changes its website, and browser challenges must never be bypassed.
