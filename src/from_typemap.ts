import type { TSchema } from "@alkdev/typebox";
import { KindGuard } from "@alkdev/typebox";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:typemap");

export interface SchemaAdapter {
  toTypeBox(schema: unknown): TSchema;
  init?(): Promise<void>;
}

export const defaultAdapter: SchemaAdapter = {
  toTypeBox(schema: unknown): TSchema {
    if (KindGuard.IsSchema(schema)) {
      return schema as TSchema;
    }
    throw new Error(
      `SchemaAdapter: expected a TypeBox schema, but received ${typeof schema}. ` +
      `Install @alkdev/typemap and use zodAdapter/valibotAdapter to convert from other schema libraries.`
    );
  },
};

function isStandardSchemaFrom(value: unknown, vendor: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const standard = (value as Record<string, unknown>)["~standard"];
  if (typeof standard !== "object" || standard === null) return false;
  return (standard as Record<string, unknown>)["vendor"] === vendor;
}

export function zodAdapter(): SchemaAdapter & { init(): Promise<void> } {
  let TypeBoxFromZod: ((schema: unknown) => TSchema) | null = null;
  let loaded = false;

  return {
    async init(): Promise<void> {
      if (loaded) return;
      try {
        const typemap = await import("@alkdev/typemap");
        TypeBoxFromZod = typemap.TypeBoxFromZod as ((schema: unknown) => TSchema);
        loaded = true;
        logger.info("zodAdapter: loaded @alkdev/typemap");
      } catch {
        throw new Error(
          "zodAdapter requires @alkdev/typemap as a peer dependency. " +
          "Install it with: npm install @alkdev/typemap"
        );
      }
    },
    toTypeBox(schema: unknown): TSchema {
      if (KindGuard.IsSchema(schema)) {
        return schema as TSchema;
      }
      if (isStandardSchemaFrom(schema, "zod") && TypeBoxFromZod) {
        return TypeBoxFromZod(schema);
      }
      if (TypeBoxFromZod && !isStandardSchemaFrom(schema, "zod") && !isStandardSchemaFrom(schema, "valibot")) {
        throw new Error(
          `zodAdapter: schema is not a Zod or TypeBox schema (received ${typeof schema})`
        );
      }
      if (TypeBoxFromZod) {
        throw new Error(
          `zodAdapter: schema uses a different schema library than Zod. Use the appropriate adapter.`
        );
      }
      throw new Error(
        "zodAdapter: not initialized. Call await adapter.init() before using toTypeBox()."
      );
    },
  };
}

export function valibotAdapter(): SchemaAdapter & { init(): Promise<void> } {
  let TypeBoxFromValibot: ((schema: unknown) => TSchema) | null = null;
  let loaded = false;

  return {
    async init(): Promise<void> {
      if (loaded) return;
      try {
        const typemap = await import("@alkdev/typemap");
        TypeBoxFromValibot = typemap.TypeBoxFromValibot as ((schema: unknown) => TSchema);
        loaded = true;
        logger.info("valibotAdapter: loaded @alkdev/typemap");
      } catch {
        throw new Error(
          "valibotAdapter requires @alkdev/typemap as a peer dependency. " +
          "Install it with: npm install @alkdev/typemap"
        );
      }
    },
    toTypeBox(schema: unknown): TSchema {
      if (KindGuard.IsSchema(schema)) {
        return schema as TSchema;
      }
      if (isStandardSchemaFrom(schema, "valibot") && TypeBoxFromValibot) {
        return TypeBoxFromValibot(schema);
      }
      if (TypeBoxFromValibot && !isStandardSchemaFrom(schema, "valibot") && !isStandardSchemaFrom(schema, "zod")) {
        throw new Error(
          `valibotAdapter: schema is not a Valibot or TypeBox schema (received ${typeof schema})`
        );
      }
      if (TypeBoxFromValibot) {
        throw new Error(
          `valibotAdapter: schema uses a different schema library than Valibot. Use the appropriate adapter.`
        );
      }
      throw new Error(
        "valibotAdapter: not initialized. Call await adapter.init() before using toTypeBox()."
      );
    },
  };
}