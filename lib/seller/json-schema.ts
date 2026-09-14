export type JsonSchema = Record<string, unknown>;

export type JsonSchemaValidationResult =
  | { ok: true }
  | {
      ok: false;
      path: string;
      message: string;
      /**
       * The schema is beyond what Veyra can enforce, rather than the value
       * being wrong. The distinction decides who is at fault, and it cost real
       * money to learn: a paid Exa response was reported as failing its
       * published output schema because that schema used `oneOf`, which this
       * file did not implement. Veyra took $0.0070, the endpoint delivered,
       * and the screen blamed the endpoint for a gap on our side.
       */
      unsupported?: true;
    };

const SUPPORTED_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);

const COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;

/**
 * Keywords that describe and constrain nothing.
 *
 * Publishers carry OpenAPI habits into their JSON Schema -- `example` in the
 * singular, `$schema`, `readOnly` -- and none of them narrows the set of
 * allowed values. Refusing them made Veyra unable to check schemas it
 * understood perfectly well apart from a comment, so they are accepted and
 * ignored. Real constraints Veyra does not implement stay unsupported, because
 * ignoring one of those would mean passing a value nobody checked.
 */
const ANNOTATION_KEYWORDS = [
  "example", "$schema", "$id", "$comment", "deprecated", "readOnly", "writeOnly",
  /* `format` is annotation-only by default in JSON Schema itself: a validator
     may assert it, and is not required to. Accepting it without asserting is
     what the specification describes, not a shortcut around it. */
  "format",
  /* OpenAPI's hint for which branch of a union a value belongs to. It narrows
     nothing the union does not already say, so ignoring it cannot let a wrong
     value through. */
  "discriminator",
] as const;

const SUPPORTED_KEYWORDS = new Set([
  "type",
  "allOf",
  "anyOf",
  "oneOf",
  "nullable",
  ...ANNOTATION_KEYWORDS,
  "title",
  "description",
  "default",
  "examples",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
]);

function fail(path: string, message: string): JsonSchemaValidationResult {
  return { ok: false, path, message };
}

/** A schema Veyra cannot enforce. Never the same as a value that broke one. */
function beyondUs(path: string, message: string): JsonSchemaValidationResult {
  return { ok: false, path, message, unsupported: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateSchemaNode(schema: unknown, path: string, depth: number): JsonSchemaValidationResult {
  if (!isRecord(schema)) return fail(path, "schema must be a JSON object");
  if (depth > 12) return fail(path, "schema nesting exceeds 12 levels");

  /* The empty schema means "any value", and it is how publishers spell an open
     map -- Exa's `additionalProperties: {}`. Only ever as a subschema: a seller
     publishing nothing at all as their whole contract is a different thing. */
  if (Object.keys(schema).length === 0) {
    return depth > 0 ? { ok: true } : fail(path, "a schema is required");
  }

  const unsupported = Object.keys(schema).find((key) => !SUPPORTED_KEYWORDS.has(key));
  if (unsupported) return beyondUs(`${path}.${unsupported}`, "keyword is not supported");

  const composed = COMPOSITION_KEYWORDS.filter((keyword) => schema[keyword] !== undefined);
  for (const keyword of composed) {
    const branches = schema[keyword];
    if (!Array.isArray(branches) || branches.length === 0 || branches.length > 20) {
      return fail(`${path}.${keyword}`, `${keyword} must be an array of 1-20 schemas`);
    }
    for (let index = 0; index < branches.length; index += 1) {
      const result = validateSchemaNode(branches[index], `${path}.${keyword}[${index}]`, depth + 1);
      if (!result.ok) return result;
    }
  }

  const type = schema.type;
  /* A node that only composes carries no type of its own; its branches do. */
  if (type !== undefined || composed.length === 0) {
    /* `type` may be a union -- Exa publishes `["number", "null"]` for a score
       that is sometimes absent. It is ordinary JSON Schema, and reading only
       the string form made the whole document unenforceable over one field. */
    const declared = Array.isArray(type) ? type : [type];
    if (declared.length === 0 || !declared.every((each) => typeof each === "string" && SUPPORTED_TYPES.has(each))) {
      return beyondUs(`${path}.type`, "a supported JSON Schema type is required");
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 100)) {
    return fail(`${path}.enum`, "enum must contain 1-100 JSON values");
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))) {
    return fail(`${path}.required`, "required must be an array of property names");
  }
  if (Array.isArray(schema.required) && new Set(schema.required).size !== schema.required.length) {
    return fail(`${path}.required`, "required property names must be unique");
  }
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)) return fail(`${path}.properties`, "properties must be an object");
    if (Object.keys(schema.properties).length > 100) return fail(`${path}.properties`, "at most 100 properties are supported");
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!key || key.length > 100) return fail(`${path}.properties`, "property names must contain 1-100 characters");
      const result = validateSchemaNode(child, `${path}.properties.${key}`, depth + 1);
      if (!result.ok) return result;
    }
  }
  if (schema.items !== undefined) {
    const result = validateSchemaNode(schema.items, `${path}.items`, depth + 1);
    if (!result.ok) return result;
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    if (!isRecord(schema.additionalProperties)) {
      return beyondUs(`${path}.additionalProperties`, "additionalProperties must be a boolean or a schema");
    }
    const result = validateSchemaNode(schema.additionalProperties, `${path}.additionalProperties`, depth + 1);
    if (!result.ok) return result;
  }
  for (const keyword of ["minimum", "maximum"] as const) {
    if (schema[keyword] !== undefined && (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword]))) {
      return fail(`${path}.${keyword}`, `${keyword} must be a finite number`);
    }
  }
  for (const keyword of ["minLength", "maxLength", "minItems", "maxItems"] as const) {
    if (schema[keyword] !== undefined && (!Number.isInteger(schema[keyword]) || Number(schema[keyword]) < 0)) {
      return fail(`${path}.${keyword}`, `${keyword} must be a non-negative integer`);
    }
  }
  if (typeof schema.minLength === "number" && typeof schema.maxLength === "number" && schema.minLength > schema.maxLength) {
    return fail(path, "minLength cannot exceed maxLength");
  }
  if (typeof schema.minItems === "number" && typeof schema.maxItems === "number" && schema.minItems > schema.maxItems) {
    return fail(path, "minItems cannot exceed maxItems");
  }
  if (typeof schema.minimum === "number" && typeof schema.maximum === "number" && schema.minimum > schema.maximum) {
    return fail(path, "minimum cannot exceed maximum");
  }
  return { ok: true };
}

