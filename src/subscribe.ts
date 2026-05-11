import type { OperationContext, AccessControl } from "./types.js";
import { OperationRegistry } from "./registry.js";
import { type ResponseEnvelope, isResponseEnvelope, localEnvelope } from "./response-envelope.js";
import { CallError, InfrastructureErrorCode } from "./error.js";
import { checkAccess } from "./call.js";

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

  if (!context.trusted) {
    const accessControl: AccessControl = spec.accessControl as AccessControl;
    if (accessControl.requiredScopes.length > 0 || accessControl.requiredScopesAny?.length || accessControl.resourceType) {
      if (!context.identity) {
        throw new CallError(
          InfrastructureErrorCode.ACCESS_DENIED,
          `Access denied for operation: ${operationId} — identity required`,
          { operationId, requiredScopes: accessControl.requiredScopes },
        );
      }
      if (!checkAccess(accessControl, context.identity)) {
        throw new CallError(
          InfrastructureErrorCode.ACCESS_DENIED,
          `Access denied for operation: ${operationId}`,
          { requiredScopes: accessControl.requiredScopes },
        );
      }
    }
  }

  const generator = handler(input, context) as AsyncGenerator<unknown, void, unknown>;

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