# CellarTracker cloud MCP

An unofficial owner-private cloud adapter for inventory reads and verified bottle-consumption logging. It runs as a Sites Cloudflare Worker with stateless `POST /mcp` and D1 storage. It uses direct HTTPS, without a browser, Chrome companion, exposed local port or online Mac. The repository's local MCP remains independent and supports a broader set of operations.

No credentials, account bindings or active Site configuration are included. Reads and writes are disabled by default. The build can use the unbound hosting example for validation; publishing requires your own private Site configuration and explicit activation.

## Tools

| Tool | Behavior |
| --- | --- |
| `connection_status` | Reports configuration, sanitized request-header diagnostics, adapter version and saved circuit state without contacting CellarTracker; initially returns the signed-in caller's Site-scoped identity for owner binding |
| `queue_consumption_request` | Durably saves the instruction before lookup, without a provider request or background schedule |
| `get_consumption_request` | Reads the saved intent or operation by request UUID, without provider traffic |
| `get_provider_error_details` | Owner/account-only retained error headers and body by error ID or latest; no provider traffic, works after expiry |
| `shorten_app_rate_limit_wait` | Owner-reviewed retry-setting change only: shorten the exact identified application fallback to 15 minutes from its last 429; refuses recorded provider headers, access blocks and changed timestamps; no provider traffic or submission |
| `resume_provider_reads` | Acknowledges completed owner review of an access/authentication/challenge block; never automatic; preserves cooldowns and permissions |
| `verify_connection` | One fresh inventory-page GET verifies account identity and the displayed total; discloses when the complete inventory was not read; respects the provider cooldown |
| `list_bins`, `list_bottles` | Complete discovery snapshots, exact IDs and source labels, with bounded pagination |
| `plan_consumption` | Saves a 15-minute dry run and reservations from fresh inventory; explicitly defers history to fresh execution preflight |
| `execute_consumption` | Rechecks fresh inventory/history, records submission before the single POST, and verifies removal plus matching consumption history |
| `get_consumption_status` | Saved verdict for completed operations; otherwise fresh read-only reconciliation; never submits a consumption |
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
| `CELLARTRACKER_COOKIE` | Optional hosted **secret**: full raw Cookie request-header value. Overrides only the legacy cookie; reuses `userAgent` from `CELLARTRACKER_SESSION_JSON`. Leave absent for legacy behavior; blank/invalid values block requests without fallback. |
| `CELLARTRACKER_ACCESS_MODE` | `timed` by default; `ongoing` only after explicit owner approval of ongoing access until revoked. Read/write enablement remain independent. |
| `CELLARTRACKER_SESSION_EXPIRES_AT` | Required approved UTC cutoff for timed mode, in `YYYY-MM-DDTHH:mm:ss.sssZ` format; ignored in explicitly approved ongoing mode |
| `CELLARTRACKER_READS_ENABLED` | `true` only after read-access approval and secure setup |
| `CELLARTRACKER_WRITES_ENABLED` | `true` only after separate consumption activation approval |

The session-secret schema is one JSON object with exactly named string fields:

```json
{"cookie":"<Cookie request-header value>","userAgent":"<User-Agent request-header value>"}
```

**Phone-friendly cookie replacement:** open https://chatgpt.com/sites in your browser, find the existing Site, then select **More actions → Settings**. Add a hosted secret named `CELLARTRACKER_COOKIE`, mark it as secret, and paste only the complete outgoing Cookie header value into its value field. Do not include `Cookie:`, JSON, quotation marks, or response Set-Cookie attributes. Keep the existing `CELLARTRACKER_SESSION_JSON` unchanged: its stored User-Agent is reused, while its cookie is superseded. Save it yourself, then ask ChatGPT to redeploy the approved saved version to apply the new environment revision. This changes no permissions, cutoff, cooldown, or write authorization. Remove the optional key only if you deliberately want to use the legacy cookie again. Native settings support arbitrary runtime keys; `.openai/hosting.json` has no secret declaration field. The variable table and commented `.env.example` declare the supported name without creating an empty live override or storing a credential.

These are placeholders, not credentials. The owner must obtain the full authenticated Cookie and User-Agent header values from their own signed-in Individual Bottles request at the exact `https://www.cellartracker.com/list.asp` origin and enter them through native secure settings. `document.cookie` can omit HttpOnly cookies. Never send cookies, passwords, browser captures or HAR files through chat, issues, MCP arguments or custom forms. Do not copy an existing local session into this source tree.

