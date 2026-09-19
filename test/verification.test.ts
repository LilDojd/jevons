import assert from "node:assert/strict";
import { test } from "node:test";
import { runChecks } from "../src/checks.ts";
import type { CheckConfig, Evaluate, Evaluation, Request } from "../src/contracts.ts";
import { selectVerification } from "../src/verification.ts";

const context = {
	task: "Fix argument parsing",
	diff: "+rejectUnknownFlags(args)",
};
const check = (name: string, mandatory?: boolean): CheckConfig => ({
	name,
	argv: [process.execPath, "-e", "process.exit(0)"],
	timeoutMs: 5000,
	description: `Verify ${name}`,
	...(mandatory === undefined ? {} : { mandatory }),
});
const judgment = (values: Record<string, number>): Evaluation => ({
	model: "jev-fixture-1",
	answers: Object.fromEntries(
		Object.entries(values).map(([key, noul]) => [key, { type: "noul", noul }]),
	),
	usage: { input_tokens: 100, output_tokens: 10 },
	elapsedMs: 12,
});
const never: Evaluate = async () => {
	throw new Error("Must not evaluate");
};

test("mandatory defaults true; independent optional judgments retain probabilities and model", async () => {
	const checks = [
		check("legacy"),
		check("mandatory", true),
		check("parser", false),
		check("docs", false),
		check("uncertain", false),
	];
	const evaluation = judgment({ check2: 0.98, check3: 0.02, check4: 0.5 });
	let request: Request | undefined;
	const result = await selectVerification(checks, context, undefined, async (input) => {
		request = input;
		return evaluation;
	});
	assert.deepEqual(Object.keys(request!.questions), ["check2", "check3", "check4"]);
	assert.ok(Object.values(request!.questions).every((question) => question.type === "noul"));
	assert.deepEqual(
		result.selected.map((item) => item.name),
		["legacy", "mandatory", "parser", "uncertain"],
	);
	assert.deepEqual(
		result.selections.map((item) => item.reason),
		["mandatory", "mandatory", "relevant", "irrelevant", "uncertain-included"],
	);
	assert.deepEqual(
		result.selections.slice(2).map((item) => item.probability),
		[0.98, 0.02, 0.5],
	);
	assert.deepEqual(result.evaluations, [evaluation]);
	assert.equal(result.complete, true);
	assert.deepEqual(result.omitted, []);
	assert.deepEqual(checks[3], check("docs", false));
});

test("disabled selection and mandatory-only configurations never call the evaluator", async () => {
	for (const checks of [[check("mandatory")], [check("optional", false)]]) {
		const result = await selectVerification(checks, context, { select: false }, never);
		assert.deepEqual(result.selected, checks);
		assert.equal(result.complete, true);
	}
	const result = await selectVerification([check("mandatory")], context, undefined, never);
	assert.equal(result.complete, true);
});

test("missing descriptions and incomplete or oversized context retain all commands with omissions", async () => {
	const undescribed = check("undescribed", false);
	delete undescribed.description;
	const result = await selectVerification(
		[check("mandatory"), undescribed],
		context,
		undefined,
		never,
	);
	assert.equal(result.selections[1]!.reason, "missing-description");
	assert.equal(result.selected.length, 2);
	assert.equal(result.complete, false);
	for (const supplied of [
		{ ...context, omitted: ["binary file not supplied"] },
		{ task: "", diff: "" },
		{ ...context, task: "語".repeat(3000) },
		{ ...context, diff: "x".repeat(24001) },
	]) {
		const result = await selectVerification(
			[check("mandatory"), check("optional", false)],
			supplied,
			undefined,
			never,
		);
		assert.equal(result.selected.length, 2);
		assert.equal(result.complete, false);
		assert.ok(result.omitted.length);
	}
});

test("unavailable, missing, malformed and uncertain judgments cannot drop mandatory checks", async () => {
	const checks = [check("mandatory"), check("optional", false)];
	const evaluations: Evaluate[] = [
		async () => {
			throw new Error("secret error must not leak");
		},
		async () => judgment({}),
		async () => judgment({ check1: NaN }),
		async () => judgment({ check1: 1.1 }),
		async () => ({ ...judgment({ check1: 0 }), model: "" }),
		async () => ({
			...judgment({}),
			answers: {
				check1: {
					type: "score",
					score: 0,
					confidence: 1,
					probabilities: { "0": 1 },
				},
			},
		}),
	];
	for (const evaluate of evaluations) {
		const result = await selectVerification(checks, context, undefined, evaluate);
		assert.deepEqual(result.selected, checks);
		assert.equal(result.complete, false);
		assert.ok(!JSON.stringify(result).includes("secret error"));
	}
	for (const p of [0.4, 0.5, 0.599]) {
		const result = await selectVerification(checks, context, undefined, async () =>
			judgment({ check1: p }),
		);
		assert.deepEqual(result.selected, checks);
		assert.equal(result.selections[1]!.reason, "uncertain-included");
	}
});

