# Validation

TypeBox-based schema validation helpers for operation inputs and outputs.

## validateOrThrow

Validates a value against a TypeBox schema. Throws on failure with formatted error messages:

```ts
import { validateOrThrow } from "@alkdev/operations";

validateOrThrow(schema, input, "Input validation failed for task.create");
```

Used internally by `registry.execute()` to validate inputs before running handlers.

## collectErrors

Returns an array of errors without throwing:

```ts
import { collectErrors } from "@alkdev/operations";

const errors = collectErrors(schema, value);
// [{ path: "/title", message: "Expected string" }, ...]
```

Used internally by `registry.execute()` to warn on output validation failures.

## assertIsSchema

Validates that a value is a TypeBox schema. Throws if not:

```ts
import { assertIsSchema } from "@alkdev/operations";

assertIsSchema(maybeSchema, "task.create input");
```

Useful when receiving schemas from external sources (JSON, OpenAPI) before passing them to the registry.

## formatValueErrors

Formats an iterable of `{ path, message }` errors into a human-readable string:

```ts
import { formatValueErrors } from "@alkdev/operations";

const formatted = formatValueErrors(errors);
// "  - /title: Expected string\n  - /priority: Expected union member"
```

Accepts an optional indent prefix (default `"  - "`).