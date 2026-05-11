import { OperationType } from "./types.js";
import type { OperationContext, OperationEnv } from "./types.js";
import type { OperationRegistry } from "./registry.js";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:env");

export interface EnvOptions {
  registry: OperationRegistry;
  context: OperationContext;
  allowedNamespaces?: string[];
}

export function buildEnv(options: EnvOptions): OperationEnv {
  const { registry, context, allowedNamespaces } = options;
  const specs = registry.getAllSpecs();

  const namespaces: OperationEnv = {};

  for (const spec of specs) {
    if (allowedNamespaces && !allowedNamespaces.includes(spec.namespace)) {
      continue;
    }

    if (spec.type === OperationType.SUBSCRIPTION) {
      continue;
    }

    if (!namespaces[spec.namespace]) {
      namespaces[spec.namespace] = {};
    }

    const operationId = `${spec.namespace}.${spec.name}`;

    const nestedContext: OperationContext = {
      ...context,
      trusted: true,
    };

    namespaces[spec.namespace][spec.name] = async (input: unknown) => {
      logger.debug(`Executing: ${operationId}`);
      return await registry.execute(operationId, input, nestedContext);
    };
  }

  return namespaces;
}