import type { IOperationDefinition, OperationContext, OperationSpec } from "./types.js";
import { getLogger } from "@logtape/logtape";
import { Value } from "@alkdev/typebox/value";
import { assertIsSchema, validateOrThrow, collectErrors, formatValueErrors } from "./validation.js";

const logger = getLogger("operations:registry");

export class OperationRegistry {
  private operations = new Map<string, IOperationDefinition>();

  private getOperationId(operation: IOperationDefinition): string {
    return `${operation.namespace}.${operation.name}`;
  }

  register(operation: IOperationDefinition): void {
    const opId = `${operation.namespace}.${operation.name}`;
    assertIsSchema(operation.inputSchema, `${opId} inputSchema`);
    assertIsSchema(operation.outputSchema, `${opId} outputSchema`);
    const id = this.getOperationId(operation);
    this.operations.set(id, operation);
    logger.info(`Registered operation: ${id}`);
  }

  registerAll(operations: IOperationDefinition[]): void {
    for (const op of operations) {
      this.register(op);
    }
  }

  get(id: string): IOperationDefinition | undefined {
    return this.operations.get(id);
  }

  getByName(namespace: string, name: string): IOperationDefinition | undefined {
    return this.operations.get(`${namespace}.${name}`);
  }

  list(): IOperationDefinition[] {
    return Array.from(this.operations.values());
  }

  private extractSpec(operation: IOperationDefinition): OperationSpec {
    const { handler: _handler, ...spec } = operation;
    return spec;
  }

  getSpec(id: string): OperationSpec | undefined {
    const operation = this.operations.get(id);
    return operation ? this.extractSpec(operation) : undefined;
  }

  getAllSpecs(): OperationSpec[] {
    return this.list().map(op => this.extractSpec(op));
  }

  async execute<TInput = unknown, TOutput = unknown>(
    operationId: string,
    input: TInput,
    context: OperationContext,
  ): Promise<TOutput> {
    const operation = this.operations.get(operationId);

    if (!operation) {
      throw new Error(`Operation not found: ${operationId}`);
    }

    validateOrThrow(operation.inputSchema, input, `Input validation failed for ${operationId}`);

    const result = await operation.handler(input, context) as TOutput;

    const errors = collectErrors(operation.outputSchema, result);
    if (errors.length > 0) {
      logger.warn(`Output validation failed for ${operationId}:\n${formatValueErrors(errors)}`);
    }

    return result;
  }
}