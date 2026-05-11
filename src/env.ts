import { OperationType } from "./types.js";
import type { OperationContext, OperationEnv, Identity } from "./types.js";
import type { OperationRegistry } from "./registry.js";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:env");

export interface CallMap {
  call(operationId: string, input: unknown, options?: { parentRequestId?: string; deadline?: number; identity?: Identity }): Promise<unknown>;
}

export interface EnvOptions {
  registry: OperationRegistry;
  context: OperationContext;
  allowedNamespaces?: string[];
  callMap?: CallMap;
}

export function buildEnv(options: EnvOptions): OperationEnv {
  const { registry, context, allowedNamespaces, callMap } = options;
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

    if (callMap) {
      namespaces[spec.namespace][spec.name] = async (input: unknown) => {
        logger.debug(`Call protocol: ${operationId}`);
        return await callMap.call(operationId, input, {
          parentRequestId: context.requestId,
        });
      };
    } else {
      namespaces[spec.namespace][spec.name] = async (input: unknown) => {
        logger.debug(`Executing: ${operationId}`);
        return await registry.execute(operationId, input, context);
      };
    }
  }

  return namespaces;
}