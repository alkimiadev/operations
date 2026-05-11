---
id: bug-pendingrequestmap-type-conflict
name: Fix PendingRequestMap type name conflict between env.ts interface and call.ts class
status: completed
depends_on: []
scope: narrow
risk: low
impact: component
level: implementation
---

## Description

There is a naming conflict documented in call-protocol.md § Bugs:

- `src/env.ts` exports a `PendingRequestMap` **interface** (reduced signature: missing `deadline`, `identity` typed as `unknown`)
- `src/call.ts` exports the `PendingRequestMap` **class** (full signature with all options)
- `src/index.ts` re-exports the interface as `PendingRequestMap` and the class as `PendingRequestMapClass`

The documented `PendingRequestMap` in the architecture refers to the **class**, but importing the type gives the reduced interface. This creates confusion for consumers.

The fix should:
1. Remove the `PendingRequestMap` interface from `env.ts` entirely
2. Rename the class export in `index.ts` from `PendingRequestMapClass` to just `PendingRequestMap` (both the class and type export)
3. Update the `EnvOptions.callMap` type to reference the actual class or a proper minimal interface

This is independent of ADR-005/006 and can be fixed immediately. Note: ADR-005 will later change the `call()` return type from `Promise<unknown>` to `Promise<ResponseEnvelope>`, but fixing the naming conflict now is clean and doesn't block on that.

## Acceptance Criteria

- [x] `PendingRequestMap` interface removed from `env.ts`
- [x] `index.ts` exports the class as `PendingRequestMap` (no `PendingRequestMapClass` alias)
- [x] `EnvOptions.callMap` type uses the actual `PendingRequestMap` class type or a proper minimal interface
- [x] Existing tests pass
- [x] No consumer-visible breaking change (the class has all methods the interface had, plus more)

## References

- docs/architecture/call-protocol.md § Bugs (PendingRequestMap type name conflict)
- src/env.ts:8-9 (interface definition)
- src/index.ts:6,14 (re-exports)
- src/call.ts:68 (class definition)

## Notes

Renamed the interface to `CallMap` instead of completely removing it, since `EnvOptions.callMap` needs a type for dependency injection (not every consumer needs the full `PendingRequestMap` class — they may provide a minimal call-map-like object). The `CallMap` interface now matches the full `call()` signature of the class (including `deadline` and properly typed `identity`).

## Summary

Resolved the PendingRequestMap type name conflict. Changes:
- Removed `PendingRequestMap` interface from `env.ts` and replaced it with `CallMap` interface that matches the full `call()` signature (including `deadline` and properly typed `Identity` parameters)
- Updated `EnvOptions.callMap` to use `CallMap` type
- Updated `index.ts` to export `CallMap` type from `env.js` (instead of `PendingRequestMap`) and export the `PendingRequestMap` class directly (instead of as `PendingRequestMapClass`)
- Build, lint, and all 75 tests pass