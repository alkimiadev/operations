# Access Control

Operations declare their access requirements in `accessControl`. The registry and call handler enforce these before executing the handler.

## AccessControl Fields

```ts
interface AccessControl {
  requiredScopes: string[];       // ALL must be present (AND)
  requiredScopesAny?: string[];   // At least ONE must match (OR)
  resourceType?: string;          // e.g., "project", "tool"
  resourceAction?: string;        // e.g., "read", "write", "execute"
}
```

### requiredScopes (AND)

Every scope in the array must be present in the caller's identity:

```ts
accessControl: {
  requiredScopes: ["task:read", "task:write"],
}
```

The caller must have **both** `task:read` and `task:write`.

### requiredScopesAny (OR)

At least one scope must match:

```ts
accessControl: {
  requiredScopes: ["admin"],
  requiredScopesAny: ["task:read", "task:write"],
}
```

The caller needs `admin` AND either `task:read` or `task:write`.

### Resource-based access

When both `resourceType` and `resourceAction` are set, the caller's `resources` map is checked:

```ts
accessControl: {
  requiredScopes: [],
  resourceType: "project",
  resourceAction: "read",
}
```

The identity must have `resources` with a key matching `project:*` and `"read"` in the actions array:

```ts
identity: {
  id: "user-1",
  scopes: [],
  resources: { "project:abc": ["read", "write"] },
}
```

## Identity

```ts
interface Identity {
  id: string;
  scopes: string[];
  resources?: Record<string, string[]>;
}
```

## Enforcement

### enforceAccess()

Throws `CallError(ACCESS_DENIED)` if access is denied:

```ts
import { enforceAccess } from "@alkdev/operations";

enforceAccess(spec.accessControl, context.identity, operationId, context.trusted);
```

Used internally by `registry.execute()` and `subscribe()`. Passes automatically if `context.trusted` is `true`.

### checkAccess()

Returns a boolean without throwing:

```ts
import { checkAccess } from "@alkdev/operations";

if (!checkAccess(spec.accessControl, identity)) {
  // deny access
}
```

## Trusted Contexts

When `buildEnv()` creates an `OperationEnv` for inter-operation calls, it sets `trusted: true` on the context. This bypasses all access control checks, allowing internal operations to call each other without needing every scope.

Direct `registry.execute()` calls within a process can also pass `trusted: true`, but **untrusted callers should go through the call protocol** which always enforces access control.