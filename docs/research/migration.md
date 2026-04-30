---
status: in-progress
last_updated: 2026-04-30
---

# @alkdev/operations — Migration Plan

Extract `packages/core/operations/` and `packages/core/mcp/` from `alkhub_ts` into a standalone `@alkdev/operations` package. Follow patterns from `@alkdev/pubsub` (tsup+vitest, peer-dep isolation, sub-path exports, architecture docs).

## Source Inventory

| Module | Source | Lines | Status Category |
|--------|--------|-------|-----------------|
| types.ts | `alkhub_ts/packages/core/operations/types.ts` | 212 | Copy (zero changes) |
| from_schema.ts | `alkhub_ts/packages/core/operations/from_schema.ts` | 115 | Copy (zero changes) |
| registry.ts | `alkhub_ts/packages/core/operations/registry.ts` | 82 | Adapt (logger swap) |
| validation.ts | `alkhub_ts/packages/core/operations/validation.ts` | 115 | Adapt (@std/assert swap) |
| env.ts | `alkhub_ts/packages/core/operations/env.ts` | 83 | Adapt (logger swap, PendingRequestMap interface stays) |
| scanner.ts | `alkhub_ts/packages/core/operations/scanner.ts` | 89 | Adapt (inject fs, replace Deno globals, logger) |
| from_openapi.ts | `alkhub_ts/packages/core/operations/from_openapi.ts` | 333 | Adapt (remove Deno.env.get, inject auth, replace Deno.readTextFile, fix SSE handler) |
| mcp/wrapper.ts | `alkhub_ts/packages/core/mcp/wrapper.ts` | 88 | Merge → from_mcp.ts (update imports, logger) |
| mcp/loader.ts | `alkhub_ts/packages/core/mcp/loader.ts` | 59 | Merge → from_mcp.ts (update imports, logger) |
| call.ts | New | — | Build |
| subscribe.ts | New | — | Build |
| error.ts | New | — | Build |

## Architecture Decisions

- **Logger**: Direct `@logtape/logtape` import, no wrapper (ADR-001)
- **FS injection**: Scanner and from_openapi accept injected fs/env deps, no `Deno.*` globals (ADR-002)
- **Peer deps**: MCP SDK is a peer dep with sub-path export `./from-mcp`. Scanner stays in main barrel since `@std/path` is lightweight (ADR-003)
- **Call protocol**: `call ≡ subscribe` — same event types, same PendingRequestMap, different consumption
- **No Effect, No Zod**: Plain async/await, TypeBox for all schemas

## Phase 1: Project Skeleton + Direct Copies

- [x] Create `package.json` (following pubsub pattern — tsup, vitest, dual ESM/CJS)
- [x] Create `tsconfig.json` (ES2022, nodenext, strict)
- [x] Create `tsup.config.ts` (dual format, entries: index + from-mcp)
- [x] Create `vitest.config.ts`
- [x] Create `.gitignore`
- [x] Copy `types.ts` → `src/types.ts` (renamed schema consts: AccessControlSchema, ErrorDefinitionSchema, OperationContextSchema, OperationDefinitionSchema — avoid TSchema annotation + name collision with type aliases)
- [x] Copy `from_schema.ts` → `src/from_schema.ts` (zero changes)
- [x] Adapt `registry.ts` → `src/registry.ts` (swap `../logger/mod.ts` → `@logtape/logtape`)
- [x] Adapt `validation.ts` → `src/validation.ts` (swap `@std/assert` → custom throw in assertIsSchema)
- [x] Adapt `env.ts` → `src/env.ts` (swap logger)
- [x] Create `src/index.ts` barrel

## Phase 2: Files with Significant Changes

- [x] Create `src/error.ts` — CallError, mapError, infrastructure error codes
- [x] Create `src/call.ts` — PendingRequestMap class, call(), respond(), emitError(), abort(), buildCallHandler()
- [x] Create `src/subscribe.ts` — AsyncIterable subscription support
- [x] Add CallEventSchema types to `src/types.ts` and `src/call.ts`
- [x] Adapt `scanner.ts` → `src/scanner.ts` — inject ScannerFS, no Deno.* globals
- [x] Adapt `from_openapi.ts` → `src/from_openapi.ts` — remove Deno.env.get(), inject OpenAPIFS, explicit auth config
- [x] Merge `wrapper.ts` + `loader.ts` → `src/from_mcp.ts` — dynamic imports, logger, MCPClientLoader

## Phase 3: Architecture Docs

- [x] `docs/architecture/README.md`
- [x] `docs/architecture/api-surface.md`
- [x] `docs/architecture/call-protocol.md`
- [x] `docs/architecture/adapters.md`
- [x] `docs/architecture/build-distribution.md`
- [x] `docs/architecture/decisions/001-logger-direct-import.md`
- [x] `docs/architecture/decisions/002-fs-injection.md`
- [x] `docs/architecture/decisions/003-peer-dep-adapters.md`
- [x] `docs/architecture/decisions/004-schema-const-naming.md` (added during implementation — discovered TSchema annotation issue)

## Phase 4: Tests + Verify Build

- [x] Tests for registry, validation, from_schema (68 tests passing)
- [x] Tests for call protocol (PendingRequestMap, call, abort, timeout)
- [x] Tests for error (CallError, mapError, infrastructure codes)
- [x] Tests for env (buildEnv direct vs call protocol mode)
- [x] Tests for from_openapi (spec parsing, operation types, auth, $ref)
- [x] `npm run build && npm run lint && npm test` all pass

## Target Structure

```
@alkdev/operations/
  src/
    index.ts              — Public API surface (all exports)
    types.ts              — IOperationDefinition, OperationType, CallEventMap, Identity, AccessControl
    registry.ts           — OperationRegistry (register, execute, subscribe)
    validation.ts          — Input/output schema validation
    call.ts               — PendingRequestMap, call(), subscribe(), CallHandler
    subscribe.ts          — AsyncIterable subscription support
    error.ts              — CallError, mapError, infrastructure codes
    env.ts                — buildEnv (direct + call protocol modes)
    scanner.ts            — Auto-discover operations (injected fs)
    from_schema.ts        — JSON Schema → TypeBox converter
    from_openapi.ts       — OpenAPI spec → IOperationDefinition[]
    from_mcp.ts           — MCP server → IOperationDefinition[]
  test/
    registry.test.ts
    validation.test.ts
    call.test.ts
    subscribe.test.ts
    error.test.ts
    env.test.ts
    from_schema.test.ts
    from_openapi.test.ts
    from_mcp.test.ts
    scanner.test.ts
  docs/
    architecture.md
    architecture/
      README.md
      api-surface.md
      call-protocol.md
      adapters.md
      build-distribution.md
      decisions/
        001-logger-direct-import.md
        002-fs-injection.md
        003-peer-dep-adapters.md
    research/
      migration.md          (this file)
  package.json
  tsconfig.json
  tsup.config.ts
  vitest.config.ts
  .gitignore
  AGENTS.md
```

## References

- Source: `@alkdev/alkhub_ts/packages/core/operations/` + `packages/core/mcp/`
- Pattern reference: `@alkdev/pubsub` (package.json, tsup, vitest, peer-dep isolation, architecture docs)
- Pattern reference: `@alkdev/taskgraph_ts` (AGENTS.md format, build pipeline)
- Architecture specs: `alkhub_ts/docs/architecture/operations.md`, `call-graph.md`, `mcp-server.md`