import { Type, type Static } from "@alkdev/typebox";

export type ResponseSource = "local" | "http" | "mcp"

export interface LocalResponseMeta {
  source: "local"
  operationId: string
  timestamp: number
}

export interface HTTPResponseMeta {
  source: "http"
  statusCode: number
  headers: Record<string, string>
  contentType: string
}

export type MCPContentBlock =
  | { type: "text"; text: string; annotations?: MCPAnnotations }
  | { type: "image"; data: string; mimeType: string; annotations?: MCPAnnotations }
  | { type: "audio"; data: string; mimeType: string; annotations?: MCPAnnotations }
  | { type: "resource"; resource: MCPResourceContent; annotations?: MCPAnnotations }
  | { type: "resource_link"; uri: string; name: string; description?: string; mimeType?: string }

export interface MCPResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface MCPAnnotations {
  audience?: Array<"user" | "assistant">
  priority?: number
  lastModified?: string
}

export interface MCPResponseMeta {
  source: "mcp"
  isError: boolean
  content: MCPContentBlock[]
  structuredContent?: Record<string, unknown>
  _meta?: Record<string, unknown>
}

export type ResponseMeta = LocalResponseMeta | HTTPResponseMeta | MCPResponseMeta

export interface ResponseEnvelope<T = unknown> {
  data: T
  meta: ResponseMeta
}

const LocalResponseMetaSchema = Type.Object({
  source: Type.Literal("local"),
  operationId: Type.String(),
  timestamp: Type.Number(),
})

const HTTPResponseMetaSchema = Type.Object({
  source: Type.Literal("http"),
  statusCode: Type.Number(),
  headers: Type.Record(Type.String(), Type.String()),
  contentType: Type.String(),
})

const MCPAnnotationsSchema = Type.Object({
  audience: Type.Optional(Type.Array(Type.Union([Type.Literal("user"), Type.Literal("assistant")]))),
  priority: Type.Optional(Type.Number()),
  lastModified: Type.Optional(Type.String()),
})

const MCPResourceContentSchema = Type.Object({
  uri: Type.String(),
  mimeType: Type.Optional(Type.String()),
  text: Type.Optional(Type.String()),
  blob: Type.Optional(Type.String()),
})

const MCPContentBlockSchema = Type.Union([
  Type.Object({
    type: Type.Literal("text"),
    text: Type.String(),
    annotations: Type.Optional(MCPAnnotationsSchema),
  }),
  Type.Object({
    type: Type.Literal("image"),
    data: Type.String(),
    mimeType: Type.String(),
    annotations: Type.Optional(MCPAnnotationsSchema),
  }),
  Type.Object({
    type: Type.Literal("audio"),
    data: Type.String(),
    mimeType: Type.String(),
    annotations: Type.Optional(MCPAnnotationsSchema),
  }),
  Type.Object({
    type: Type.Literal("resource"),
    resource: MCPResourceContentSchema,
    annotations: Type.Optional(MCPAnnotationsSchema),
  }),
  Type.Object({
    type: Type.Literal("resource_link"),
    uri: Type.String(),
    name: Type.String(),
    description: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
  }),
])

const MCPResponseMetaSchema = Type.Object({
  source: Type.Literal("mcp"),
  isError: Type.Boolean(),
  content: Type.Array(MCPContentBlockSchema),
  structuredContent: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  _meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
})

export const ResponseMetaSchema = Type.Union([
  LocalResponseMetaSchema,
  HTTPResponseMetaSchema,
  MCPResponseMetaSchema,
])

export const ResponseEnvelopeSchema = Type.Object({
  data: Type.Unknown({ description: "Operation output" }),
  meta: ResponseMetaSchema,
})

export const RESPONSE_SOURCES = ["local", "http", "mcp"] as const

export function isResponseEnvelope(value: unknown): value is ResponseEnvelope {
  if (typeof value !== "object" || value === null) return false
  const obj = value as Record<string, unknown>
  if (!("data" in obj) || !("meta" in obj)) return false
  if (typeof obj.meta !== "object" || obj.meta === null) return false
  return RESPONSE_SOURCES.includes((obj.meta as ResponseMeta).source as ResponseSource)
}

export function localEnvelope<T>(data: T, operationId: string): ResponseEnvelope<T> {
  return { data, meta: { source: "local", operationId, timestamp: Date.now() } }
}

export function httpEnvelope<T>(data: T, meta: Omit<HTTPResponseMeta, "source">): ResponseEnvelope<T> {
  return { data, meta: { source: "http", ...meta } }
}

export function mcpEnvelope<T>(data: T, meta: Omit<MCPResponseMeta, "source">): ResponseEnvelope<T> {
  return { data, meta: { source: "mcp", ...meta } }
}

export function unwrap<T>(envelope: ResponseEnvelope<T>): T {
  return envelope.data
}