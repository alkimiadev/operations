import { KindGuard, type TSchema } from "@alkdev/typebox";
import { Value } from "@alkdev/typebox/value";

export function formatValueErrors(
  errors: Iterable<{ path: string; message: string }>,
  indent: string = "  - ",
): string {
  return [...errors]
    .map((err) => `${indent}${err.path}: ${err.message}`)
    .join("\n");
}

export function assertIsSchema(schema: unknown, context?: string): void {
  const contextMsg = context ? ` for ${context}` : "";
  if (!KindGuard.IsSchema(schema)) {
    throw new Error(`Not a valid TypeBox schema${contextMsg}. Use FromSchema() to convert JSON Schema to TypeBox.`);
  }
}

export function validateOrThrow(
  schema: TSchema,
  value: unknown,
  context?: string,
): void {
  if (!Value.Check(schema, value)) {
    const errors = Value.Errors(schema, value);
    const formatted = formatValueErrors(errors);
    const contextMsg = context ? ` for ${context}` : "";
    throw new Error(`Validation failed${contextMsg}:\n${formatted}`);
  }
}

export function collectErrors(
  schema: TSchema,
  value: unknown,
): Array<{ path: string; message: string }> {
  if (Value.Check(schema, value)) {
    return [];
  }
  return [...Value.Errors(schema, value)].map((err) => ({
    path: err.path,
    message: err.message,
  }));
}