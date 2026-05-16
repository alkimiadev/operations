import { OperationType } from "./types.js";
import type { OperationContext, OperationSpec, OperationHandler, SubscriptionHandler, Identity, AccessControl } from "./types.js";
import { getLogger } from "@logtape/logtape";
import { Value } from "@alkdev/typebox/value";
import { KindGuard, type TSchema } from "@alkdev/typebox";
import { assertIsSchema, validateOrThrow, collectErrors, formatValueErrors } from "./validation.js";
import { isResponseEnvelope, localEnvelope, type ResponseEnvelope } from "./response-envelope.js";
import { CallError, InfrastructureErrorCode } from "./error.js";
import { checkAccess, enforceAccess } from "./access.js";
import type { SchemaAdapter } from "./from_typemap.js";
import { defaultAdapter } from "./from_typemap.js";

const logger = getLogger("operations:registry");

export interface RegistryOptions {
  schemaAdapter?: SchemaAdapter;
}

export class OperationRegistry {
  private specs = new Map<string, OperationSpec>();
  private handlers = new Map<string, OperationHandler | SubscriptionHandler>();
  private adapter: SchemaAdapter;

  constructor(options?: RegistryOptions) {
    this.adapter = options?.schemaAdapter ?? defaultAdapter;
  }

  private opId(namespace: string, name: string): string {
    return `${namespace}.${name}`;
  }

  private toTypeBox(schema: unknown): TSchema {
    return this.adapter.toTypeBox(schema);
  }

  register(operation: OperationSpec & { handler?: OperationHandler | SubscriptionHandler }): void {
    const id = this.opId(operation.namespace, operation.name);
    const inputSchema = this.toTypeBox(operation.inputSchema);
    const outputSchema = this.toTypeBox(operation.outputSchema);
    const { handler, ...spec } = operation;
    const resolvedSpec: OperationSpec = { ...spec, inputSchema, outputSchema };
    this.specs.set(id, resolvedSpec);
    if (handler) {
      this.validateSubscriptionHandler(id, handler);
      this.handlers.set(id, handler);
    }
    logger.info(`Registered operation: ${id}`);
  }

  registerAll(operations: Array<OperationSpec & { handler?: OperationHandler | SubscriptionHandler }>): void {
    for (const op of operations) {
      this.register(op);
    }
  }

  registerSpec(spec: OperationSpec): void {
    const id = this.opId(spec.namespace, spec.name);
    const inputSchema = this.toTypeBox(spec.inputSchema);
    const outputSchema = this.toTypeBox(spec.outputSchema);
    const resolvedSpec: OperationSpec = { ...spec, inputSchema, outputSchema };
    this.specs.set(id, resolvedSpec);
    logger.info(`Registered spec: ${id}`);
  }

  private validateSubscriptionHandler(id: string, handler: OperationHandler | SubscriptionHandler): void {
    const spec = this.specs.get(id)!;
    if (spec.type === OperationType.SUBSCRIPTION) {
      const tag = Object.prototype.toString.call(handler);
      if (tag !== '[object AsyncGeneratorFunction]') {
        throw new Error(
          `Handler for SUBSCRIPTION operation "${id}" must be an async generator function (async function*), but got ${tag}`,
        );
      }
    }
  }

  registerHandler(id: string, handler: OperationHandler | SubscriptionHandler): void {
    if (!this.specs.has(id)) {
      throw new Error(`Cannot register handler for unknown operation: ${id}`);
    }
    this.validateSubscriptionHandler(id, handler);
    this.handlers.set(id, handler);
    logger.info(`Registered handler: ${id}`);
  }

  get(id: string): (OperationSpec & { handler?: OperationHandler | SubscriptionHandler }) | undefined {
    const spec = this.specs.get(id);
    if (!spec) return undefined;
    const handler = this.handlers.get(id);
    return { ...spec, handler };
  }

  getSpec(id: string): OperationSpec | undefined {
    return this.specs.get(id);
  }

  getHandler(id: string): OperationHandler | SubscriptionHandler | undefined {
    return this.handlers.get(id);
  }

  getByName(namespace: string, name: string): (OperationSpec & { handler?: OperationHandler | SubscriptionHandler }) | undefined {
    return this.get(this.opId(namespace, name));
  }

  list(): Array<OperationSpec & { handler?: OperationHandler | SubscriptionHandler }> {
    return Array.from(this.specs.entries()).map(([id, spec]) => ({
      ...spec,
      handler: this.handlers.get(id),
    }));
  }

  getAllSpecs(): OperationSpec[] {
    return Array.from(this.specs.values());
  }

  async execute<TInput = unknown, TOutput = unknown>(
    operationId: string,
    input: TInput,
    context: OperationContext,
  ): Promise<ResponseEnvelope<TOutput>> {
    const spec = this.specs.get(operationId);
    if (!spec) {
      throw new CallError(
        InfrastructureErrorCode.OPERATION_NOT_FOUND,
        `Operation not found: ${operationId}`,
        { operationId },
      );
    }

    const handler = this.handlers.get(operationId);
    if (!handler) {
      throw new CallError(
        InfrastructureErrorCode.OPERATION_NOT_FOUND,
        `No handler registered for operation: ${operationId}`,
        { operationId },
      );
    }

    enforceAccess(spec.accessControl as AccessControl, context.identity, operationId, context.trusted);

    validateOrThrow(spec.inputSchema, input, `Input validation failed for ${operationId}`);

    const result = await handler(input, context);

    let envelope: ResponseEnvelope<TOutput>;
    if (isResponseEnvelope(result)) {
      envelope = result as ResponseEnvelope<TOutput>;
    } else {
      envelope = localEnvelope(result as TOutput, operationId);
    }

    if (!KindGuard.IsUnknown(spec.outputSchema)) {
      envelope.data = Value.Cast(spec.outputSchema, envelope.data) as TOutput;
    }

    const errors = collectErrors(spec.outputSchema, envelope.data);
    if (errors.length > 0) {
      logger.warn(`Output validation failed for ${operationId}:\n${formatValueErrors(errors)}`);
    }

    return envelope;
  }
}