export function validateSupportedJsonSchema(schema: unknown): JsonSchemaValidationResult {
  return validateSchemaNode(schema, "$schema", 0);
}

function matchesType(value: unknown, type: string) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function validateValueNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  depth: number,
): JsonSchemaValidationResult {
  if (depth > 20) return fail(path, "value nesting exceeds 20 levels");

  /* Composition first, because a node may carry nothing else. `allOf` has to
     hold entirely; `anyOf` needs one branch.

     `oneOf` is read as "at least one" rather than the spec's "exactly one", and
     that is deliberate. This validator runs after the money has moved, so the
     cost of the two mistakes is not symmetric: reading overlapping branches as
     a match passes a response that does match a shape the seller published,
     while strictness fails a delivered answer -- and somebody has already paid
     for it -- over how its publisher drafted their schema. */
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const result = validateValueNode(value, branch as JsonSchema, path, depth + 1);
      if (!result.ok) return result;
    }
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const branches = schema[keyword];
    if (!Array.isArray(branches)) continue;
    const matched = branches.some((branch) => validateValueNode(value, branch as JsonSchema, path, depth + 1).ok);
    if (!matched) return fail(path, `value matches none of the ${keyword} branches`);
  }

  const declared = schema.type;
  if (declared === undefined) return { ok: true };
  /* OpenAPI 3.0 spells "or null" as a sibling flag rather than a union type.
     Reading it as an annotation would fail a null the publisher allowed. */
  if (schema.nullable === true && value === null) return { ok: true };
  const types = (Array.isArray(declared) ? declared : [declared]) as string[];
  if (!types.some((each) => matchesType(value, each))) {
    return fail(path, `expected ${types.join(" or ")}`);
  }
  const type = types.find((each) => matchesType(value, each)) as string;
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => jsonEqual(candidate, value))) {
    return fail(path, "value is not in the allowed enum");
  }
  if (schema.const !== undefined && !jsonEqual(schema.const, value)) {
    return fail(path, "value does not match const");
  }

  if (type === "object") {
    const record = value as Record<string, unknown>;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) {
        return fail(`${path}.${key}`, "required property is missing");
      }
    }
    if (schema.additionalProperties === false) {
      const unknownKey = Object.keys(record).find((key) => !(key in properties));
      if (unknownKey) return fail(`${path}.${unknownKey}`, "additional property is not allowed");
    }
    if (isRecord(schema.additionalProperties)) {
      for (const [key, child] of Object.entries(record)) {
        if (key in properties) continue;
        const result = validateValueNode(child, schema.additionalProperties, `${path}.${key}`, depth + 1);
        if (!result.ok) return result;
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      const result = validateValueNode(record[key], childSchema as JsonSchema, `${path}.${key}`, depth + 1);
      if (!result.ok) return result;
    }
  }

  if (type === "array") {
    const list = value as unknown[];
    if (typeof schema.minItems === "number" && list.length < schema.minItems) return fail(path, "array is too short");
    if (typeof schema.maxItems === "number" && list.length > schema.maxItems) return fail(path, "array is too long");
    if (isRecord(schema.items)) {
      for (let index = 0; index < list.length; index += 1) {
        const result = validateValueNode(list[index], schema.items, `${path}[${index}]`, depth + 1);
        if (!result.ok) return result;
      }
    }
  }

  if (type === "string") {
    const text = value as string;
    if (typeof schema.minLength === "number" && text.length < schema.minLength) return fail(path, "string is too short");
    if (typeof schema.maxLength === "number" && text.length > schema.maxLength) return fail(path, "string is too long");
  }

  if (type === "number" || type === "integer") {
    const number = value as number;
    if (typeof schema.minimum === "number" && number < schema.minimum) return fail(path, "number is below minimum");
    if (typeof schema.maximum === "number" && number > schema.maximum) return fail(path, "number is above maximum");
  }

  return { ok: true };
}

export function validateJsonSchemaValue(
  value: unknown,
  schema: JsonSchema,
): JsonSchemaValidationResult {
  const schemaResult = validateSupportedJsonSchema(schema);
  if (!schemaResult.ok) return schemaResult;
  return validateValueNode(value, schema, "$", 0);
}
