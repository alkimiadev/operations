import type { OperationContext } from "./types.js";
import { OperationRegistry } from "./registry.js";
import { type ResponseEnvelope, isResponseEnvelope, localEnvelope } from "./response-envelope.js";
import { CallError, InfrastructureErrorCode } from "./error.js";
import { enforceAccess } from "./access.js";
import { validateOrThrow } from "./validation.js";

export async function* subscribe(
  registry: OperationRegistry,
  operationId: string,
  input: unknown,
  context: OperationContext,
): AsyncGenerator<ResponseEnvelope, void, unknown> {
  const spec = registry.getSpec(operationId);

  if (!spec) {
    throw new CallError(
      InfrastructureErrorCode.OPERATION_NOT_FOUND,
      `Operation not found: ${operationId}`,
      { operationId },
    );
  }

  const handler = registry.getHandler(operationId);

  if (!handler) {
    throw new CallError(
      InfrastructureErrorCode.OPERATION_NOT_FOUND,
      `No handler registered for operation: ${operationId}`,
      { operationId },
    );
  }

  enforceAccess(spec.accessControl, context.identity, operationId, context.trusted);

  validateOrThrow(spec.inputSchema, input, `Input validation failed for ${operationId}`);

  const result: unknown = handler(input, context);

  if (result == null || typeof (result as Record<symbol, unknown>)[Symbol.asyncIterator] !== "function") {
    throw new CallError(
      InfrastructureErrorCode.EXECUTION_ERROR,
      `Subscription handler for "${operationId}" must return an async iterable (async generator), but got ${result === null ? "null" : typeof result}`,
      { operationId },
    );
  }

  const generator = result as AsyncGenerator<unknown, void, unknown>;

  try {
    for await (const value of generator) {
      if (isResponseEnvelope(value)) {
        yield value;
      } else {
        yield localEnvelope(value, operationId);
      }
    }
  } finally {
    if (generator.return) {
      await generator.return(undefined);
    }
  }
}