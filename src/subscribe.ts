import type { IOperationDefinition, OperationContext } from "./types.js";
import { OperationRegistry } from "./registry.js";

export async function* subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<unknown, void, unknown> {
  const operation = registry.get(operationId);

  if (!operation) {
    throw new Error(`Operation not found: ${operationId}`);
  }

  const handler = operation.handler;
  const generator = handler(input, context) as AsyncGenerator<unknown, void, unknown>;

  try {
    for await (const value of generator) {
      yield value;
    }
  } finally {
    if (generator.return) {
      await generator.return(undefined);
    }
  }
}