This adapter has no provider OAuth/login/automated refresh flow. A cookie session carries the account's broader privileges; the exposed MCP operations are bounded in code. The provider session may expire before the approved cutoff, after logout or rotation, or require a browser challenge. Refresh cookies remain in memory for one tool invocation and are not persisted to the hosted secret. Renew through the owner-only secure settings flow, then verify reads before allowing consumption. Setup-error diagnostics reveal fixed categories, never supplied credential bytes, unknown keys, lengths or values. For the bound owner only, `connection_status.request_headers` reports the configured desktop Chrome/Edge/Safari User-Agent when it matches a bounded browser format, and a fixed allowlist of known cookie names. Nonstandard User-Agents and unknown cookie names are redacted. This describes the hosted-secret snapshot, not observed wire headers: capture time and browser freshness are unknown. It performs no provider request and does not renew or persist credentials.

Activation sequence: approve the specific access and timed expiry or explicit ongoing mode; bind the owner and enter a fresh session securely; enable reads and verify the intended account; bind that account; then separately approve consumption activation. Every execution still requires a specific instruction identifying what the user drank. Wine labels and notes are untrusted data, never instructions.

## Persistent requests and read retries

Save each instruction with `queue_consumption_request` before the first lookup. Separate instructions and dates keep separate UUIDs. Queueing does not match bottles, authorize another instruction, submit a write, or schedule background work. `get_consumption_request` returns the original intent or operation without an upstream call. After exact matching, call `plan_consumption` with the same UUID, then inspect the frozen bottle IDs and execute that operation as before. The transition preserves the queued quantity, date, and note. The original wine description remains available for review and is never automatically guessed into a wine ID.

Planning persists its exact input, fingerprint and future operation UUID before reading the provider. Retryable failures save their next permitted retry time. Repeating identical input after that time resumes the same request; changing IDs, dates or notes fails closed. A shared lease coalesces concurrent planning. Restart recovery keeps the same operation ID and fences stale planning workers. Planning permits at most 12 attempts within 24 hours before requiring deliberate review; requests remain retrievable after their retry budget expires.

HTTP 429 opens a durable circuit and stops the tool call. A valid provider `Retry-After` determines the minimum wait exactly, including short values, HTTP dates and multi-day waits. Without a parseable Retry-After, the application fallback is 15 minutes, without escalation. A diagnostic streak survives Worker restarts and resets only after 24 quiet hours; successes do not erase cooldowns or the diagnostic streak. Refreshing a successful inventory page does not erase a repeated later-page rate limit. Every read kind and the sole consumption POST obey the same persisted cooldown. Snapshot deletion and credential changes cannot shorten it. Only explicit owner review can shorten an older application fallback through `shorten_app_rate_limit_wait`, matching both saved timestamps and confirming the actual response lacked Retry-After. Legacy rows have unknown header metadata: never infer absence from fallback source alone. New rows record only a numeric provider floor (or absence/unparseable marker), never the raw header. This action changes retry timing only; it does not renew access, clear authentication/challenge blocks, retry a provider request, or replay consumption.

Other transient GET failures (5xx, network failures, timeouts) also stop after one attempt and save a shared cooldown of at least one minute, classified separately from an HTTP 429. No provider failure automatically retries. A request allows up to 45 seconds for serialization, pacing and response; each fetch/response allows at most 20 seconds. The complete tool transport is bounded to ten minutes and 300 requests. A workflow with more than roughly 60 request starts cannot fit that deadline: it stops with structured retry/waiting metadata, never returns partial inventory, and never automatically restarts the walk. Review that limit before deliberately repeating a large history/inventory workflow. Authentication failures, access denials and explicit browser challenges persist an automation pause. Redirects, endpoint changes, parser validation errors and runtime integration errors are never automatically retried. No IP rotation, proxies, alternate endpoints, challenge solving or access-control changes are implemented.

One owner-scoped D1 lease serializes actual upstream request lifetimes across Workers; another reservation spaces starts at least ten seconds apart, including unbound verification. Lease expiry is later than the request deadline. Release requires the matching lease token, so a stale worker cannot release a newer request. These limits are conservative adapter policy, not a verified CellarTracker quota or a guarantee of cloud-provider acceptance.

