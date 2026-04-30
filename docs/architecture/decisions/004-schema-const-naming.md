# ADR-004: Schema Const Naming Convention

**Status**: Accepted
**Date**: 2026-04-30

## Context

TypeBox schemas and their inferred types need different names but represent the same concept. For example, the `AccessControl` schema defines the runtime shape and the `AccessControl` type provides the TypeScript interface. Using the same name for both creates a naming collision.

Two naming conventions are common in TypeBox codebases:

1. **Same name** — `AccessControl` for both the schema constant and the inferred type (relies on TypeScript's value/type namespace separation)
2. **Different names** — `AccessControlSchema` for the schema constant, `AccessControl` for the inferred type

## Decision

Use the `Schema` suffix for schema constants. The inferred type uses the bare name.

```ts
export const AccessControlSchema = Type.Object({ ... })
export type AccessControl = Static<typeof AccessControlSchema>

export const OperationSpecSchema = Type.Object({ ... })
export type OperationSpec = Static<typeof OperationSpecSchema>

export const ErrorDefinitionSchema = Type.Object({ ... })
export type ErrorDefinition = Static<typeof ErrorDefinitionSchema>

export const OperationDefinitionSchema = Type.Object({ ... })
export interface IOperationDefinition<...> extends OperationSpec<...> { ... }
```

## Rationale

1. **No ambiguity** — `AccessControl` always refers to the type, `AccessControlSchema` always refers to the runtime schema. No mental overhead to distinguish them.

2. **TypeScript namespace separation is fragile** — while TypeScript technically allows the same name for a value and a type (they occupy different namespaces), this creates confusion when reading code. `const ac: AccessControl = ...` — which `AccessControl`? The schema or the type? With the `Schema` suffix, it's immediately clear.

3. **Consistent with TypeBox conventions** — TypeBox's own `Type.*` factory functions produce schema objects. Naming the const with a `Schema` suffix aligns with the mental model that these are schema definitions, not data instances.

4. **Export clarity** — in `index.ts`, both are exported. Having distinct names means `import { AccessControlSchema, AccessControl }` is immediately clear: one is a runtime value, one is a type.

5. **Existing pattern** — this convention is already used in `OperationDefinitionSchema` vs `IOperationDefinition` and `OperationSpecSchema` vs `OperationSpec` in the codebase.

## Consequences

- All schema const names end in `Schema`
- All type names are the bare concept name (or prefixed with `I` for interfaces)
- This applies to `AccessControlSchema`/`AccessControl`, `ErrorDefinitionSchema`/`ErrorDefinition`, `OperationContextSchema`/`OperationContext`, `OperationSpecSchema`/`OperationSpec`, `OperationDefinitionSchema`/`IOperationDefinition`
- When adding new schemas, follow this convention: `FooSchema` for the const, `Foo` for the type