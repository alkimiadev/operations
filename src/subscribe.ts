import type { OperationContext } from "./types.js";
import { OperationRegistry } from "./registry.js";

export async function* subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<unknown, void, unknown> {
  const spec = registry.getSpec(operationId);

  if (!spec) {
    throw new Error(`Operation not found: ${operationId}`);
  }

  const handler = registry.getHandler(operationId);

  if (!handler) {
    throw new Error(`No handler registered for operation: ${operationId}`);
  }

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