test("invalid policy cannot skip checks and configurable thresholds are applied in code", async () => {
	const checks = [check("optional", false)];
	for (const relevance of [NaN, -1, 2]) {
		const result = await selectVerification(checks, context, { relevance }, never);
		assert.deepEqual(result.selected, checks);
		assert.equal(result.complete, false);
	}
	for (const [relevance, p, selected] of [
		[0.8, 0.1, false],
		[0.8, 0.3, true],
		[0.1, 0.5, true],
		[1, 0, true],
	] as const) {
		const result = await selectVerification(checks, context, { relevance }, async () =>
			judgment({ check0: p }),
		);
		assert.equal(result.selections[0]!.selected, selected);
	}
});

test("request and candidate limits retain explicit unassessed optional checks", async () => {
	const checks = Array.from({ length: 40 }, (_, i) => check(`check${i}`, false));
	let calls = 0;
	const result = await selectVerification(checks, context, undefined, async (request) => {
		calls++;
		assert.ok(Object.keys(request.questions).length <= 32);
		assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 48000);
		assert.ok(
			Buffer.byteLength(JSON.stringify(request.state)) +
				Math.max(
					...Object.values(request.questions).map((q) => Buffer.byteLength(JSON.stringify(q))),
				) <=
				24000,
		);
		return judgment(Object.fromEntries(Object.keys(request.questions).map((key) => [key, 0])));
	});
	assert.equal(calls, 1);
	assert.equal(result.selections.length, 40);
	assert.equal(result.complete, false);
	assert.equal(result.selected.length, result.omitted.length);
	const huge = { ...check("huge", false), description: "語".repeat(10000) };
	const oversized = await selectVerification([huge], context, undefined, never);
	assert.deepEqual(oversized.selected, [huge]);
	assert.equal(oversized.complete, false);
});

test("partial answers retain missing checks but expose assessment coverage", async () => {
	const result = await selectVerification(
		[check("missing", false), check("irrelevant", false)],
		context,
		undefined,
		async () => judgment({ check1: 0 }),
	);
	assert.deepEqual(
		result.selected.map((item) => item.name),
		["missing"],
	);
	assert.equal(result.complete, false);
	assert.equal(result.evaluations.length, 1);
});

test("inherited answers cannot exclude optional checks or count as assessment", async () => {
	const checks = [check("inherited", false), check("assessed", false)];
	const result = await selectVerification(checks, context, undefined, async () => ({
		...judgment({}),
		answers: Object.assign(Object.create({ check0: { type: "noul", noul: 0 } }), {
			check1: { type: "noul", noul: 0 },
		}) as Evaluation["answers"],
	}));
	assert.deepEqual(result.selected, [checks[0]]);
	assert.equal(result.selections[0]!.reason, "invalid-or-missing-answer");
	assert.equal(result.selections[0]!.probability, undefined);
	assert.equal(result.selections[1]!.reason, "irrelevant");
	assert.equal(result.complete, false);
	assert.equal(result.omitted.length, 1);
});

test("cancellation settles even when the evaluator ignores its signal", async () => {
	const checks = [check("mandatory"), check("optional", false)];
	const preCancelled = await selectVerification(
		checks,
		context,
		undefined,
		never,
		AbortSignal.abort(),
	);
	assert.deepEqual(preCancelled.selected, checks);
	assert.equal(preCancelled.complete, false);
	const controller = new AbortController();
	const result = await selectVerification(
		checks,
		context,
		undefined,
		async (_, signal) => {
			controller.abort();
			assert.equal(signal?.aborted, true);
			return new Promise(() => {});
		},
		controller.signal,
	);
	assert.deepEqual(result.selected, checks);
	assert.equal(result.complete, false);
	assert.equal(result.selections[1]!.reason, "selection-cancelled");
});

test("configured execution snapshot is isolated from caller mutation during evaluation", async () => {
	const checks = [check("mandatory"), check("optional", false)];
	const result = await selectVerification(checks, context, undefined, async () => {
		checks[0]!.argv[0] = "unexpected-command";
		checks[1]!.argv.push("injected");
		return judgment({ check1: 1 });
	});
	assert.deepEqual(result.selected, [check("mandatory"), check("optional", false)]);
});

test("mandatory failure does not prevent selected optional execution", async () => {
	const mandatory = {
		...check("mandatory"),
		argv: [process.execPath, "-e", "process.exit(7)"],
	};
	const optional = {
		...check("parser", false),
		argv: [process.execPath, "-e", "process.exit(3)"],
	};
	const selection = await selectVerification(
		[mandatory, optional, check("docs", false)],
		context,
		undefined,
		async () => judgment({ check1: 0.99, check2: 0.01 }),
	);
	const results = await runChecks(process.cwd(), selection.selected);
	assert.deepEqual(
		results.map((item) => [item.name, item.passed, item.exitCode, item.termination]),
		[
			["mandatory", false, 7, "exit"],
			["parser", false, 3, "exit"],
		],
	);
});
