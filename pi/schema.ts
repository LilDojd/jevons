import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Request } from "../src/contracts.ts";

const text = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
const id = Type.String({ minLength: 1, maxLength: 80, pattern: "\\S" });
export const questionsSchema = Type.Record(
  Type.String(),
  Type.Union([
    Type.Object(
      {
        type: Type.Literal("noul"),
        instructions: text,
        criteria: Type.Optional(
          Type.Object(
            { true: text, false: text },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal("choice"),
        instructions: text,
        criteria: Type.Record(Type.String(), text, {
          propertyNames: id,
          minProperties: 2,
          maxProperties: 32,
        }),
      },
      { additionalProperties: false },
    ),
    Type.Object(
      {
        type: Type.Literal("score"),
        instructions: text,
        criteria: Type.Array(text, { minItems: 2, maxItems: 16 }),
      },
      { additionalProperties: false },
    ),
  ]),
  { propertyNames: id, minProperties: 1, maxProperties: 32 },
);
export const requestSchema = Type.Object(
  {
    state: Type.Union([
      Type.String(),
      Type.Null(),
      Type.Array(Type.Unknown()),
      Type.Record(Type.String(), Type.Unknown()),
    ]),
    questions: questionsSchema,
  },
  { additionalProperties: false },
);

export function parseRequest(value: unknown): Request {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 20000 || depth > 24)
      throw new Error("Jev context is too deeply nested or large.");
    if (typeof item === "string") {
      bytes += Buffer.byteLength(item);
      if (bytes > 48000)
        throw new Error(
          "Jev request exceeds 48,000 bytes; narrow the context.",
        );
      return;
    }
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item))
      throw new Error("Jev context must be finite JSON.");
    if (
      ![Object.prototype, Array.prototype, null].includes(
        Object.getPrototypeOf(item),
      )
    )
      throw new Error("Jev context must be plain JSON.");
    ancestors.add(item);
    if (Array.isArray(item) && Object.keys(item).length !== item.length)
      throw new Error("Jev context cannot contain sparse arrays.");
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === "length") continue;
      if (
        Array.isArray(item) &&
        (typeof key !== "string" ||
          !/^(0|[1-9][0-9]*)$/.test(key) ||
          Number(key) >= item.length)
      )
        throw new Error("Jev context must be plain JSON.");
      const property = Object.getOwnPropertyDescriptor(item, key)!;
      if (
        typeof key !== "string" ||
        !property.enumerable ||
        !("value" in property)
      )
        throw new Error("Jev context must be plain JSON.");
      visit(property.value, depth + 1);
    }
    ancestors.delete(item);
  };
  visit(value, 0);
  if (!Value.Check(requestSchema, value))
    throw new Error(
      "Expected state and 1–32 valid Noul, Choice or Score questions.",
    );
  const stateBytes = Buffer.byteLength(JSON.stringify(value.state));
  const longestQuestionBytes = Math.max(
    ...Object.values(value.questions).map((question) =>
      Buffer.byteLength(JSON.stringify(question)),
    ),
  );
  if (stateBytes + longestQuestionBytes > 24000)
    throw new Error(
      "State plus the longest question exceeds the conservative 24,000-byte context limit; narrow the state.",
    );
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > 48000)
    throw new Error("Jev request exceeds 48,000 bytes; narrow the context.");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,})/.test(
      serialized,
    )
  )
    throw new Error("Possible credential in Jev context.");
  return JSON.parse(serialized) as Request;
}
