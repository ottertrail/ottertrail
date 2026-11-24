import type { FastifyError, FastifySchemaValidationError } from "fastify";

/** Which part of the request failed: body, querystring, params, or headers. */
type SchemaErrorDataVar = NonNullable<FastifyError["validationContext"]>;

/**
 * The message of a request that fails its route's schema, as a sentence a person can read: "The
 * password must have at least 12 characters." rather than the validator's "body/password must NOT
 * have fewer than 12 characters". The answer keeps Fastify's code, FST_ERR_VALIDATION, and status
 * 400. It names the first error only, as the validator reports one at a time. Each sentence reads
 * right whether the field's name is singular or plural ("must", "can", "Add").
 */
export function validationMessage(
  errors: FastifySchemaValidationError[],
  dataVar: SchemaErrorDataVar,
): string {
  const error = errors[0];
  if (error === undefined) return `The ${PARTS[dataVar]} could not be accepted.`;
  const params = error.params;
  const path = error.instancePath.split("/").filter((segment) => segment !== "");
  if (error.keyword === "required" && typeof params.missingProperty === "string") {
    return `Add ${lower(subject([...path, params.missingProperty], dataVar))}.`;
  }
  if (error.keyword === "additionalProperties" && typeof params.additionalProperty === "string") {
    const where = path.length === 0 ? `the ${PARTS[dataVar]}` : lower(subject(path, dataVar));
    return `Unknown field in ${where}: ${params.additionalProperty}.`;
  }
  return `${subject(path, dataVar)} ${problem(error)}`;
}

const PARTS: Record<SchemaErrorDataVar, string> = {
  body: "request body",
  querystring: "query string",
  params: "path",
  headers: "headers",
};

/** "The password", "The name in events/2", or "The request body". */
function subject(path: string[], dataVar: SchemaErrorDataVar): string {
  const last = path.at(-1);
  if (last === undefined) return `The ${PARTS[dataVar]}`;
  if (/^\d+$/.test(last)) return `Item ${last} of ${path.slice(0, -1).join("/") || PARTS[dataVar]}`;
  const parents = path.slice(0, -1);
  return `The ${words(last)}${parents.length === 0 ? "" : ` in ${parents.join("/")}`}`;
}

/** confirmPassword → "confirm password", project_id → "project ID". */
function words(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .replace(/\b(id|url|ip|uri)\b/g, (word) => word.toUpperCase());
}

/** "The time zone" → "the time zone"; "Item 2 of steps" → "item 2 of steps". */
const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

const plural = (count: unknown, one: string) => `${String(count)} ${one}${count === 1 ? "" : "s"}`;

function problem({ keyword, params }: FastifySchemaValidationError): string {
  switch (keyword) {
    case "minLength":
      return params.limit === 1
        ? "must not be empty."
        : `must have at least ${plural(params.limit, "character")}.`;
    case "maxLength":
      return `can have at most ${plural(params.limit, "character")}.`;
    case "pattern":
      // "\S", the schemas' rule for a name, refuses only a blank value.
      return params.pattern === "\\S" ? "must not be blank." : "must match the expected form.";
    case "format":
      return `must be a valid ${String(params.format)}.`;
    case "type":
      return `must be ${article(String(params.type))} ${String(params.type)}.`;
    case "enum":
      // A short list is named; a long one, such as every country code, is not.
      return Array.isArray(params.allowedValues) && params.allowedValues.length <= 10
        ? `must be one of: ${params.allowedValues.map((value) => JSON.stringify(value)).join(", ")}.`
        : "must be one of the allowed values.";
    case "const":
      return `must be ${JSON.stringify(params.allowedValue)}.`;
    case "minimum":
      return `must be at least ${String(params.limit)}.`;
    case "maximum":
      return `must be at most ${String(params.limit)}.`;
    case "exclusiveMinimum":
      return `must be more than ${String(params.limit)}.`;
    case "exclusiveMaximum":
      return `must be less than ${String(params.limit)}.`;
    case "minItems":
      return `must have at least ${plural(params.limit, "item")}.`;
    case "maxItems":
      return `can have at most ${plural(params.limit, "item")}.`;
    case "uniqueItems":
      return "must not repeat an item.";
    case "minProperties":
      return `must have at least ${plural(params.limit, "field")}.`;
    case "maxProperties":
      return `can have at most ${plural(params.limit, "field")}.`;
    default:
      return "could not be accepted.";
  }
}

const article = (type: string) => (/^[aeiou]/.test(type) ? "an" : "a");
