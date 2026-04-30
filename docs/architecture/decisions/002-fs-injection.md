# ADR-002: Inject Filesystem Dependencies for Runtime Agnosticism

**Status**: Accepted
**Date**: 2026-04-30

## Context

The operations package must work in both Node.js and Deno. Two functions need filesystem access:

1. `scanOperations(dirPath, fs)` — recursive directory scan for `.ts` operation files
2. `FromOpenAPIFile(path, config, fs?)` — read OpenAPI JSON spec from filesystem

In Node.js, these use `node:fs/promises` and `node:path`. In Deno, they would use `Deno.readDir()` and `Deno.cwd()`. Direct use of Node APIs would break Deno; direct use of Deno globals would break Node.

## Decision

Inject filesystem dependencies through interfaces, not global imports.

```ts
interface ScannerFS {
  readdir(path: string): AsyncIterable<{ name: string; isFile: boolean; isDirectory: boolean }>
  cwd(): string
}

interface OpenAPIFS {
  readFile(path: string): Promise<string>
}
```

Callers provide the FS implementation. When `OpenAPIFS` is not provided, `FromOpenAPIFile` falls back to `node:fs/promises` via dynamic import.

## Rationale

1. **No platform globals in source** — no `Deno.*` calls anywhere in `src/`. Both Node and Deno consumers work by providing the right FS interface.

2. **Testability** — tests provide mock FS implementations. No filesystem mocking libraries needed.

3. **Consistent pattern** — `ScannerFS` and `OpenAPIFS` follow the same pattern: minimal interface, consumer-provided implementation, optional Node fallback.

4. **Deno path module** — the original alkhub scanner used `@std/path` (Deno standard library path module) for `resolve()` and `extname()`. The extracted version avoids this dependency by using simple string operations (`endsWith(".ts")`, path construction with `/`).

5. **Node fallback is dynamic** — `FromOpenAPIFile` uses `await import("node:fs/promises")` as a fallback when no `fs` is provided. This keeps the Node path out of the module graph when a custom FS is injected, and avoids top-level Node imports that would break Deno.

## Consequences

- Callers in Deno must provide `ScannerFS` and `OpenAPIFS` implementations using `Deno.readDir()` and `Deno.readTextFile()`
- Callers in Node can omit the `fs` parameter for `FromOpenAPIFile` (Node fallback) but must provide `ScannerFS` for `scanOperations`
- The `pathToFileURL` helper in scanner uses a simple `file://` prefix construction rather than `url.pathToFileURL()` to avoid importing Node's `url` module