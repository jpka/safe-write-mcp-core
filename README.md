# safe-write-mcp-core

Two-phase write core for MCP servers: preview-then-execute plan tokens, out-of-band localhost approval, and audit hooks. Zero runtime dependencies, transport-agnostic — hosts supply `preview()`/`execute()` callbacks and an audit persistence implementation.

**Status:** scaffolded. Implementation tickets in progress — see the [issue tracker](https://github.com/jpka/safe-write-mcp-core/issues).

**Consumers:** [sw-postgres-mcp](https://github.com/jpka/sw-postgres-mcp) · [shopify-operations-mcp](https://github.com/jpka/shopify-operations-mcp)

Full documentation (guarantees, seam, decisions) lands with the README + DECISIONS.md ticket.
