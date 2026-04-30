import { OperationType } from "./types.js";
import type { OperationContext, OperationEnv } from "./types.js";
import type { OperationRegistry } from "./registry.js";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:env");

export interface PendingRequestMap {
  call(operationId: string, input: unknown, options?: { parentRequestId?: string; identity?: unknown }): Promise<unknown>;
}

export interface EnvOptions {
  registry: OperationRegistry;
  context: OperationContext;
  allowedNamespaces?: string[];
  callMap?: PendingRequestMap;
}

export function buildEnv(options: EnvOptions): OperationEnv {
  const { registry, context, allowedNamespaces, callMap } = options;
  const operations = registry.list();

  const namespaces: OperationEnv = {};

  for (const operation of operations) {
    if (allowedNamespaces && !allowedNamespaces.includes(operation.namespace)) {
      continue;
    }

    if (operation.type === OperationType.SUBSCRIPTION) {
      continue;
    }

    if (!namespaces[operation.namespace]) {
      namespaces[operation.namespace] = {};
    }

    const operationId = `${operation.namespace}.${operation.name}`;

    if (callMap) {
      namespaces[operation.namespace][operation.name] = async (input: unknown) => {
        logger.debug(`Call protocol: ${operationId}`);
        return await callMap.call(operationId, input, {
          parentRequestId: context.requestId,
        });
      };
    } else {
      namespaces[operation.namespace][operation.name] = async (input: unknown) => {
        logger.debug(`Executing: ${operationId}`);
        return await registry.execute(operationId, input, context);
      };
    }
  }

  return namespaces;
}