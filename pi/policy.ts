import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Policy } from "../src/contracts.ts";

export const defaultPolicy: Policy = {
  model: "jev-1.13.0",
  autopilot: { skills: true, models: "suggest", tools: false, threshold: 0.8 },
  compaction: { automatic: true, contextPercent: 80, cooldownTurns: 5 },
  recovery: {
    mode: "shadow",
    retryConcern: 0.85,
    userConcern: 0.9,
    cooldownTurns: 3,
    maxInterventions: 2,
  },
  profiles: [],
  review: {
    automatic: true,
    investigate: false,
    investigateConcern: 0.9,
    concern: 0.8,
    clear: 0.2,
    rules: [
      {
        id: "correctness",
        label: "Correctness",
        instructions:
          "Does this change introduce a concrete logic defect visible in the supplied diff? Do not infer missing requirements or unseen caller behavior.",
      },
      {
        id: "maintainability",
        label: "Simplicity",
        instructions:
          "Does this change add unnecessary abstraction, speculative configuration, duplicated logic, or a custom reinvention of a suitable standard-library operation? Flag only complexity with a concrete simpler alternative supported by this diff; necessary safety boundaries and actual compatibility requirements are not bloat.",
      },
      {
        id: "tests",
        label: "Behavioral tests",
        instructions:
          "Do changed tests merely mirror source text, internal call order, incidental wording, or implementation layout instead of detecting a broken observable contract? Apply Google Testing Blog guidance: test behavior, not implementation; remove change-detector tests. Interaction assertions are valid when the interaction itself is the contract (such as no network before consent). Do not demand tests for unseen behavior or flag files without test changes.",
      },
      {
        id: "clarity",
        label: "Code and prose clarity",
        instructions:
          "Does the change introduce materially misleading names, unsupported documentation claims, redundant commentary that restates obvious code, or verbose generic prose hiding the actual contract? Prefer self-documenting code and concise explanations of rationale and safety constraints. Flag concrete confusion, not personal style, comment counts, or presumed AI authorship.",
      },
    ],
  },
  verification: { select: true, relevance: 0.6 },
  checks: [],
};
const text = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
const model = Type.Object(
  { provider: text, model: text },
  { additionalProperties: false },
);
const schema = Type.Object(
  {
    model: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$" }),
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
    compaction: Type.Object(
      {
        automatic: Type.Boolean(),
        contextPercent: Type.Integer({ minimum: 1, maximum: 100 }),
        cooldownTurns: Type.Integer({ minimum: 1, maximum: 100 }),
      },
      { additionalProperties: false },
    ),
    recovery: Type.Object(
      {
        mode: Type.Union([
          Type.Literal("off"),
          Type.Literal("shadow"),
          Type.Literal("steer"),
        ]),
        retryConcern: Type.Number({ minimum: 0.5, maximum: 1 }),
        userConcern: Type.Number({ minimum: 0.5, maximum: 1 }),
        cooldownTurns: Type.Integer({ minimum: 1, maximum: 100 }),
        maxInterventions: Type.Integer({ minimum: 1, maximum: 5 }),
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
        investigate: Type.Boolean(),
        investigateConcern: Type.Number({ minimum: 0.5, maximum: 1 }),
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
    verification: Type.Object(
      {
        select: Type.Boolean(),
        relevance: Type.Number({ minimum: 0.5, maximum: 1 }),
      },
      { additionalProperties: false },
    ),
    checks: Type.Array(
      Type.Object(
        {
          name: text,
          description: Type.Optional(text),
          mandatory: Type.Optional(Type.Boolean()),
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
  return parsePolicy(input);
}

export function parsePolicy(input: unknown): Policy {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 32000)
    throw new Error("Jevons settings exceed 32 KiB.");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid jevons.json.");
  if (Object.hasOwn(input, "budget"))
    throw new Error(
      "Token budgets were removed. Remove budget from jevons.json; /jevons usage shows reported tokens without spending limits.",
    );
  const raw = input as Partial<Policy>;
  for (const key of [
    "autopilot",
    "review",
    "recovery",
    "compaction",
    "verification",
  ] as const) {
    if (
      Object.hasOwn(raw, key) &&
      (!raw[key] || typeof raw[key] !== "object" || Array.isArray(raw[key]))
    )
      throw new Error(`Jevons ${key} settings must be an object.`);
  }
  const policy = {
    ...defaultPolicy,
    ...raw,
    autopilot: { ...defaultPolicy.autopilot, ...raw.autopilot },
    review: { ...defaultPolicy.review, ...raw.review },
    recovery: { ...defaultPolicy.recovery, ...raw.recovery },
    compaction: { ...defaultPolicy.compaction, ...raw.compaction },
    verification: { ...defaultPolicy.verification, ...raw.verification },
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
  if (Buffer.byteLength(JSON.stringify(policy)) > 32000)
    throw new Error("Expanded Jevons settings exceed 32 KiB.");
  return structuredClone(policy) as Policy;
}
