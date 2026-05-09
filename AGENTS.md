## Memory Tools (via @alkdev/open-memory plugin)

You have access to two tools for managing your context and accessing session history:

### memory({tool: "...", args: {...}})

Read-only tool for introspecting your session history and context state. Available operations:
- `memory({tool: "help"})` — full reference with examples
- `memory({tool: "summary"})` — quick counts of projects, sessions, messages, todos
- `memory({tool: "sessions"})` — list recent sessions (useful for finding past work)
- `memory({tool: "children", args: {sessionId: "ses_..."}})` — list sub-agent sessions spawned from a parent
- `memory({tool: "messages", args: {sessionId: "..."}})` — read a session's conversation
- `memory({tool: "messages", args: {sessionId: "...", role: "assistant"}})` — read only assistant messages
- `memory({tool: "messages", args: {sessionId: "...", showTools: true}})` — include tool-call output
- `memory({tool: "message", args: {messageId: "msg_..."}})` — read a single message by ID
- `memory({tool: "search", args: {query: "..."}})` — search across all conversations
- `memory({tool: "compactions", args: {sessionId: "..."}})` — view compaction checkpoints
- `memory({tool: "context"})` — check your current context window usage

### memory_compact()

Trigger compaction on the current session. This summarizes the conversation so far to free context space.

**When to use memory_compact:**
- When context is above 80% (check with `memory({tool: "context"})`)
- When you notice you're losing track of earlier conversation details
- At natural breakpoints in multi-step tasks (after completing a subtask, before starting a new one)
- When the system prompt shows a yellow/red/critical context warning
- Proactively, rather than waiting for automatic compaction at 92%

**When NOT to use memory_compact:**
- When context is below 50% (it wastes a compaction cycle)
- In the middle of a complex edit that you need immediate context for
- When the task is nearly complete (just finish the task instead)

Compaction preserves your most important context in a structured summary — you will continue the session with the summary as your starting point.

## Worktree Tool (via @alkimiadev/open-coordinator plugin)

You have access to the `worktree` tool for git worktree management and session coordination. Call with `{action, args}`:

### Coordinator Operations (available when session is not spawned by another session)

- `worktree({action: "list"})` — List git worktrees
- `worktree({action: "dashboard"})` — Worktree dashboard with session info
- `worktree({action: "spawn", args: {tasks: [...], prompt: "..."}})` — Spawn parallel worktrees + sessions
- `worktree({action: "sessions"})` — Query spawned session status
- `worktree({action: "message", args: {sessionID: "...", message: "..."}})` — Message a session
- `worktree({action: "abort", args: {sessionID: "..."}})` — Abort a session
- `worktree({action: "cleanup", args: {action: "remove", pathOrBranch: "..."}})` — Remove worktree
- `worktree({action: "help"})` — Show all available operations

### Implementation Operations (available when session is spawned by a coordinator)

- `worktree({action: "current"})` — Show your worktree mapping
- `worktree({action: "notify", args: {message: "...", level: "info|blocking"}})` — Report to coordinator
- `worktree({action: "status"})` — Show worktree git status

The plugin auto-injects `workdir` for bash commands when the session is mapped to a worktree.

## Project: @alkdev/operations

Runtime-agnostic TypeScript package for typed operations registry, call protocol, and adapters (MCP, OpenAPI). Extracted from `alkhub_ts` as a standalone `@alkdev/operations` package. Dual-licensed MIT / Apache-2.0.

### Commands

- `npm run build` — Build with tsup (ESM + CJS + declarations)
- `npm run lint` — Type-check with `tsc --noEmit`
- `npm test` — Run tests with vitest
- `npm run test:watch` — Watch mode
- `npm run test:coverage` — Coverage report (v8)

### Architecture

See `docs/architecture/` for full specs. Key points:

- **Operations**: Everything is a typed operation with TypeBox schemas. `OperationSpec` is the serializable descriptor; handlers are registered separately via `registerHandler()`. `IOperationDefinition` combines both for convenience.
- **Call protocol**: `call ≡ subscribe` — same event types, same PendingRequestMap. A call resolves after one event; a subscription stays open and yields events until stopped. Same message format, different consumption pattern.
- **PendingRequestMap**: Full call protocol implementation with pubsub wiring, `call()`, `respond()`, `emitError()`, `abort()`, deadline timeout. Uses `@alkdev/pubsub@0.1.0` with `subscribe(type, id)` and `EventEnvelope` wrapping.
- **Registry**: Separates specs from handlers. `registerSpec()` and `registerHandler()` for independent registration; `register()` for combined. `execute()` requires both spec and handler.
- **Adapters**: `from_openapi`, `from_schema`, `from_mcp` register remote operations in the registry. MCP and OpenAPI are peer-dep adapters.
- **Logger**: Direct `@logtape/logtape` import, no wrapper.
- **No Effect**: Plain async/await throughout.
- **No Zod**: TypeBox for all runtime schemas.

### Source Layout

```
src/
  index.ts            — Public API surface (all exports)
  types.ts            — OperationSpec, IOperationDefinition, OperationType, CallEventMap, OperationHandler, SubscriptionHandler
  registry.ts         — OperationRegistry (register, registerSpec, registerHandler, execute, getSpec, getHandler)
  validation.ts       — Input/output schema validation
  call.ts             — PendingRequestMap, call(), respond(), emitError(), abort(), CallHandler
  subscribe.ts        — Subscription support (AsyncIterable operations, uses getSpec+getHandler)
  error.ts            — CallError, mapError, infrastructure codes
  env.ts              — OperationEnvironment
  scanner.ts          — Auto-discover operations from filesystem (Deno/Node agnostic)
  from_schema.ts      — Register operations from TypeBox schema definitions
  from_openapi.ts     — Register operations from OpenAPI specs
  from_mcp.ts         — Register operations from MCP servers
```

### Dependencies

Runtime: `@alkdev/typebox`, `@alkdev/pubsub`, `@logtape/logtape`
Peer: `@modelcontextprotocol/sdk` (from_mcp), `@std/path` (scanner)
Dev: `tsup`, `typescript`, `vitest`, `@vitest/coverage-v8`

### Constraints

- Runtime-agnostic: must work in both Node.js and Deno (inject fs/env deps, no `Deno.*` globals in source)
- TypeBox for all schemas (not Zod)
- No Effect dependency
- No mocked/stubbed implementations — real code only
- No comments in source unless explicitly asked

### Provenance

| Module | Origin | Status |
|--------|--------|--------|
| types.ts | Copied from `alkhub_ts/packages/core/operations/types.ts` | Migrating |
| registry.ts | Copied from `alkhub_ts/packages/core/operations/registry.ts` | Migrating, handler separation added |
| validation.ts | Copied from `alkhub_ts/packages/core/operations/validation.ts` | Migrating |
| env.ts | Copied from `alkhub_ts/packages/core/operations/env.ts` | Migrating, uses getAllSpecs() |
| scanner.ts | Copied from `alkhub_ts/packages/core/operations/scanner.ts` | Migrating, validates against OperationSpecSchema |
| from_schema.ts | Copied from `alkhub_ts/packages/core/operations/from_schema.ts` | Migrating |
| from_openapi.ts | Copied from `alkhub_ts/packages/core/operations/from_openapi.ts` | Migrating, needs env+fs injection |
| from_mcp.ts | Copied from `alkhub_ts/packages/core/mcp/wrapper.ts` + `loader.ts` | Migrating, needs path+dep updates |
| call.ts | New | Implemented, pubsub@0.1.0 integrated |
| subscribe.ts | New | Implemented, uses getSpec+getHandler |
| error.ts | New | Implemented |