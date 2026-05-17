# Error Handling

## CallError

All operational errors are represented as `CallError`, which extends `Error` with a structured `code` and optional `details`:

```ts
class CallError extends Error {
  readonly code: CallErrorCode;
  readonly details?: unknown;
}
```

```ts
import { CallError, InfrastructureErrorCode } from "@alkdev/operations";

throw new CallError(InfrastructureErrorCode.OPERATION_NOT_FOUND, "Operation not found: foo.bar", { operationId: "foo.bar" });
```

## Infrastructure Error Codes

Built-in codes for framework-level errors:

| Code | When |
|------|------|
| `OPERATION_NOT_FOUND` | No spec or handler registered for the operation ID |
| `ACCESS_DENIED` | Caller lacks required scopes or resource access |
| `VALIDATION_ERROR` | Input fails schema validation |
| `TIMEOUT` | Call or subscription timed out (deadline or idle) |
| `ABORTED` | Request was explicitly aborted |
| `EXECUTION_ERROR` | Handler threw an Error that didn't match any declared error code |
| `UNKNOWN_ERROR` | Non-Error value thrown from handler |

You can also use custom error codes as strings:

```ts
throw new CallError("INVALID_INPUT", "Title is required", { field: "title" });
```

## Declared Errors

Operations can declare expected error codes in their spec:

```ts
{
  errorSchemas: [
    { code: "INVALID_INPUT", description: "Input validation failed", schema: Type.Object({ field: Type.String() }) },
    { code: "NOT_FOUND", description: "Task not found", schema: Type.Object({ id: Type.String() }) },
  ],
}
```

## mapError

`mapError()` normalizes thrown values into `CallError`:

```ts
import { mapError } from "@alkdev/operations";

const callError = mapError(thrownValue, spec.errorSchemas);
```

Logic:
1. If already a `CallError`, returns it as-is
2. If an `Error`, checks if its message matches any declared error code prefix (`CODE:` or exact `CODE`) — returns a `CallError` with that code
3. Otherwise, returns `CallError(EXECUTION_ERROR, error.message, error)`

This is used internally by `buildCallHandler()` to map handler errors into the call protocol error format.

## Error Propagation

| Context | Behavior |
|---------|----------|
| `registry.execute()` | Throws `CallError` directly |
| `subscribe()` | Throws `CallError` into the async generator |
| `PendingRequestMap` | Emits `call.error` event, rejected promise or stopped stream |
| `buildEnv()` calls | Propagates `CallError` from the nested `execute()` |