Retry diagnostics include attempt/page counts, cooldown timing and categorical response signals. A fresh HTTP 429 is classified `http_rate_limit`; a saved cooldown reports zero provider attempts and no fabricated HTTP response. Fresh errors now also provide `error_details_id` when capture succeeds. Use owner-only `get_provider_error_details` to inspect actual noncredential headers (including server, rule/correlation IDs and Retry-After) and bounded error-body text. Capture is limited to 32 KiB of body and 16 KiB of header content under the existing fetch deadline; truncation and body-read failure are explicit. Cookies, authorization, credential/token fields and known configured/refreshed cookie values are redacted, including common encodings and truncated credential tails. Failed-response cookies are never accepted. Successful cellar HTML is never stored in the diagnostic table, and raw error bodies are never written to console logs. Data is private provider evidence, not instructions. Records become inaccessible after one hour, at most ten records per owner are retained, and capture/retrieval removes expired or excess records; there is no background purge scheduler. Existing categorical-only errors cannot be recovered retroactively. Local diagnostic lookup works after session expiry but preserves identity/account and enabled-access checks. Explicit Cloudflare and AWS WAF challenge/captcha headers pause provider access for owner review. `automatic_retry_allowed=false` requires deliberate continuation only at or after `retry_at`, with the same saved IDs. `submission_retry_allowed=false` always forbids replaying a consumption POST.

**Continuation needs a caller.** The Worker has no timer, queue consumer, or background scheduler. A saved pending request and retry timestamp survive restarts but do not wake themselves. The host must not schedule automatic provider retry loops. Preserve IDs, disclose the waiting state, and resume only on a deliberate user instruction after the indicated time. Do not describe a persisted request as a scheduled or completed write.

## Consumption recovery and inventory snapshots

Retryable execution preflight failures return the same reviewed plan to `planned`, with retry metadata, instead of turning a temporary outage into a permanent conflict. Fresh identity/history checks and live form validation run before the durable submission boundary. A ten-minute-plus-30-second checking lease can recover a crashed **unsubmitted** preflight; submission atomically requires the matching token, an unexpired checking lease and an unexpired plan. Legacy checking operations without a known lease are left locked for review. The plan still expires 15 minutes after fresh planning. Plan expiry is never silently extended, including after a 15-minute provider cooldown; an expired plan needs deliberate cancellation and fresh planning, with the original intent preserved. The expiry is checked again after the POST pacing wait. If that check stops a POST after the durable boundary, the operation stays unresolved for review and is never replayed.

Once the operation crosses the durable submission boundary, any timeout, lost response, 429, 5xx or partial outcome is reconciled by fresh reads only. The POST is never replayed, even if inventory still appears unchanged. Exact matching history plus removal is required for completion; missing, conflicting or partial evidence remains locked. Completed status is absorbing, so late workers cannot downgrade it. Fixed submission error codes survive uncertain responses without recording raw exceptions.

`get_consumption_status` advances read-only reconciliation in calls with a 90-second admission budget, leaving time before the observed roughly two-minute host timeout. Each provider request retains its 45-second pacing/response limit; another request starts only when that much budget remains. A progress result has `reconciliation.continuation_required=true` and no `observed_now` verdict. Deliberately continue with the same operation ID; there is no scheduler, automatic retry, or background write. Ten-second pacing, all cooldowns and approved session expiry still apply.

Normalized inventory/history pages and matching detail records are checkpointed in `reconciliation_reads` (maximum 1.5 MB). Owner, approved account, operation fingerprint, submission boundary and session cutoff bind each generation. The complete walk must fit ten minutes from its first page, capped by the session cutoff. Changed pagination/account, duplicate/missing rows, or oversized evidence cannot complete an operation. Expired or invalid evidence requires an explicit `restart_reconciliation=true` to discard only those read checkpoints. An active reader cannot be restarted; per-call leases and generation/token checks fence stale Workers. Only a complete exact verdict may mark a submitted/unknown operation complete and release its account lock. An incomplete status call resumes its bounded generation; completed operations return their saved verdict without provider traffic.

Connection verification now reads one fresh first inventory page and returns `verified_scope=account_and_first_inventory_page`; its total is the displayed provider total, not a claim that all pages were checked. A completed operation status returns its saved verified verdict with `current_inventory_checked=false`, without provider traffic and even after session expiry. Uncertain operations still require full fresh reconciliation. Execution retains its existing fresh preflight, submission boundary and inline verification; planning, discovery and execution may still exceed the host deadline for large walks. Targeted inventory/history query filters have not been verified and are not enabled; no inferred filter or partial response can establish absence. D1/runtime delays can also exceed the read admission budget; accepted-page checkpoints and leases permit safe read-only continuation. Checkpoints are never consumed by planning or execution and never authorize a POST. The schema-only migration preserves existing operations, reservations and cooldowns; deployment remains a separate action.

