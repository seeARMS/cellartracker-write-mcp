# CellarTracker Write MCP

An **unofficial, local-only** MCP server that relocates individual bottles in CellarTracker, with fresh inventory checks and verified outcomes.

Say “move all bottles from bin 23 to bin 24.” The assistant plans against exact bottle IDs, submits the relocation using your authenticated CellarTracker session, and checks that those bottles reached their destination.

**Status:** early prototype. The request contract was inspected against the live website on September 16, 2026. Direct cookie authentication and complete inventory pagination have been verified live. Automated tests use synthetic data. A live write must be validated before treating this as production-ready. CellarTracker does not provide a documented compatibility guarantee for the website endpoints used here.

## How this differs from read-only CellarTracker MCP servers

Export-based CellarTracker MCP servers make your cellar available to an assistant for searches, summaries, and recommendations. Their read-only tools can help you decide what to move, but cannot save that move in CellarTracker.

**This server adds writes to CellarTracker itself.** It uses the website's authenticated relocation workflow to update the location and bin of individual bottles, then reads the inventory again to verify the change.

| Capability | Export-based, read-only MCP servers | This server |
| --- | --- | --- |
| Read cellar data | Read exported inventory | Read current individual-bottle inventory from the website |
| Move bottles between bins or locations | Cannot save changes | Submit relocations for exact bottle IDs |
| Verify a move | No write operation to verify | Check each selected bottle's destination after writing |
| Recover from an interrupted move | Not applicable to writes | Record outcomes and inspect current positions without automatically replaying writes |

The current write scope is **bottle relocation**. Adding wine, logging consumption, editing tasting notes, and deleting bottles are not implemented. This can complement an existing MCP used for wine discovery or analysis. It relies on undocumented website endpoints, so compatibility may change when CellarTracker updates its site.

## Architecture

```text
MCP client → local Node.js stdio server → direct HTTPS requests using a private cookie file
          (optional fallback: local bridge → Chrome companion → CellarTracker)
```

Direct cookie authentication is the default when a session file is present. It works without the companion or an open Chrome window. Cookies stay in a private file on your machine and are sent only to `https://www.cellartracker.com`. Redirects are not followed. Server-issued refresh cookies are retained; when the session expires, import a fresh session.

The optional Chrome companion uses an existing signed-in tab instead. It is useful if direct requests stop working due to browser challenges. It supports only inventory and relocation operations, never arbitrary URLs or scripts.

## Local setup (cookie authentication)

Requires Node.js 22+. Use a trusted checkout of this repository.

```sh
npm ci
npm run check
```

To capture your session without pasting credentials into an AI conversation:

1. Open your signed-in CellarTracker **Individual Bottles** inventory in Chrome.
2. Open DevTools → Network and clear the request log. Filter to `domain:www.cellartracker.com list.asp`, then reload the page.
3. In DevTools Settings → Preferences → Network, temporarily enable **Allow to generate HAR with sensitive data**.
4. Export the filtered inventory request as **HAR (with sensitive data)** into a private directory outside this repository. Restore the setting afterward.
5. Import it locally:

```sh
node dist/cli.js import-har /absolute/path/to/private.har
node dist/cli.js diagnose
```

The importer selects only an inventory request at the exact HTTPS CellarTracker origin. It imports the session cookies and User-Agent, never runs commands from the HAR. Remove the source HAR after importing; it contains credentials. Never upload it to an issue, repository, or chat.

Alternatively, supply a mode-0600 JSON file containing `cookie` (the HTTP Cookie header value) and `userAgent`. Set `CELLARTRACKER_SESSION_FILE` to its absolute path. The server converts this to a persisted cookie jar on first use. Cookie values do not belong in MCP tool arguments or command-line arguments.

Session and operation files default to `~/.local/share/cellartracker-write-mcp/`, outside the repository. Override with `CELLARTRACKER_STATE_DIR`. The directory is mode 0700 and files are mode 0600 on Unix. Set `CELLARTRACKER_TRANSPORT=cookie` to require direct authentication; it fails closed instead of silently switching transports.

