import { Type, type Static } from "@alkdev/typebox";
import { createPubSub, type PubSub } from "@alkdev/pubsub";
import { OperationRegistry } from "./registry.js";
import { CallError, InfrastructureErrorCode, mapError } from "./error.js";
import { ResponseEnvelopeSchema } from "./response-envelope.js";
import type { ResponseEnvelope } from "./response-envelope.js";
import type { Identity, OperationContext, AccessControl } from "./types.js";

export const CallEventSchema = {
  "call.requested": Type.Object({
    requestId: Type.String(),
    operationId: Type.String(),
    input: Type.Unknown(),
    parentRequestId: Type.Optional(Type.String()),
    deadline: Type.Optional(Type.Number()),
    identity: Type.Optional(Type.Object({
      id: Type.String(),
      scopes: Type.Array(Type.String()),
      resources: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String()))),
    })),
  }),
  "call.responded": Type.Object({
    requestId: Type.String(),
    output: ResponseEnvelopeSchema,
  }),
  "call.aborted": Type.Object({
    requestId: Type.String(),
  }),
  "call.error": Type.Object({
    requestId: Type.String(),
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
  }),
} as const;

export type CallRequestedEvent = Static<typeof CallEventSchema["call.requested"]>;
export type CallRespondedEvent = Static<typeof CallEventSchema["call.responded"]>;
export type CallAbortedEvent = Static<typeof CallEventSchema["call.aborted"]>;
export type CallErrorEvent = Static<typeof CallEventSchema["call.error"]>;
export type CallEventMapValue = CallRequestedEvent | CallRespondedEvent | CallAbortedEvent | CallErrorEvent;

export const CallEventMap = CallEventSchema;

type CallPubSubMap = {
  "call.requested": CallRequestedEvent;
  "call.responded": CallRespondedEvent;
  "call.aborted": CallAbortedEvent;
  "call.error": CallErrorEvent;
};

interface PendingRequest {
  resolve: (value: ResponseEnvelope) => void;
  reject: (reason: unknown) => void;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
}

export interface CallHandlerConfig {
  registry: OperationRegistry;
  callMap?: PendingRequestMap;
}

export type CallHandler = (event: CallRequestedEvent) => Promise<void>;

export class PendingRequestMap {
  private requests = new Map<string, PendingRequest>();
  private pubsub: PubSub<CallPubSubMap>;

  constructor(eventTarget?: EventTarget) {
    this.pubsub = createPubSub<CallPubSubMap>(
      eventTarget ? { eventTarget: eventTarget as any } : undefined
    );
    this.setupSubscriptions();
  }

  private setupSubscriptions(): void {
    const respondedIter = this.pubsub.subscribe("call.responded", "");
    (async () => {
      for await (const envelope of respondedIter) {
        const responded = envelope.payload;
        const pending = this.requests.get(responded.requestId);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          this.requests.delete(responded.requestId);
          pending.resolve(responded.output as ResponseEnvelope);
        }
      }
    })();

    const errorIter = this.pubsub.subscribe("call.error", "");
    (async () => {
      for await (const envelope of errorIter) {
        const err = envelope.payload;
        const pending = this.requests.get(err.requestId);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          this.requests.delete(err.requestId);
          pending.reject(new CallError(err.code, err.message, err.details));
        }
      }
    })();

    const abortedIter = this.pubsub.subscribe("call.aborted", "");
    (async () => {
      for await (const envelope of abortedIter) {
        const aborted = envelope.payload;
        const pending = this.requests.get(aborted.requestId);
        if (pending) {
          if (pending.timer) clearTimeout(pending.timer);
          this.requests.delete(aborted.requestId);
          pending.reject(new CallError(InfrastructureErrorCode.ABORTED, `Request ${aborted.requestId} was aborted`));
        }
      }
    })();
  }

  async call(
    operationId: string,
    input: unknown,
    options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
  ): Promise<ResponseEnvelope> {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };

      if (options?.deadline) {
        pending.deadline = options.deadline;
        pending.timer = setTimeout(() => {
          this.requests.delete(requestId);
          reject(new CallError(InfrastructureErrorCode.TIMEOUT, `Request ${requestId} timed out`, { deadline: options.deadline }));
        }, options.deadline - Date.now());
      }

      this.requests.set(requestId, pending);

      this.pubsub.publish("call.requested", "", {
        requestId,
        operationId,
        input,
        parentRequestId: options?.parentRequestId,
        deadline: options?.deadline,
        identity: options?.identity,
      });
    });
  }

  respond(requestId: string, output: ResponseEnvelope): void {
    if (!isResponseEnvelope(output)) {
      throw new Error("PendingRequestMap.respond() requires a ResponseEnvelope. Use isResponseEnvelope() to check values before calling respond().");
    }
    this.pubsub.publish("call.responded", "", {
      requestId,
      output,
    });
  }

  emitError(requestId: string, code: string, message: string, details?: unknown): void {
    this.pubsub.publish("call.error", "", {
      requestId,
      code,
      message,
      details,
    });
  }

  abort(requestId: string): void {
    const pending = this.requests.get(requestId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.requests.delete(requestId);
      this.pubsub.publish("call.aborted", "", { requestId });
      pending.reject(new CallError(InfrastructureErrorCode.ABORTED, `Request ${requestId} was aborted`));
    }
  }

  getPendingCount(): number {
    return this.requests.size;
  }
}

export function buildCallHandler(config: CallHandlerConfig): CallHandler {
  const { registry, callMap } = config;

  return async (event: CallRequestedEvent): Promise<void> => {
    const { requestId, operationId, input, identity } = event;

    const context: OperationContext = {
      requestId,
      parentRequestId: event.parentRequestId,
      identity,
    };

    try {
      const envelope = await registry.execute(operationId, input, context);

      if (callMap) {
        callMap.respond(requestId, envelope);
      }
    } catch (error) {
      const callError = mapError(error);
      if (callMap) {
        callMap.emitError(requestId, callError.code, callError.message, callError.details);
      } else {
        throw callError;
      }
    }
  };
}

export function checkAccess(accessControl: AccessControl, identity: Identity): boolean {
  const { requiredScopes, requiredScopesAny, resourceType, resourceAction } = accessControl;

  if (requiredScopes.length > 0) {
    const hasAll = requiredScopes.every((scope: string) => identity.scopes.includes(scope));
    if (!hasAll) return false;
  }

  if (requiredScopesAny && requiredScopesAny.length > 0) {
    const hasAny = requiredScopesAny.some((scope: string) => identity.scopes.includes(scope));
    if (!hasAny) return false;
  }

  if (resourceType && resourceAction) {
    if (!identity.resources) return false;
    for (const [key, actions] of Object.entries(identity.resources)) {
      if (key.startsWith(`${resourceType}:`) && actions.includes(resourceAction)) {
        return true;
      }
    }
    return false;
  }

  return true;
}

function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!("data" in obj) || !("meta" in obj)) return false;
  if (typeof obj.meta !== "object" || obj.meta === null) return false;
  return ["local", "http", "mcp"].includes((obj.meta as Record<string, unknown>).source as string);
}