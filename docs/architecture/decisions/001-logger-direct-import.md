# ADR-001: Direct @logtape/logtape Import

**Status**: Accepted
**Date**: 2026-04-30

## Context

The operations package needs structured logging. Within alkhub, logging went through a wrapper module (`core/logger/mod.ts`) that configured logtape categories and re-exported a logger instance. Now that operations is a standalone package, we need to decide how to handle logging.

Two approaches:

1. **Wrapper module** — create `src/logger.ts` that configures logtape and exports configured logger instances
2. **Direct import** — import `getLogger` from `@logtape/logtape` directly in each module

## Decision

Import `@logtape/logtape` directly. No wrapper module.

## Rationale

1. **Simpler** — one less file to maintain. The logtape API (`getLogger("category")`) is already clean and doesn't need wrapping.

2. **Category convention** — logtape uses dot-separated category strings (e.g., `"operations:registry"`, `"operations:call"`). These are self-documenting and don't need a function to build them.

3. **Configuration is external** — logtape configuration (log levels, sinks, categories) belongs to the application, not the library. The library just emits logs; the consumer decides what to do with them. A wrapper module would imply the library owns configuration, which it shouldn't.

4. **Consistent with logtape's design** — logtape's `getLogger()` is designed to be called directly in each module. It's not a per-invocation cost — `getLogger` returns a cached instance.

5. **No hidden state** — a wrapper module could carry configuration state that makes the library harder to reason about in isolation. Direct import means the library is stateless with respect to logging.

## Consequences

- Consumers must configure `@logtape/logtape` in their application if they want to see log output from this package
- Log categories follow the `operations:{module}` convention throughout
- `@logtape/logtape` is a direct runtime dependency (not a peer dep — it's small and we control its version)