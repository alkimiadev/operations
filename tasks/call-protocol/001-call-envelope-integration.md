---
id: call-envelope-integration
name: Update PendingRequestMap and CallHandler for ResponseEnvelope
status: completed
depends_on: [response-envelope-tests]
scope: broad
risk: medium
impact: project
level: implementation
---

## Description

Update `src/call.ts` to integrate `ResponseEnvelope` throughout the call protocol. This covers all changes documented in call-protocol.md and api-surface.md's "Source vs. Spec Drift" sections for ADR-005.

Changes needed:

### `CallEventSchema["call.responded"]`
- Change `output` from `Type.Unknown()` to `ResponseEnvelopeSchema`

### `PendingRequestMap.respond()`
- Add `isResponseEnvelope()` guard — throws if `output` is not a valid envelope
- This enforces the invariant that all call protocol responses carry source metadata

### `PendingRequestMap.call()`
- Return type changes from `Promise<unknown>` to `Promise<ResponseEnvelope>`
- Resolution: the `call.responded` subscription handler resolves with the `ResponseEnvelope` from `output` field (which is already validated by `respond()`)

### `CallHandler`
- **Handler model change**: Handler returns a value; `CallHandler` wraps and publishes. Handler does NOT publish `call.responded` itself.
- Capture handler return value
- Apply shared result pipeline:
  1. Detect: `isResponseEnvelope(result)` → pass through
  2. Wrap: `localEnvelope(result, operationId)`
  3. Normalize: `Value.Cast(spec.outputSchema, envelope.data)` when `outputSchema !== Type.Unknown()`
  4. Validate: `collectErrors` on `envelope.data` — warning-only
- Publish `call.responded` via `callMap.respond(requestId, envelope)`
- On handler exception: `mapError()` converts to `CallError`, publish `call.error`

**Note**: Access control in `CallHandler` stays as-is (checking `identity` and `checkAccess`). ADR-006's change to make `CallHandler` call `execute()` is a separate task.

## Acceptance Criteria

- [x] `CallEventSchema["call.responded"].output` is `ResponseEnvelopeSchema`
- [x] `PendingRequestMap.respond()` validates `output` with `isResponseEnvelope()`, throws on raw values
- [x] `PendingRequestMap.call()` return type is `Promise<ResponseEnvelope>`
- [x] `CallHandler` captures handler return value instead of discarding it
- [x] `CallHandler` applies result pipeline: detect → wrap → normalize → validate
- [x] `CallHandler` publishes `call.responded` via `callMap.respond()` with the envelope
- [x] `CallHandler` on handler exception publishes `call.error` (not re-throws)
- [x] Adapter handlers (pre-built envelopes via `mcpEnvelope`/`httpEnvelope`) pass through via `isResponseEnvelope()`
- [x] Existing `call.test.ts` tests updated for new return types and behavior
- [x] New tests for: envelope validation in `respond()`, envelope wrapping in `CallHandler`, envelope passthrough, Value.Cast normalization
- [x] `npm run build` passes
- [x] `npm run lint` passes
- [x] `npm test` passes

## References

- docs/architecture/call-protocol.md § Source vs. Spec Drift (ADR-005 items)
- docs/architecture/api-surface.md § Source vs. Spec Drift (ADR-005 items)
- docs/architecture/response-envelopes.md § CallHandler, § PendingRequestMap
- src/call.ts

## Notes

`CallHandlerConfig` changed from `{ registry, eventTarget? }` to `{ registry, callMap? }` to support publishing `call.responded` via `callMap.respond()`. When `callMap` is not provided, errors are thrown directly (backward-compatible for direct use without the call protocol).

`Value.Cast` in TypeBox does not strip excess properties from objects — it only fills defaults and upcasts values. The test was updated to verify default-filling behavior rather than property stripping.

## Summary

Integrated ResponseEnvelope throughout the call protocol in `src/call.ts`.

- Modified: `src/call.ts` (52 lines changed)
  - `CallEventSchema["call.responded"].output` → `ResponseEnvelopeSchema`
  - `PendingRequest.call()` → `Promise<ResponseEnvelope>`
  - `PendingRequestMap.respond()` → validates with `isResponseEnvelope()`, throws on raw values
  - `CallHandler` → captures return value, applies detect→wrap→normalize→validate pipeline, publishes via `callMap`
  - `CallHandlerConfig` → `{ registry, callMap? }` replacing `eventTarget?`
  - Added imports: `KindGuard`, `Value`, `collectErrors`, `formatValueErrors`, `ResponseEnvelopeSchema`, `isResponseEnvelope`, `localEnvelope`
- Modified: `test/call.test.ts` (547 lines added)
  - Updated existing tests to pass `ResponseEnvelope` to `respond()`
  - Added 23 new tests: envelope validation in `respond()`, envelope wrapping in `CallHandler`, envelope passthrough (mcp/http), `Value.Cast` normalization, error publishing, and no-callMap fallback behavior
- All 189 tests passing
- Build and lint passing