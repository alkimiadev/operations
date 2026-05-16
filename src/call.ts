import { Type, type Static } from "@alkdev/typebox";
import { createPubSub, type PubSub, Repeater, type Push, type Stop } from "@alkdev/pubsub";
import { OperationRegistry } from "./registry.js";
import { subscribe } from "./subscribe.js";
import { CallError, InfrastructureErrorCode, mapError } from "./error.js";
import { ResponseEnvelopeSchema, isResponseEnvelope } from "./response-envelope.js";
import type { ResponseEnvelope } from "./response-envelope.js";
import type { Identity, OperationContext } from "./types.js";
import { OperationType } from "./types.js";

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

interface PendingCall {
  resolve: (value: ResponseEnvelope) => void;
  reject: (reason: unknown) => void;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface SubscriptionState {
  push: Push<ResponseEnvelope>;
  stop: Stop;
  deadline?: number;
  timer?: ReturnType<typeof setTimeout>;
  consumerStopped?: boolean;
}

type PendingEntry =
  | { type: "call"; pending: PendingCall }
  | { type: "subscribe"; state: SubscriptionState };

export interface CallHandlerConfig {
  registry: OperationRegistry;
  callMap: PendingRequestMap;
}

export type CallHandler = (event: CallRequestedEvent) => Promise<void>;

export class PendingRequestMap {
  private entries = new Map<string, PendingEntry>();
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
        const entry = this.entries.get(responded.requestId);
        if (!entry) continue;

        if (entry.type === "call") {
          if (entry.pending.timer) clearTimeout(entry.pending.timer);
          this.entries.delete(responded.requestId);
          entry.pending.resolve(responded.output as ResponseEnvelope);
        } else {
          if (entry.state.timer) {
            clearTimeout(entry.state.timer);
            if (entry.state.deadline) {
              entry.state.timer = this.startSubscriptionTimer(responded.requestId, entry.state.deadline);
            }
          }
          entry.state.push(responded.output as ResponseEnvelope);
        }
      }
    })();

    const errorIter = this.pubsub.subscribe("call.error", "");
    (async () => {
      for await (const envelope of errorIter) {
        const err = envelope.payload;
        const entry = this.entries.get(err.requestId);
        if (!entry) continue;

        if (entry.type === "call") {
          if (entry.pending.timer) clearTimeout(entry.pending.timer);
          this.entries.delete(err.requestId);
          entry.pending.reject(new CallError(err.code, err.message, err.details));
        } else {
          if (entry.state.timer) clearTimeout(entry.state.timer);
          entry.state.consumerStopped = true;
          entry.state.stop(new CallError(err.code, err.message, err.details));
          this.entries.delete(err.requestId);
        }
      }
    })();

    const abortedIter = this.pubsub.subscribe("call.aborted", "");
    (async () => {
      for await (const envelope of abortedIter) {
        const aborted = envelope.payload;
        const entry = this.entries.get(aborted.requestId);
        if (!entry) continue;

        if (entry.type === "call") {
          if (entry.pending.timer) clearTimeout(entry.pending.timer);
          this.entries.delete(aborted.requestId);
          entry.pending.reject(new CallError(InfrastructureErrorCode.ABORTED, `Request ${aborted.requestId} was aborted`));
        } else {
          if (entry.state.timer) clearTimeout(entry.state.timer);
          entry.state.consumerStopped = true;
          entry.state.stop();
          this.entries.delete(aborted.requestId);
        }
      }
    })();
  }

  private startSubscriptionTimer(requestId: string, deadline: number): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const entry = this.entries.get(requestId);
      if (!entry || entry.type !== "subscribe") return;
      if (entry.state.timer) clearTimeout(entry.state.timer);
      entry.state.consumerStopped = true;
      this.pubsub.publish("call.aborted", "", { requestId });
      entry.state.stop(new CallError(InfrastructureErrorCode.TIMEOUT, `Subscription ${requestId} timed out (idle)`, { deadline }));
    }, deadline);
  }

  async call(
    operationId: string,
    input: unknown,
    options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
  ): Promise<ResponseEnvelope> {
    const requestId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      const pending: PendingCall = { resolve, reject };

      if (options?.deadline) {
        pending.deadline = options.deadline;
        pending.timer = setTimeout(() => {
          this.entries.delete(requestId);
          reject(new CallError(InfrastructureErrorCode.TIMEOUT, `Request ${requestId} timed out`, { deadline: options.deadline }));
        }, options.deadline - Date.now());
      }

      this.entries.set(requestId, { type: "call", pending });

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

  subscribe(
    operationId: string,
    input: unknown,
    options?: { parentRequestId?: string; deadline?: number; identity?: Identity },
  ): AsyncIterable<ResponseEnvelope> {
    const requestId = crypto.randomUUID();

    const repeater = new Repeater<ResponseEnvelope>((push: Push<ResponseEnvelope>, stop: Stop) => {
      const state: SubscriptionState = { push, stop };

      if (options?.deadline) {
        state.deadline = options.deadline;
        state.timer = this.startSubscriptionTimer(requestId, options.deadline);
      }

      this.entries.set(requestId, { type: "subscribe", state });

      this.pubsub.publish("call.requested", "", {
        requestId,
        operationId,
        input,
        parentRequestId: options?.parentRequestId,
        deadline: options?.deadline,
        identity: options?.identity,
      });

      stop.then(() => {
        const entry = this.entries.get(requestId);
        if (entry && entry.type === "subscribe") {
          if (entry.state.timer) clearTimeout(entry.state.timer);
          if (!entry.state.consumerStopped) {
            this.pubsub.publish("call.aborted", "", { requestId });
          }
          this.entries.delete(requestId);
        }
      });
    });

    return repeater;
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
    const entry = this.entries.get(requestId);
    if (!entry) return;

    if (entry.type === "call") {
      if (entry.pending.timer) clearTimeout(entry.pending.timer);
      this.entries.delete(requestId);
      this.pubsub.publish("call.aborted", "", { requestId });
      entry.pending.reject(new CallError(InfrastructureErrorCode.ABORTED, `Request ${requestId} was aborted`));
    } else {
      if (entry.state.timer) clearTimeout(entry.state.timer);
      entry.state.consumerStopped = true;
      this.pubsub.publish("call.aborted", "", { requestId });
      entry.state.stop();
    }
  }

  getPendingCount(): number {
    return this.entries.size;
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
      const spec = registry.getSpec(operationId);
      if (!spec) {
        throw new CallError(InfrastructureErrorCode.OPERATION_NOT_FOUND, `Operation not found: ${operationId}`, { operationId });
      }

      if (spec.type === OperationType.SUBSCRIPTION) {
        for await (const envelope of subscribe(registry, operationId, input, context)) {
          callMap.respond(requestId, envelope);
        }
      } else {
        const envelope = await registry.execute(operationId, input, context);
        callMap.respond(requestId, envelope);
      }
    } catch (error) {
      const spec = registry.getSpec(operationId);
      const callError = mapError(error, spec?.errorSchemas);
      callMap.emitError(requestId, callError.code, callError.message, callError.details);
    }
  };
}