### Optional Chrome companion

Run `npm run setup` to create a pairing file. In `chrome://extensions`, enable Developer mode and load the repository's `extension/` directory with **Load unpacked**. Reload the signed-in CellarTracker tab, open the companion popup, and import the local `pairing.json` printed by setup. Set `CELLARTRACKER_TRANSPORT=browser` in your MCP configuration. Keep Chrome and the signed-in tab open. Reconnection can take up to 30 seconds.

### MCP client configuration

Use an absolute path to your Node executable if your GUI app does not inherit your shell PATH.

```json
{
  "mcpServers": {
    "cellartracker-write": {
      "command": "node",
      "args": ["/absolute/path/cellartracker-write-mcp/dist/cli.js", "serve"]
    }
  }
}
```

For clients using TOML:

```toml
[mcp_servers.cellartracker-write]
command = "node"
args = ["/absolute/path/cellartracker-write-mcp/dist/cli.js", "serve"]
```

Run only **one** instance per state directory at a time; a process lock prevents concurrent writers. After an unclean exit, the lock may take 30 seconds to expire. The optional browser bridge binds only to `127.0.0.1:17843`. `node dist/cli.js bridge` runs the bridge alone for development; stop it before starting an MCP client.

## Tools

| Tool | Effect |
| --- | --- |
| `connection_status` | Checks transport availability, not login |
| `list_bins` | Fresh complete inventory summarized by exact location/bin |
| `list_bottles` | Fresh inventory, optional exact location/bin and wine substring; paginated results |
| `plan_bin_move` | Persists a 15-minute plan; does not change CellarTracker |
| `execute_bin_move` | Moves the plan's exact bottle IDs and verifies the result |
| `get_move_status` | Returns saved outcome plus fresh positions for the selected IDs |

Example tool sequence (the assistant can perform both calls from one clear user instruction):

```json
{"source_bin":"23","destination_bin":"24","location":"Example cellar"}
```

Pass the returned `id` to `execute_bin_move` as `operation_id`. A plan is a technical precondition, not a requirement to ask the user for a second confirmation. Authorization remains the MCP client's responsibility.

Labels are exact strings: `23` and `023` are different. Omitting `location` works only when the source bin occurs in one location. The original location is preserved unless `destination_location` is explicitly supplied. An empty destination bin deliberately clears the bin field.

## Correctness and recovery

- Reads all inventory pages and validates account identity, totals, pagination and unique bottle IDs.
- Refuses ambiguous bins, expired plans, changed source membership, missing fields and unexpected relocation form changes.
- Serializes tool execution and writes in batches of at most 50 bottles.
- Persists the operation before writing and verifies the exact IDs after each batch.
- Never automatically replays a submitted operation. A repeated operation ID returns the recorded state.
- A lost response does not imply failure: read-back may establish success.

If an operation is `partial`, `unknown`, or `running` after a crash, use `get_move_status`. Inspect `observedNow.movedIds`, `remainingIds`, and `conflictIds`; resolve any in-flight request before deliberately planning recovery. Do not automatically create a new plan as a retry. There is no automatic rollback or atomic transaction across batches.

The website has no exposed compare-and-swap operation. A concurrent manual edit/account switch between the last read and the write is still possible. Avoid editing the same bottles while a move runs. A deliberate undo is a new move after reviewing current state, not a blind reversal of all bottles in the destination bin.

## Privacy and open-source contributions

Read [SECURITY.md](SECURITY.md) and [the protocol notes](docs/protocol.md). Never commit real inventory exports, HAR captures, browser profiles, cookies, pairing tokens or operation files. All committed fixtures are synthetic. The npm package uses an explicit file allowlist; test packaging with `npm pack --dry-run`.

```sh
npm run check
npm pack --dry-run
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under MIT. This project is not affiliated with or endorsed by CellarTracker. CellarTracker is a trademark of its respective owner.
