import { Type, type Static, type TSchema } from "@alkdev/typebox";
import type { ResponseEnvelope } from "./response-envelope.js";

export enum OperationType {
  QUERY = "query",
  MUTATION = "mutation",
  SUBSCRIPTION = "subscription",
}

export interface Identity {
  id: string
  scopes: string[]
  resources?: Record<string, string[]>
}

export type OperationEnv = Record<string, Record<string, (input: unknown) => Promise<ResponseEnvelope>>>

export const OperationContextSchema = Type.Object({
  metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  requestId: Type.Optional(Type.String()),
  parentRequestId: Type.Optional(Type.String()),
  identity: Type.Optional(Type.Object({
    id: Type.String(),
    scopes: Type.Array(Type.String()),
    resources: Type.Optional(Type.Record(Type.String(), Type.Array(Type.String())))
  })),
  trusted: Type.Optional(Type.Boolean({ description: "INTERNAL: set by buildEnv(), not by callers" })),
}, {
  description: "Context provided to all operation handlers"
});

type OperationContextBase = Static<typeof OperationContextSchema>

export type OperationContext = OperationContextBase & {
  env?: OperationEnv
  stream?: () => AsyncIterable<unknown>
  pubsub?: unknown
}

export const ErrorDefinitionSchema = Type.Object({
  code: Type.String({
    description: "Error Code e.g., INVALID_INPUT, NOT_FOUND, UNAUTHORIZED"
  }),
  description: Type.String(),
  schema: Type.Unknown(),
  httpStatus: Type.Optional(Type.Number()),
});

export type ErrorDefinition = Static<typeof ErrorDefinitionSchema>;

export const AccessControlSchema = Type.Object({
  requiredScopes: Type.Array(
    Type.String(), 
    {description: "Required scopes (all must be present)"}
  ),
  requiredScopesAny: Type.Optional(
    Type.Array(Type.String({description: "Required scopes (at least one must match)"}))),
  resourceType: Type.Optional(Type.String({description: "Resource Type e.g., project, tool, data"})),
  resourceAction: Type.Optional(Type.String({description: "Required action on the resource e.g., read, write, execute"})),
  customAuth: Type.Optional(Type.String({description: "Name of custom auth function"})),
});

export type AccessControl = Static<typeof AccessControlSchema>;

export type OperationHandler<
  TInput = unknown,
  TOutput = unknown,
  TContext extends OperationContext = OperationContext,
> = (
  input: TInput,
  context: TContext,
) => Promise<TOutput> | TOutput;

export type SubscriptionHandler<
  TInput = unknown,
  TOutput = unknown,
  TContext extends OperationContext = OperationContext,
> = (
  input: TInput,
  context: TContext,
) => AsyncGenerator<TOutput, void, unknown>;

export const OperationDefinitionSchema = Type.Object({
  name: Type.String({ description: "Unique operation name" }),
  namespace: Type.String({
    description: "Namespace for grouping (e.g., 'task', 'graph', 'user')",
  }),
  version: Type.String({ description: "Semantic version (e.g., '1.0.0')" }),
  type: Type.Enum(OperationType, {
    description: "Operation type: query, mutation, or subscription",
  }),
  title: Type.Optional(Type.String({ description: "Human-readable title" })),
  description: Type.String({ description: "Detailed description" }),
  tags: Type.Optional(Type.Array(Type.String())),
  inputSchema: Type.Unknown({ description: "json schema for input" }),
  outputSchema: Type.Unknown({ description: "json schema for output" }),
  errorSchemas: Type.Optional(Type.Array(ErrorDefinitionSchema)),
  accessControl: AccessControlSchema,
  handler: Type.Unknown({ description: "Operation handler function" }),
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export interface OperationSpec<
  TInput = unknown,
  TOutput = unknown,
> {
  name: string;
  namespace: string;
  version: string;
  type: OperationType;
  title?: string;
  description: string;
  tags?: string[];
  inputSchema: TSchema;
  outputSchema: TSchema;
  errorSchemas?: ErrorDefinition[];
  accessControl: AccessControl;
  _meta?: Record<string, unknown>;
}

export const OperationSpecSchema = Type.Object({
  name: Type.String({ description: "Unique operation name" }),
  namespace: Type.String({
    description: "Namespace for grouping (e.g., 'task', 'graph', 'user')",
  }),
  version: Type.String({ description: "Semantic version (e.g., '1.0.0')" }),
  type: Type.Enum(OperationType, {
    description: "Operation type: query, mutation, or subscription",
  }),
  title: Type.Optional(Type.String({ description: "Human-readable title" })),
  description: Type.String({ description: "Detailed description" }),
  tags: Type.Optional(Type.Array(Type.String())),
  inputSchema: Type.Unknown({ description: "json schema for input" }),
  outputSchema: Type.Unknown({ description: "json schema for output" }),
  errorSchemas: Type.Optional(Type.Array(ErrorDefinitionSchema)),
  accessControl: AccessControlSchema,
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export interface IOperationDefinition<
  TInput = unknown,
  TOutput = unknown,
  TContext extends OperationContext = OperationContext,
> extends OperationSpec<TInput, TOutput> {
  handler: OperationHandler<TInput, TOutput, TContext> | SubscriptionHandler<TInput, TOutput, TContext>;
}