# Security

This server is intended for one local user and one Chrome profile. It is not a multi-user or remotely hosted service.

The separate `cloud/` adapter has its own owner-private hosting and session requirements, documented in [cloud/README.md](cloud/README.md). It does not expose or proxy the local bridge.

Direct cookie authentication stores a private session jar outside the repository and sends cookies only to the fixed CellarTracker HTTPS origin. No redirects are followed. A session file is equivalent to a login credential; refresh it after expiry or revoke it by signing out through the site. A source HAR may also contain credentials and should be removed after import.

The optional companion grants the paired server read access to inventory and consumption history, and write access to creating bottles, bottle locations/bins, and consumption records. Cookies and passwords stay in Chrome; pairing tokens and operation snapshots are sensitive local files. Never share or commit them. Do not expose port 17843 on a network, proxy it, or bind it to another address.

The bridge requires a 256-bit pairing token, validates Host/Origin, and accepts only fixed typed operations. Extension host access is restricted to CellarTracker and the loopback bridge. The content script has no page-message listener and does not expose the bridge to the website. The pairing token is stored only in local extension storage, not Chrome Sync. A malicious local process with access to your account can still read local secrets; this does not defend against a compromised machine.

To disconnect, use the companion's Disconnect button and stop the MCP server. An already submitted request cannot be canceled with certainty. To revoke the pairing token, stop the server, remove only `pairing.json` from its state directory, run setup again, and import the new file. Do not delete operation records while a move is unresolved.

MCP clients are responsible for user authorization. Wine names and labels are untrusted data, never instructions. Do not put credentials or tokens in tool arguments. Tool error messages deliberately exclude raw site responses and credentials.

Before publishing an issue or diagnostic report, use synthetic data and strip account IDs, wine inventory, tokens, cookies, headers and browser captures. No telemetry is implemented by this project.
