import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Policy } from "../src/contracts.ts";

export const defaultPolicy: Policy = {
  model: "jev-1.13.0",
  budget: { sessionTokens: 1000000, dayTokens: 5000000, requestTokens: 65536 },
  autopilot: { skills: true, models: "suggest", tools: true, threshold: 0.8 },
  profiles: [],
  review: {
    automatic: true,
    maxFiles: 12,
    maxBytes: 32000,
    concern: 0.8,
    clear: 0.2,
    rules: [
      {
        id: "correctness",
        label: "Correctness",
        instructions:
          "Does the supplied file contain a concrete logic defect visible in its implementation? Do not infer missing requirements or unseen caller behavior.",
      },
      {
        id: "maintainability",
        label: "Maintainability",
        instructions:
          "Does the supplied file contain unnecessary indirection, duplicated business logic, or speculative flexibility that makes its current behavior materially harder to change?",
      },
    ],
  },
  checks: [],
};
const text = Type.String({ minLength: 1, maxLength: 4000 });
const positive = Type.Integer({ minimum: 1, maximum: 1000000000 });
const model = Type.Object(
  { provider: text, model: text },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    model: text,
    budget: Type.Object(
      {
        sessionTokens: positive,
        dayTokens: positive,
        requestTokens: Type.Integer({ minimum: 4096, maximum: 65536 }),
      },
      { additionalProperties: false },
    ),
    autopilot: Type.Object(
      {
        skills: Type.Boolean(),
        models: Type.Union([
          Type.Literal("off"),
          Type.Literal("suggest"),
          Type.Literal("switch"),
        ]),
        tools: Type.Boolean(),
        threshold: Type.Number({ minimum: 0.5, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    profiles: Type.Array(
      Type.Object(
        { provider: text, model: text, description: text },
        { additionalProperties: false },
      ),
      { maxItems: 16 },
    ),
    writer: Type.Optional(model),
    review: Type.Object(
      {
        automatic: Type.Boolean(),
        maxFiles: Type.Integer({ minimum: 1, maximum: 40 }),
        maxBytes: Type.Integer({ minimum: 1024, maximum: 40000 }),
        concern: Type.Number({ minimum: 0.5, maximum: 1 }),
        clear: Type.Number({ minimum: 0, maximum: 0.5 }),
        rules: Type.Array(
          Type.Object(
            {
              id: Type.String({ pattern: "^[a-z][a-z0-9_]{0,31}$" }),
              label: text,
              instructions: text,
            },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 8 },
        ),
      },
      { additionalProperties: false },
    ),
    checks: Type.Array(
      Type.Object(
        {
          name: text,
          argv: Type.Array(text, { minItems: 1, maxItems: 32 }),
          timeoutMs: Type.Integer({ minimum: 100, maximum: 120000 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 8 },
    ),
  },
  { additionalProperties: false },
);

export async function loadPolicy(root: string): Promise<Policy> {
  let input: unknown;
  try {
    const path = join(root, "jevons.json");
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 32000)
      throw new Error("jevons.json must be a regular file under 32 KiB.");
    input = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return structuredClone(defaultPolicy);
    throw error;
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid jevons.json.");
  const raw = input as Partial<Policy>;
  const policy = {
    ...defaultPolicy,
    ...raw,
    budget: { ...defaultPolicy.budget, ...raw.budget },
    autopilot: { ...defaultPolicy.autopilot, ...raw.autopilot },
    review: { ...defaultPolicy.review, ...raw.review },
  };
  if (!Value.Check(schema, policy))
    throw new Error(
      "Invalid jevons.json; inspect the policy schema in pi/policy.ts.",
    );
  if (
    policy.review.clear >= policy.review.concern ||
    new Set(policy.review.rules.map((r) => r.id)).size !==
      policy.review.rules.length
  )
    throw new Error("Review thresholds or rule IDs are invalid.");
  return policy as Policy;
}
