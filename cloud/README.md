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

HTTP 429 stops after its first response: it never triggers an automatic retry. Other transient safe GET failures (5xx, network failures and timeouts) retain exponential backoff (1, 2 seconds), plus 0–250 ms positive jitter, at most three attempts within 30 seconds. [HTTP Retry-After](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after) delta-seconds and HTTP-date values are respected as minimum waits. The whole transport has a 90-second deadline and 300-attempt budget; each attempt is capped at 20 seconds or the remaining deadline. A long Retry-After returns immediately with a wait time rather than exceeding the deadline. Authentication, challenge, redirect, endpoint, runtime and validation failures are never retried. A consumption POST gets exactly one attempt, regardless of the error.

Exhaustion returns fixed diagnostics: `error_code`, optional `upstream_status`, `attempts`, `retry_at` (UTC ISO timestamp), `retry_after_seconds`, `cooldown_source`, `automatic_retry_allowed=false`, and `submission_retry_allowed=false`. `error_origin` distinguishes `upstream_http`, `saved_provider_cooldown`, `snapshot_state`, `request_pacing` and `read_failure`. Fresh transport errors include the fixed `request_kind`, optional page number, total upstream attempts and successful reads for that tool call. A saved cooldown returns zero attempts and no upstream status because it sends no provider request. `cooldown_source=provider_retry_after` means a valid provider wait determined the effective cooldown; `fallback` means the exponential delay or 60-second exhaustion floor determined it, including when a shorter provider wait was present. No raw upstream headers, bodies, URLs, native exception text or credentials are returned. Callers must stop automatic tool retries.

Every HTTP 429 immediately establishes an owner/account cooldown in D1's separate `provider_cooldowns` table, including from verification, inventory/history/details/form reads and the sole consumption POST. Concurrent updates atomically retain the longest wait. Each HTTP attempt and discovery-cache access consults this gate; a pre-existing cooldown returns without a provider request or an automatic wait. A 429 imposes at least a 60-second cooldown or a longer provider wait. Snapshot invalidation and session-secret replacement cannot erase it. Initial verification before account binding uses an owner-scoped unbound gate that is also honored after binding. Missing or failed gate storage fails closed before any upstream request. Fixed cooldown metadata is retained in saved consumption verification failures; an uncertain submission remains locked and is never replayed.

D1 also reserves request starts at least two seconds apart per owner/account across Worker instances, including separate read kinds and the sole POST. Pacing rechecks the shared cooldown, approved session cutoff and request deadline before fetching. Plans are checked for expiry after fresh preflight and again atomically at submission. The spacing is a conservative adapter policy, not a verified provider quota or a guarantee of acceptance; upstream rate limiting can still block access. Large history reads remain bounded by the same deadlines and must never use stale data to finish a write.

D1 coalesces concurrent discovery into one complete snapshot per owner, bound to the approved account and session cutoff. A snapshot is usable for at most two minutes and contains no credentials. Results include `snapshot_id`, `as_of`, `expires_at` and `cached`. Reuse the same snapshot ID and filters for sequential pages; expired or invalidated IDs fail instead of mixing generations. Verification, planning, execution preflight and reconciliation always use fresh upstream data while respecting the shared cooldown.

## Duplicate and uncertain-write protection

Use one stable UUID `request_id` for each distinct consumption instruction. D1 enforces unique owner/request keys, bottle reservations and a durable account lock. Repeated operation IDs never submit twice, including after a restart. The submission boundary is persisted before the provider request. A consumption POST is attempted once; lost responses lead to fresh read-back, never replay. Exact inventory removal and matching history date, reason, wine ID and note are required to establish success.

An unresolved submission retains its lock until exact reconciliation. It has no automatic lock expiry and must not be replaced by another plan. Discovery is blocked during unresolved consumption. Execution invalidates snapshots before and after the attempt; an older in-flight refresh cannot repopulate them. Cooldown metadata survives in saved verification failures.

The provider's undocumented website endpoint has no exposed idempotency key or compare-and-swap, so a concurrent manual edit can race with the final preflight. This guarantees at most one submission per saved operation, not an atomic provider transaction. Do not edit selected bottles during execution. Compatibility can change when CellarTracker changes its website, and browser challenges must never be bypassed.