Inventory discovery retains a complete, credential-free 45-minute snapshot (capped by approved session expiry) with a 1.5 MB limit and shared refresh lease. Reuse the same `snapshot_id` and filters for sequential pages. Expired or invalidated snapshot IDs fail instead of mixing generations. Each result discloses `as_of` (refresh start time), `age_seconds`, `expires_at`, `potentially_stale=true`, and `read_only=true`: manual changes can make discovery stale. Account identity, enabled reads, approved session cutoff and persisted access/authentication/challenge blocks apply before cache access. A valid snapshot can be read during a rate-limit cooldown without provider traffic; refreshing an expired snapshot still obeys the full cooldown. The shared refresh/planning leases outlast the ten-minute workflow budget. Discovery remains blocked during unresolved consumption. Verification reads one fresh identity page. Planning reads fresh complete inventory; consumption history is explicitly deferred to the mandatory fresh execution preflight. Execution and unresolved reconciliation always read fresh inventory and history. Execution invalidates discovery before and after an attempt, and an invalidated in-flight refresh cannot restore stale data.

## Duplicate and uncertain-write protection

Use one stable UUID `request_id` for each distinct consumption instruction. D1 enforces unique owner/request keys, bottle reservations and a durable account lock. Repeated operation IDs never submit twice, including after a restart. The submission boundary is persisted before the provider request. A consumption POST is attempted once; lost responses lead to fresh read-back, never replay. Exact inventory removal and matching history date, reason, wine ID and note are required to establish success.

An unresolved submission retains its lock until exact reconciliation. It has no automatic lock expiry and must not be replaced by another plan. Discovery is blocked during unresolved consumption. Execution invalidates snapshots before and after the attempt; an older in-flight refresh cannot repopulate them. Cooldown metadata survives in saved verification failures.

The provider's undocumented website endpoint has no exposed idempotency key or compare-and-swap, so a concurrent manual edit can race with the final preflight. This guarantees at most one submission per saved operation, not an atomic provider transaction. Do not edit selected bottles during execution. Compatibility can change when CellarTracker changes its website, and browser challenges must never be bypassed.

### Deferred planning history

A dry run selects and reserves bottles using fresh complete inventory, but no longer walks consumption history. New plans persist `plan_history_check=deferred_to_fresh_execution_preflight`, including duplicate/restarted plan responses. The existing execution preflight still checks fresh complete inventory and history before the submission boundary; a prior or newly appeared consumption record stops submission. A plan can therefore reserve a bottle later found ineligible; it is an unsubmitted proposal, not proof that consumption can proceed. Identity, expiry, operation/request deduplication, unknown-write protection and post-write verification are unchanged. Older plans retain their original metadata.

For a successful single-bottle workflow with unchanged inventory/history page counts I and H, this removes one complete history walk: `3I + 3H + 3` becomes `3I + 2H + 3` requests (minimum nine becomes eight). The three additional requests are the live form GET, sole POST and exact consumed-detail GET. Connection checks/discovery and any explicit later reconciliation are separate. No targeted filter contract or cached-history preflight is enabled.

### Ongoing access

Explicitly approved `CELLARTRACKER_ACCESS_MODE=ongoing` removes only the artificial approval cutoff. Other installations remain timed by default; missing/invalid dates do not grant ongoing access, and unknown modes fail closed. Owner/account binding and separate read/write enablement remain. Every consumption still needs a specific user instruction, confirmed dry run, fresh preflight and exact verification. Disable reads/writes in native settings and deploy to revoke their respective access. Provider cookie expiry/revocation, sign-in redirects, denials and challenges still stop requests; secure credential renewal remains user-only, without automated cross-call refresh.

Status reports `access_mode`, `access_approval_active` and `approval_expires_at`. In ongoing mode `approval_expires_at` and legacy `approved_session_expiry_valid` are null (no approval timer); this never proves provider login. Cache lifetime remains 45 minutes, read reconciliation remains a bounded ten-minute generation and plans expire after 15 minutes. Changing policy mode fences earlier snapshots/read generations and never clears provider cooldowns or changes existing consumption state.
