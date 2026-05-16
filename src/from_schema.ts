import * as Type from "@alkdev/typebox";
import { getLogger } from "@logtape/logtape";

const logger = getLogger("operations:from_schema");

const IsExact = (value: unknown, expect: unknown) => value === expect;
const IsSValue = (value: unknown): value is SValue =>
  Type.ValueGuard.IsString(value) || Type.ValueGuard.IsNumber(value) || Type.ValueGuard.IsBoolean(value);
const IsSEnum = (value: unknown): value is SEnum =>
  Type.ValueGuard.IsObject(value) && Type.ValueGuard.IsArray(value.enum) && value.enum.every((v) => IsSValue(v));
const IsSAllOf = (value: unknown): value is SAllOf => Type.ValueGuard.IsObject(value) && Type.ValueGuard.IsArray(value.allOf);
const IsSAnyOf = (value: unknown): value is SAnyOf => Type.ValueGuard.IsObject(value) && Type.ValueGuard.IsArray(value.anyOf);
const IsSOneOf = (value: unknown): value is SOneOf => Type.ValueGuard.IsObject(value) && Type.ValueGuard.IsArray(value.oneOf);
const IsSTuple = (value: unknown): value is STuple =>
  Type.ValueGuard.IsObject(value) && IsExact(value.type, "array") && Type.ValueGuard.IsArray(value.items);
const IsSArray = (value: unknown): value is SArray =>
  Type.ValueGuard.IsObject(value) && IsExact(value.type, "array") && !Type.ValueGuard.IsArray(value.items) && Type.ValueGuard.IsObject(value.items);
const IsSConst = (value: unknown): value is SConst => Type.ValueGuard.IsObject(value) && Type.ValueGuard.IsObject(value["const"]);
const IsSString = (value: unknown): value is SString => Type.ValueGuard.IsObject(value) && IsExact(value.type, "string");
const IsSRef = (value: unknown): value is SRef => Type.ValueGuard.IsObject(value) && Type.ValueGuard.IsString(value.$ref);
const IsSNumber = (value: unknown): value is SNumber => Type.ValueGuard.IsObject(value) && IsExact(value.type, "number");
const IsSInteger = (value: unknown): value is SInteger => Type.ValueGuard.IsObject(value) && IsExact(value.type, "integer");
const IsSBoolean = (value: unknown): value is SBoolean => Type.ValueGuard.IsObject(value) && IsExact(value.type, "boolean");
const IsSNull = (value: unknown): value is SNull => Type.ValueGuard.IsObject(value) && IsExact(value.type, "null");
const IsSProperties = (value: unknown): value is SProperties => Type.ValueGuard.IsObject(value);
const IsSObject = (value: unknown): value is SObject =>
  Type.ValueGuard.IsObject(value) &&
  IsExact(value.type, "object") &&
  IsSProperties(value.properties) &&
  (value.required === undefined || (Type.ValueGuard.IsArray(value.required) && value.required.every((v: unknown) => Type.ValueGuard.IsString(v))));

type SValue = string | number | boolean;
type SEnum = Readonly<{ enum: readonly SValue[] }>;
type SAllOf = Readonly<{ allOf: readonly unknown[] }>;
type SAnyOf = Readonly<{ anyOf: readonly unknown[] }>;
type SOneOf = Readonly<{ oneOf: readonly unknown[] }>;
type SProperties = Record<PropertyKey, unknown>;
type SObject = Readonly<{ type: "object"; properties: SProperties; required?: readonly string[] }>;
type STuple = Readonly<{ type: "array"; items: readonly unknown[] }>;
type SArray = Readonly<{ type: "array"; items: unknown }>;
type SConst = Readonly<{ const: SValue }>;
type SRef = Readonly<{ $ref: string }>;
type SString = Readonly<{ type: "string" }>;
type SNumber = Readonly<{ type: "number" }>;
type SInteger = Readonly<{ type: "integer" }>;
type SBoolean = Readonly<{ type: "boolean" }>;
type SNull = Readonly<{ type: "null" }>;

function FromRest<T extends readonly unknown[]>(T: T): Type.TSchema[] {
  return T.map((L) => FromSchema(L)) as never;
}

function FromEnumRest<T extends readonly SValue[]>(T: T): Type.TSchema[] {
  return T.map((L) => Type.Literal(L)) as never;
}

function FromAllOf<T extends SAllOf>(T: T): Type.TSchema {
  return Type.IntersectEvaluated(FromRest(T.allOf), T);
}

function FromAnyOf<T extends SAnyOf>(T: T): Type.TSchema {
  return Type.UnionEvaluated(FromRest(T.anyOf), T);
}

function FromOneOf<T extends SOneOf>(T: T): Type.TSchema {
  return Type.UnionEvaluated(FromRest(T.oneOf), T);
}

function FromEnum<T extends SEnum>(T: T): Type.TSchema {
  return Type.UnionEvaluated(FromEnumRest(T.enum));
}

function FromTuple<T extends STuple>(T: T): Type.TSchema {
  return Type.Tuple(FromRest(T.items), T) as never;
}

function FromArray<T extends SArray>(T: T): Type.TSchema {
  return Type.Array(FromSchema(T.items), T) as never;
}

function FromConst<T extends SConst>(T: T): Type.TSchema {
  return Type.Literal(T.const, T);
}

function FromRef<T extends SRef>(T: T): Type.TSchema {
  return Type.Ref(T.$ref);
}

function FromObject<T extends SObject>(T: T): Type.TSchema {
  const properties = globalThis.Object.getOwnPropertyNames(T.properties).reduce(
    (Acc, K) => {
      return {
        ...Acc,
        [K]: T.required && T.required.includes(K) ? FromSchema(T.properties[K]) : Type.Optional(FromSchema(T.properties[K])),
      };
    },
    {} as Type.TProperties,
  );
  return Type.Object(properties, T) as never;
}

export function FromSchema<T>(T: T): Type.TSchema {
  if (IsSAllOf(T)) return FromAllOf(T);
  if (IsSAnyOf(T)) return FromAnyOf(T);
  if (IsSOneOf(T)) return FromOneOf(T);
  if (IsSEnum(T)) return FromEnum(T);
  if (IsSObject(T)) return FromObject(T);
  if (IsSTuple(T)) return FromTuple(T);
  if (IsSArray(T)) return FromArray(T);
  if (IsSConst(T)) return FromConst(T);
  if (IsSRef(T)) return FromRef(T);
  if (IsSString(T)) return Type.String(T);
  if (IsSNumber(T)) return Type.Number(T);
  if (IsSInteger(T)) return Type.Integer(T);
  if (IsSBoolean(T)) return Type.Boolean(T);
  if (IsSNull(T)) return Type.Null(T);
  logger.warn(`Falling back to Type.Unknown for unrecognized schema: ${JSON.stringify(T)}`);
  return Type.Unknown(T || {});
}