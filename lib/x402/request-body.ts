/**
 * Copyright 2026 Veyra
 * SPDX-License-Identifier: Apache-2.0
 */

import { validateJsonSchemaValue, type JsonSchema } from "../seller/json-schema.ts";

/**
 * What Veyra sends to a paid endpoint, and how much of it is actually known.
 *
 * A live purchase failed with HTTP 400 because Veyra posted `{"query": "..."}`
 * to an endpoint that wanted a different field, and it had no way to know: the
 * catalog entry publishes no input schema at all. Its own probe recorded that
 * (`declares_input_schema: false`) and the purchase went ahead anyway, so a
 * signature was spent on a request nobody could have validated.
 *
 * The rule now is simple: a guessed body is labelled as a guess before the
 * wallet opens, and where the provider does publish a schema, the body is built
 * from it and checked against it rather than hoped at.
 */

/** Field names that carry a free-text query, most conventional first. */
const QUERY_FIELDS = [
  "q", "query", "search", "searchQuery", "text", "prompt", "input",
  "question", "term", "keywords", "url",
];

export type RequestBodyPlan = {
  body: Record<string, unknown>;
  /** True when no published schema justified the shape. */
  guessed: boolean;
  /** The field the intent was placed in, when one was identified. */
  intentField: string | null;
  /** Human note for the screen, when there is something the reader must know. */
  note: string | null;
};

function schemaProperties(schema: JsonSchema | null | undefined) {
  if (!schema || typeof schema !== "object") return null;
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return null;
  return properties as Record<string, JsonSchema>;
}

function requiredFields(schema: JsonSchema | null | undefined): string[] {
  const required = (schema as { required?: unknown } | null)?.required;
  return Array.isArray(required) ? required.filter((item): item is string => typeof item === "string") : [];
}

/** A default the schema itself supplies, never one Veyra invented. */
function declaredDefault(property: JsonSchema): unknown {
  if (property && typeof property === "object" && "default" in property) {
    return (property as { default: unknown }).default;
  }
  return undefined;
}

export function buildRequestBody(input: {
  intent: string;
  capability: string;
  inputSchema?: JsonSchema | null;
}): RequestBodyPlan {
  const text = input.intent.trim() || input.capability.replace(/_/g, " ");
  const properties = schemaProperties(input.inputSchema);

  if (!properties) {
    return {
      body: { query: text },
      guessed: true,
      intentField: "query",
      note: "This provider publishes no input schema, so the request shape below is Veyra's best guess. Check it against the provider's documentation before paying — a rejected request can still cost the call.",
    };
  }

  const names = Object.keys(properties);
  const required = requiredFields(input.inputSchema);

  // The published schema decides the field name, in its own vocabulary.
  const intentField = QUERY_FIELDS.find((candidate) =>
    names.some((name) => name.toLowerCase() === candidate.toLowerCase()))
    ?? required.find((name) => {
      const type = (properties[name] as { type?: unknown } | undefined)?.type;
      return type === "string";
    })
    ?? null;

  const body: Record<string, unknown> = {};
  for (const name of required) {
    const declared = declaredDefault(properties[name]);
    if (declared !== undefined) body[name] = declared;
  }
  if (intentField) {
    const actual = names.find((name) => name.toLowerCase() === intentField.toLowerCase()) ?? intentField;
    body[actual] = text;
  }

  const missing = required.filter((name) => !(name in body));
  /* A schema with no field a question fits in. It is not the same as a missing
     required field -- Alchemy's token-price call declares `addresses` and no
     required list at all, so `{}` satisfies it and every check downstream
     passed on a body carrying nothing anyone asked. The schema is weak, not
     wrong; what is wrong is treating "valid" as "asked". */
  const nowhereToAsk = intentField === null;
  return {
    body,
    guessed: false,
    intentField,
    note: missing.length > 0
      ? `The provider requires ${missing.join(", ")}, which nothing in this request supplies. Fill them in before paying.`
      : nowhereToAsk
        ? `The provider's schema has no field for a question — it takes ${names.slice(0, 4).join(", ")}. This request carries nothing you asked, so paying buys an answer to no question.`
        : null,
  };
}

export type RequestBodyCheck =
  | { ok: true; checked: boolean }
  | { ok: false; checked: true; path: string; message: string };

/**
 * Refuses to spend on a request the provider's own schema calls invalid.
 *
 * Only possible where a schema exists; where none does, the answer is honestly
 * "not checked" rather than "fine".
 */
export function checkRequestBody(
  body: unknown,
  inputSchema?: JsonSchema | null,
): RequestBodyCheck {
  if (!inputSchema || !schemaProperties(inputSchema)) return { ok: true, checked: false };
  const result = validateJsonSchemaValue(body, inputSchema);
  if (result.ok) return { ok: true, checked: true };
  return { ok: false, checked: true, path: result.path, message: result.message };
}
