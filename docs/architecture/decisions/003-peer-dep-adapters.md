# ADR-003: Peer Dependencies for Adapter Isolation

**Status**: Accepted
**Date**: 2026-04-30

## Context

The MCP adapter (`from_mcp.ts`) depends on `@modelcontextprotocol/sdk` for `Client`, `StdioClientTransport`, and `StreamableHTTPClientTransport`. This dependency is heavy (transitive deps) and only needed by consumers that connect to MCP servers. Other adapters may have similar heavy dependencies in the future (e.g., gRPC, GraphQL).

Two approaches:

1. **Regular dependency** — list `@modelcontextprotocol/sdk` as a direct dependency. All consumers install it.
2. **Optional peer dependency + sub-path export** — list it as an optional peer dependency, import dynamically, and expose via a separate `./from-mcp` sub-path export.

## Decision

Use optional peer dependency with sub-path export.

```json
{
  "peerDependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "peerDependenciesMeta": {
    "@modelcontextprotocol/sdk": { "optional": true }
  },
  "exports": {
    ".": { ... },
    "./from-mcp": { ... }
  }
}
```

## Rationale

1. **Zero-cost for non-MCP consumers** — `npm install @alkdev/operations` does not install `@modelcontextprotocol/sdk`. Only consumers that `import { createMCPClient } from "@alkdev/operations/from-mcp"` need to install it.

2. **Dynamic import** — `from_mcp.ts` uses `await import("@modelcontextprotocol/sdk/client/index.js")` and `await import("@modelcontextprotocol/sdk/client/stdio.js")`. The MCP SDK is loaded only when `createMCPClient` is actually called, not at module parse time.

3. **Explicit dependency declaration** — the sub-path import makes it clear at the import site that this code needs the MCP SDK. A barrel-only import doesn't communicate this.

4. **No bundler reliance** — sub-path exports don't depend on the consumer's bundler correctly tree-shaking. Not all consumers use bundlers (Deno, Node with `--experimental-strip-types`).

5. **Follows established pattern** — `@alkdev/pubsub` uses the same approach for its Redis adapter (sub-path export with optional ioredis peer dep).

6. **Incremental** — future adapters (gRPC, GraphQL) will follow the same pattern. Each adds one peer dep entry and one sub-path export.

## Consequences

- `package.json` has a peer dep entry for each adapter's external dependency
- Both barrel and sub-path work — barrel re-exports everything for convenience, sub-path for explicitness
- `tsup` must list each adapter as a separate entry point
- Consumer docs should recommend sub-path imports for adapter-specific code
- The `from_mcp.ts` module also imports from `from_schema.ts` and `types.ts` (core), which are bundled into the sub-path output by tsup's code splitting