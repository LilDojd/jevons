import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { Policy } from "../src/contracts.ts";

export const defaultPolicy: Policy = {
	model: "jev-1.13.0",
	autopilot: { skills: true, models: "suggest", tools: false, threshold: 0.8 },
	recovery: {
		mode: "shadow",
		retryConcern: 0.85,
		userConcern: 0.9,
		cooldownTurns: 3,
		maxInterventions: 2,
	},
	profiles: [],
	verification: { select: true, relevance: 0.6 },
	checks: [],
};
const text = Type.String({ minLength: 1, maxLength: 4000, pattern: "\\S" });
const model = Type.Object({ provider: text, model: text }, { additionalProperties: false });
const schema = Type.Object(
	{
		model: Type.String({ pattern: "^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$" }),
		autopilot: Type.Object(
			{
				skills: Type.Boolean(),
				models: Type.Union([Type.Literal("off"), Type.Literal("suggest"), Type.Literal("switch")]),
				tools: Type.Boolean(),
				threshold: Type.Number({ minimum: 0.5, maximum: 1 }),
			},
			{ additionalProperties: false },
		),
		recovery: Type.Object(
			{
				mode: Type.Union([Type.Literal("off"), Type.Literal("shadow"), Type.Literal("steer")]),
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
	return loadPolicySync(root);
}

export function loadPolicySync(root: string): Policy {
	const input = readSettingsFile(join(root, "jevons.json"));
	return parsePolicy(input === undefined ? {} : input);
}

export function readSettingsFile(path: string): unknown {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.size > 32000)
			throw new Error("jevons.json must be a regular file under 32 KiB.");
		const buffer = Buffer.alloc(32001);
		let size = 0;
		while (size < buffer.length) {
			const count = readSync(fd, buffer, size, buffer.length - size, null);
			if (!count) break;
			size += count;
		}
		if (size > 32000) throw new Error("Jevons settings exceed 32 KiB.");
		return JSON.parse(buffer.subarray(0, size).toString("utf8"));
	} finally {
		closeSync(fd);
	}
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
	for (const key of ["autopilot", "recovery", "verification"] as const) {
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
		recovery: { ...defaultPolicy.recovery, ...raw.recovery },
		verification: { ...defaultPolicy.verification, ...raw.verification },
	};
	if (!Value.Check(schema, policy))
		throw new Error("Invalid jevons.json; inspect the policy schema in pi/policy.ts.");
	if (Buffer.byteLength(JSON.stringify(policy)) > 32000)
		throw new Error("Expanded Jevons settings exceed 32 KiB.");
	return structuredClone(policy) as Policy;
}
