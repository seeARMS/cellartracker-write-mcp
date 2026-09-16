# Contributing

Use Node.js 22 or later. Run `npm ci` and `npm run check` before submitting a change.

Keep endpoint behavior behind the Cellar/Transport interfaces. Add regression tests for parsing and write failure modes; never use live account data in fixtures. The Chrome companion's protocol builder must remain an allowlist of narrow operations. A new write capability needs its own validation, explicit MCP description, persisted operation state, and read-back verification.

Use `npm pack --dry-run` to inspect the publication allowlist. Do not publish from a checkout containing credentials or personal data. Tests run locally against synthetic fixtures and a loopback bridge; they must not modify a real cellar.

Before claiming a new endpoint is supported, document the observed request contract and perform a user-authorized end-to-end test. Do not silently work around sign-in or anti-automation challenges.
