import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerAutopilot } from "../pi/autopilot.ts";
import { defaultPolicy } from "../pi/policy.ts";
import { Runtime } from "../pi/runtime.ts";
import { parseRequest } from "../pi/schema.ts";
import { assessTool, planTask } from "../src/autopilot.ts";
import type {
	Answer,
	Evaluate,
	Evaluation,
	ModelProfile,
	Policy,
	Request,
} from "../src/contracts.ts";

const policy: Policy["autopilot"] = {
	skills: true,
	models: "suggest",
	tools: true,
	threshold: 0.8,
};
const current = { provider: "local", model: "current" };
const profiles: ModelProfile[] = [
	{
		provider: "local",
		model: "alternative",
		description: "Useful for database query analysis.",
	},
];
const skill = (name: string, description = "Database query analysis") => ({
	name,
	description,
	path: `/skills/${name}/SKILL.md`,
});
const never: Evaluate = async () => {
	throw new Error("Unexpected evaluation.");
};

function result(answers: Evaluation["answers"]): Evaluation {
	return {
		model: "jev-test-version",
		answers,
		usage: { input_tokens: 42, output_tokens: 8 },
		elapsedMs: 3,
	};
}

function evaluator(
	answer: (id: string, question: Request["questions"][string]) => Answer,
): Evaluate {
	return async (request) =>
		result(
			Object.fromEntries(
				Object.entries(request.questions).map(([id, question]) => [id, answer(id, question)]),
			),
		);
}

const positive = evaluator((_id, question) =>
	question.type === "choice"
		? {
				type: "choice",
				choice: "model0",
				confidence: 0.9,
				probabilities: { keep: 0.1, model0: 0.9 },
			}
		: { type: "noul", noul: 0.9 },
);

test("planning skips disabled and absent candidates without evaluation", async () => {
	for (const [task, skills, models, settings] of [
		[
			"Database",
			[skill("database")],
			profiles,
			{ ...policy, skills: false, models: "off" as const },
		],
		["Database", [], [], policy],
		["Database", [], [{ ...current, description: "Database analysis" }], policy],
		["  ", [skill("database")], profiles, policy],
	] as const) {
		const plan = await planTask(task, [...skills], [...models], current, settings, never);
		assert.deepEqual(plan.skills, []);
		assert.equal(plan.model, undefined);
		assert.deepEqual(plan.evaluations, []);
		assert.equal(plan.assessedSkills, 0);
		assert.ok(plan.coverage.length);
	}
});

test("skill relevance is independent per named item and paths remain local", async () => {
	const controller = new AbortController();
	const skills = [skill("schema"), skill("index"), skill("backup")];
	let captured: Evaluation | undefined;
	let calls = 0;
	const evaluate: Evaluate = async (request, signal) => {
		calls++;
		assert.equal(signal, controller.signal);
		const state = request.state as Record<string, { name: string; description: string } | string>;
		assert.equal(state.task, "Database query analysis");
		assert.equal(Object.keys(request.questions).length, 3);
		const answers: Evaluation["answers"] = {};
		for (const [id, question] of Object.entries(request.questions)) {
			assert.equal(question.type, "noul");
			const referenced = Object.keys(state).filter(
				(key) => key !== "task" && question.instructions.includes(`\`${key}\``),
			);
			assert.equal(referenced.length, 1);
			const item = state[referenced[0]!] as {
				name: string;
				description: string;
			};
			assert.deepEqual(Object.keys(item).sort(), ["description", "name"]);
			answers[id] = { type: "noul", noul: item.name === "index" ? 0.15 : 0.93 };
		}
		captured = result(answers);
		return captured;
	};
	const plan = await planTask(
		"Database query analysis",
		skills,
		profiles,
		current,
		{ ...policy, models: "off" },
		evaluate,
		controller.signal,
	);
	assert.equal(calls, 1);
	assert.deepEqual(
		plan.skills,
		[skills[0], skills[2]].map((item) => ({
			name: item!.name,
			path: item!.path,
			probability: 0.93,
		})),
	);
	assert.deepEqual(plan.evaluations, [captured]);
	assert.equal(plan.assessedSkills, skills.length);
	assert.match(plan.coverage, /3 of 3 assessed; 0 omitted/);
});

test("semantic utility reverses input order and retains zero-overlap synonyms", async () => {
	const skills = [
		skill("slow-searches", "Discuss slow searches as a general topic"),
		skill("baking", "Pastry recipes"),
		skill("query-tuning", "Optimize database indexes and execution plans"),
		skill("profiling", "Trace database bottlenecks"),
		skill("metrics", "Measure database latency"),
	];
	const probabilities = [0.81, 0.01, 0.99, 0.94, 0.91];
	const plan = await planTask(
		"Speed up slow searches",
		skills,
		[],
		current,
		policy,
		evaluator((id) => ({
			type: "noul",
			noul: probabilities[Number(id.slice(5))]!,
		})),
	);
	assert.deepEqual(
		plan.skills.map((item) => item.name),
		["query-tuning", "profiling", "metrics", "slow-searches"],
	);
	assert.match(plan.coverage, /5 of 5 assessed; 0 omitted/);
	assert.match(plan.coverage, /1 below the relevance threshold/);
	assert.equal(plan.evaluations[0]!.answers.skill0!.type, "noul");
});

test("batches assess the first 512 candidates within count and byte bounds", async () => {
	for (const description of ["Database", "\u0000".repeat(900)]) {
		const skills = Array.from({ length: 520 }, (_, index) =>
			skill(`candidate-${index}`, description),
		);
		let assessed = 0;
		let modelQuestions = 0;
		const batchSizes: number[] = [];
		const seen = new Set<string>();
		const plan = await planTask("Database", skills, profiles, current, policy, async (request) => {
			parseRequest(request);
			const ids = Object.keys(request.questions).filter((id) => id !== "model");
			assessed += ids.length;
			modelQuestions += Number(!!request.questions.model);
			batchSizes.push(ids.length);
			for (const id of ids) {
				assert.ok(!seen.has(id));
				seen.add(id);
			}
			assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 48_000);
			assert.ok(
				Buffer.byteLength(JSON.stringify(request.state)) +
					Math.max(
						...Object.values(request.questions).map((question) =>
							Buffer.byteLength(JSON.stringify(question)),
						),
					) <=
					24_000,
			);
			return positive(request);
		});
		assert.equal(assessed, 512);
		assert.equal(plan.assessedSkills, 512);
		assert.equal(modelQuestions, 1);
		assert.equal(plan.evaluations.length, batchSizes.length);
		if (description === "Database") assert.equal(batchSizes[0], 31);
		else assert.ok(Math.max(...batchSizes) < 31);
		assert.deepEqual(
			plan.skills.map((item) => item.name),
			skills.slice(0, 512).map((item) => item.name),
		);
		assert.match(
			plan.coverage,
			new RegExp(`${assessed} of 520 assessed; ${520 - assessed} omitted`),
		);
		assert.match(plan.coverage, /512-item scan limit 8/);
		assert.match(plan.coverage, /not judged/);
	}
});

for (const models of ["off", "suggest"] as const) {
	test(`all qualifying skills across batches are selected with model routing ${models}`, async () => {
		const skills = Array.from({ length: 44 }, (_, index) => skill(`candidate-${index}`));
		const probabilities = new Map([
			[0, 0.82],
			[2, 0.95],
			[31, 0.88],
			[32, 0.95],
			[38, 0.99],
			[43, 0.8],
		]);
		const controller = new AbortController();
		const requests: Request[] = [];
		const evaluations: Evaluation[] = [];
		let active = 0;
		const plan = await planTask(
			"Analyze database queries",
			skills,
			profiles,
			current,
			{ ...policy, models },
			async (request, signal) => {
				assert.equal(signal, controller.signal);
				assert.equal(++active, 1, "Batches must not overlap");
				parseRequest(request);
				requests.push(request);
				await Promise.resolve();
				active--;
				const evaluation = await positive(request);
				evaluation.model = `jev-batch-${evaluations.length}`;
				for (const id of Object.keys(request.questions)) {
					if (id === "model") continue;
					evaluation.answers[id] = {
						type: "noul",
						noul: probabilities.get(Number(id.slice(5))) ?? 0.01,
					};
					const metadata = (request.state as Record<string, unknown>)[id];
					assert.deepEqual(Object.keys(metadata as object).sort(), ["description", "name"]);
				}
				evaluations.push(evaluation);
				return evaluation;
			},
			controller.signal,
		);
		assert.equal(plan.assessedSkills, 44);
		assert.equal(requests.length, 2);
		assert.equal(Object.keys(requests[0]!.questions).length, 32);
		assert.equal(
			requests.filter((request) => request.questions.model).length,
			models === "off" ? 0 : 1,
		);
		assert.deepEqual(plan.evaluations, evaluations);
		assert.deepEqual(
			plan.evaluations.map((evaluation) => evaluation.model),
			["jev-batch-0", "jev-batch-1"],
		);
		assert.deepEqual(
			plan.skills.map((item) => item.name),
			[38, 2, 32, 31, 0, 43].map((index) => skills[index]!.name),
		);
		assert.deepEqual(
			plan.skills.map((item) => item.probability),
			[0.99, 0.95, 0.95, 0.88, 0.82, 0.8],
		);
		assert.deepEqual(plan.model, models === "off" ? undefined : profiles[0]);
		assert.match(plan.coverage, /44 of 44 assessed; 0 omitted/);
		assert.match(plan.coverage, /38 below the relevance threshold/);
	});
}

test("a skill that cannot fit alone is omitted without blocking later eligible skills", async () => {
	const skills = [
		skill("early"),
		{ ...skill("explicit", "PRIVATE_METADATA"), disableModelInvocation: true },
		skill("invalid", ""),
		skill("early"),
		skill("cannot-fit-alone", "\u0000".repeat(900)),
		skill("late"),
	];
	const task = `${"\u0000".repeat(3600)}Database`;
	const assessedNames: string[] = [];
	const plan = await planTask(task, skills, [], current, policy, async (request) => {
		parseRequest(request);
		assert.ok(!JSON.stringify(request).includes("PRIVATE_METADATA"));
		for (const key of Object.keys(request.questions))
			assessedNames.push(
				((request.state as Record<string, unknown>)[key] as { name: string }).name,
			);
		return positive(request);
	});
	assert.deepEqual(assessedNames, ["early", "late"]);
	assert.equal(plan.assessedSkills, 2);
	assert.deepEqual(
		plan.skills.map((item) => item.name),
		["early", "late"],
	);
	assert.match(plan.coverage, /2 of 6 assessed; 4 omitted/);
	assert.match(
		plan.coverage,
		/explicit-only 1, invalid metadata 1, duplicate 1, cannot fit one request 1/,
	);
	const none = await planTask(task, [skills[4]!], [], current, policy, never);
	assert.equal(none.assessedSkills, 0);
	assert.deepEqual(none.evaluations, []);
	assert.match(none.coverage, /cannot fit one request 1/);
});

for (const failure of ["service", "cancelled", "malformed", "between-batches"] as const) {
	test(`${failure} failure stops later batches without returning partial selections`, async () => {
		const controller = new AbortController();
		const reason = new Error(`Original ${failure} failure`);
		const completed: Evaluation[] = [];
		let calls = 0;
		await assert.rejects(
			planTask(
				"Database",
				Array.from({ length: 96 }, (_, index) => skill(`candidate-${index}`)),
				[],
				current,
				{ ...policy, models: "off" },
				async (request, signal) => {
					assert.equal(signal, controller.signal);
					calls++;
					if (calls === 2 && failure === "service") throw reason;
					const evaluation =
						calls === 2 && failure === "malformed" ? result({}) : await positive(request);
					completed.push(evaluation);
					if (
						(calls === 1 && failure === "between-batches") ||
						(calls === 2 && failure === "cancelled")
					)
						controller.abort(reason);
					return evaluation;
				},
				controller.signal,
			),
			(error) =>
				failure === "malformed"
					? error instanceof Error && /Missing Noul/.test(error.message)
					: error === reason,
		);
		assert.equal(calls, failure === "between-batches" ? 1 : 2);
		assert.equal(completed.length, failure === "service" || failure === "between-batches" ? 1 : 2);
		assert.ok(Object.keys(completed[0]!.answers).length > 0);
	});
}

test("invalid metadata, duplicate and explicit-only skills are omitted, unrelated skills can select none", async () => {
	const skills = [
		skill("database"),
		skill("database"),
		skill("empty", ""),
		{
			...skill("explicit", "Never submit this metadata"),
			disableModelInvocation: true,
		},
	];
	const plan = await planTask("Database", skills, [], current, policy, async (request) => {
		assert.ok(!JSON.stringify(request).includes("Never submit"));
		return positive(request);
	});
	assert.equal(plan.skills.length, 1);
	assert.match(plan.coverage, /1 of 4 assessed; 3 omitted/);
	assert.match(plan.coverage, /explicit-only 1, invalid metadata 1, duplicate 1/);
	const irrelevant = await planTask(
		"Database",
		[skill("cooking", "Recipes"), skill("music", "Piano lessons")],
		[],
		current,
		policy,
		evaluator(() => ({ type: "noul", noul: 0.01 })),
	);
	assert.deepEqual(irrelevant.skills, []);
	assert.match(irrelevant.coverage, /2 of 2 assessed/);
	assert.match(irrelevant.coverage, /2 below the relevance threshold/);
	const none = await planTask(
		"Database",
		[skill("empty", "")],
		[{ ...profiles[0]!, description: "" }],
		current,
		policy,
		never,
	);
	assert.deepEqual(none.evaluations, []);
	assert.match(none.coverage, /0 of 1 assessed; 1 omitted/);
});

test("one model Choice includes supplied descriptions and keeping current; switch mode remains advisory", async () => {
	for (const mode of ["suggest", "switch"] as const) {
		const supplied = [{ ...current, description: "General assistance." }, ...profiles, ...profiles];
		let calls = 0;
		const plan = await planTask(
			"Analyze database",
			[],
			supplied,
			current,
			{ ...policy, skills: false, models: mode },
			async (request) => {
				calls++;
				assert.deepEqual(Object.keys(request.questions), ["model"]);
				const question = request.questions.model!;
				assert.equal(question.type, "choice");
				if (question.type !== "choice") throw new Error("Expected Choice.");
				assert.deepEqual(Object.keys(question.criteria).sort(), ["keep", "model0"]);
				const state = request.state as Record<string, unknown>;
				assert.deepEqual(state.model0, profiles[0]);
				assert.deepEqual(state.current, supplied[0]);
				return positive(request);
			},
		);
		assert.equal(calls, 1);
		assert.deepEqual(plan.model, profiles[0]);
		assert.equal(plan.probability, 0.9);
		assert.equal(plan.evaluations[0]!.model, "jev-test-version");
	}
});

test("uncertainty and keeping current produce no selections while retaining raw probabilities", async () => {
	for (const choice of ["keep", "model0"] as const) {
		const evaluate = evaluator((_id, question) =>
			question.type === "choice"
				? {
						type: "choice",
						choice,
						confidence: 1,
						probabilities:
							choice === "keep" ? { keep: 0.9, model0: 0.1 } : { keep: 0.45, model0: 0.55 },
					}
				: { type: "noul", noul: 0.5 },
		);
		const plan = await planTask(
			"Database",
			[skill("database")],
			profiles,
			current,
			policy,
			evaluate,
		);
		assert.deepEqual(plan.skills, []);
		assert.equal(plan.model, undefined);
		assert.equal(plan.probability, choice === "keep" ? 0.9 : 0.55);
		assert.equal(plan.evaluations[0]!.answers.skill0!.type, "noul");
	}
	const tie = await planTask(
		"Database",
		[skill("database")],
		[],
		current,
		{ ...policy, threshold: 0 },
		evaluator(() => ({ type: "noul", noul: 0.5 })),
	);
	assert.deepEqual(tie.skills, []);
});

test("planning bounds task and profiles and rejects malformed or missing judgments", async () => {
	await assert.rejects(planTask("é".repeat(4_001), [], profiles, current, policy, never), /8000/);
	await assert.rejects(
		planTask(
			"Database",
			[],
			Array.from({ length: 17 }, () => profiles[0]!),
			current,
			policy,
			never,
		),
		/16/,
	);
	await assert.rejects(
		planTask("Database", [skill("database")], [], current, { ...policy, threshold: NaN }, never),
		/probability/,
	);
	for (const answers of [{}, { skill0: { type: "noul", noul: NaN } }] as Evaluation["answers"][]) {
		await assert.rejects(
			planTask("Database", [skill("database")], [], current, policy, async () => result(answers)),
		);
	}
	await assert.rejects(
		planTask("Database", [], profiles, current, policy, async () =>
			result({
				model: {
					type: "choice",
					choice: "invented",
					confidence: 1,
					probabilities: { invented: 1 },
				},
			}),
		),
		/model judgment/,
	);
});

test("tool assessment carries the goal and reports specific independent concerns", async () => {
	const tool = { name: "bash", input: { command: "rm -rf archive" } };
	const evaluation = result({
		destructiveDataLoss: { type: "noul", noul: 0.95 },
		taskMismatch: { type: "noul", noul: 0.05 },
	});
	const report = await assessTool("Delete the archive", tool, 0, async (request) => {
		const state = request.state as Record<string, unknown>;
		assert.equal(state.task, "Delete the archive");
		assert.deepEqual(state.tool, tool);
		assert.deepEqual(Object.keys(request.questions).sort(), [
			"destructiveDataLoss",
			"taskMismatch",
		]);
		assert.ok(Object.values(request.questions).every((question) => question.type === "noul"));
		return evaluation;
	});
	assert.equal(report.status, "concern");
	assert.deepEqual(report.probabilities, {
		destructiveDataLoss: 0.95,
		taskMismatch: 0.05,
	});
	assert.equal(report.evaluation, evaluation);
	const mismatch = await assessTool("Preserve archive", tool, 0, async () =>
		result({
			destructiveDataLoss: { type: "noul", noul: 0.05 },
			taskMismatch: { type: "noul", noul: 0.91 },
		}),
	);
	assert.equal(mismatch.status, "concern");
});

test("failure counts remain evidence but cannot promote an otherwise unconcerning call", async () => {
	for (const count of [0, 1, 2, 100]) {
		const report = await assessTool(
			"Run tests",
			{ name: "bash", input: { command: "bun test" } },
			count,
			async (request) => {
				assert.deepEqual((request.state as Record<string, unknown>).signals, {
					recentFailures: count,
					hasRecentFailures: count > 0,
					repeatedFailures: count >= 2,
				});
				return result({
					destructiveDataLoss: { type: "noul", noul: 0.05 },
					taskMismatch: { type: "noul", noul: 0.05 },
				});
			},
		);
		assert.equal(report.status, "no-concern");
		assert.equal(report.signals.recentFailures, count);
	}
	const uncertain = await assessTool(
		"Run tests",
		{ name: "bash", input: null },
		0,
		evaluator(() => ({ type: "noul", noul: 0.5 })),
	);
	assert.equal(uncertain.status, "uncertain");
});

test("oversized tool evidence, invalid counts and incomplete assessments fail without partial success", async () => {
	const tool = { name: "bash", input: null };
	for (const count of [-1, 1.5, NaN, Infinity])
		await assert.rejects(assessTool("Run tests", tool, count, never), /failure count/);
	await assert.rejects(
		assessTool("Run tests", { name: "write", input: "\u0000".repeat(8_000) }, 0, never),
		/48000/,
	);
	await assert.rejects(
		assessTool("Run tests", { name: "write", input: "x".repeat(24_000) }, 0, never),
		/24000/,
	);
	await assert.rejects(
		planTask(
			"Database",
			[],
			Array.from({ length: 16 }, (_, index) => ({
				provider: "local",
				model: `model-${index}`,
				description: "\u0000".repeat(400),
			})),
			current,
			policy,
			never,
		),
		/24000/,
	);
	await assert.rejects(
		assessTool("Run tests", tool, 0, async () =>
			result({ destructiveDataLoss: { type: "noul", noul: 0 } }),
		),
		/Missing Noul/,
	);
});

test("optional loading preserves native instructions and enforces individual body and discovered-file limits", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jev-autopilot-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			handlers.set(name, handler),
	} as unknown as ExtensionAPI;
	const runtime = new Runtime(pi);
	runtime.active = true;
	runtime.policy = {
		...defaultPolicy,
		autopilot: { ...policy, models: "off" },
		profiles: [],
	};
	runtime.evaluator = () => positive;
	registerAutopilot(pi, runtime);
	const ctx = {
		model: { provider: "test", id: "current" },
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [] },
		hasUI: false,
	} as unknown as ExtensionContext;
	const native = "Native explicit and mandatory skill instructions must remain here.";
	const skills = ["first", "second", "third", "undiscovered"].map((name) => ({
		name,
		description: "Task guidance",
		filePath: join(root, name),
	}));
	await writeFile(skills[0]!.filePath, "a".repeat(11000));
	await writeFile(skills[1]!.filePath, "b".repeat(10000));
	await writeFile(skills[2]!.filePath, "THIRD_BODY");
	await writeFile(skills[3]!.filePath, "UNDISCOVERED_BODY");
	const run = async (discovered: typeof skills, text = "Task") => {
		handlers.get("input")!({ source: "interactive", text }, ctx);
		return (await handlers.get("before_agent_start")!(
			{
				prompt: text,
				systemPrompt: native,
				systemPromptOptions: { skills: discovered },
			},
			ctx,
		)) as
			| {
					systemPrompt: string;
					message: { content: string; details: { kind: string; coverage: string } };
			  }
			| undefined;
	};
	const loaded = await run(skills.slice(0, 3));
	assert.ok(loaded);
	assert.ok(loaded.systemPrompt.startsWith(native));
	assert.ok(loaded.systemPrompt.includes("a".repeat(11000)));
	assert.ok(loaded.systemPrompt.includes("b".repeat(10000)));
	assert.ok(loaded.systemPrompt.includes("THIRD_BODY"));
	assert.ok(!loaded.systemPrompt.includes("UNDISCOVERED_BODY"));
	await writeFile(skills[0]!.filePath, "é".repeat(6001));
	await rm(skills[1]!.filePath);
	await symlink(skills[3]!.filePath, skills[1]!.filePath);
	const bounded = await run(skills.slice(0, 3));
	assert.ok(bounded);
	assert.ok(!bounded.systemPrompt.includes("é".repeat(6001)));
	assert.ok(!bounded.systemPrompt.includes("UNDISCOVERED_BODY"));
	assert.ok(bounded.systemPrompt.includes("THIRD_BODY"));
	assert.match(bounded.message.content, /Skill omitted: first/);
	assert.match(bounded.message.content, /Skill omitted: second/);
	runtime.evaluator = () => evaluator(() => ({ type: "noul", noul: 0.01 }));
	const none = await run(skills.slice(0, 3));
	assert.ok(none);
	assert.equal(none.systemPrompt, native);
	assert.match(none.message.content, /0 selected/);
	assert.match(none.message.content, /3\/3 assessed/);
	assert.equal(none.message.details.kind, "autopilot");
	assert.ok(!none.message.content.includes(none.message.details.coverage));
	const partial = await run(
		Array.from({ length: 44 }, (_, index) => ({
			name: `candidate-${index}`,
			description: "Task guidance",
			filePath: join(root, `candidate-${index}`),
		})),
	);
	assert.ok(partial);
	assert.match(partial.message.content, /44\/44 assessed/);
	assert.match(partial.message.details.coverage, /0 omitted/);
	assert.equal(await run(skills, "/skill:first"), undefined);
});

test("native turn cancellation stops skill batches without prompt changes or warnings", async () => {
	const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const notifications: unknown[] = [];
	const messages: unknown[] = [];
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			handlers.set(name, handler),
		sendMessage: (message: unknown) => messages.push(message),
	} as unknown as ExtensionAPI;
	const runtime = new Runtime(pi);
	runtime.active = true;
	runtime.policy = {
		...defaultPolicy,
		autopilot: { ...policy, models: "off" },
		profiles: [],
	};
	const turn = new AbortController();
	let calls = 0;
	runtime.evaluator = () => async (request, signal) => {
		assert.ok(signal);
		assert.equal(signal.aborted, false);
		if (++calls === 2) {
			turn.abort();
			assert.equal(signal.aborted, true);
		}
		return positive(request);
	};
	registerAutopilot(pi, runtime);
	const ctx = {
		signal: turn.signal,
		model: { provider: "test", id: "current" },
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => undefined,
		sessionManager: { getBranch: () => [] },
		hasUI: true,
		ui: { notify: (...args: unknown[]) => notifications.push(args) },
	} as unknown as ExtensionContext;
	const event = {
		prompt: "Database",
		systemPrompt: "Native mandatory instructions",
		systemPromptOptions: {
			skills: Array.from({ length: 96 }, (_, index) => ({
				name: `candidate-${index}`,
				description: "Database query guidance",
				filePath: `/synthetic/skills/${index}/SKILL.md`,
			})),
		},
	};
	const original = structuredClone(event);
	handlers.get("input")!({ source: "interactive", text: event.prompt }, ctx);
	assert.equal(await handlers.get("before_agent_start")!(event, ctx), undefined);
	assert.equal(calls, 2);
	assert.equal(runtime.controller.signal.aborted, false);
	assert.deepEqual(event, original);
	assert.deepEqual(messages, []);
	assert.deepEqual(notifications, []);
});

test("cancellation is forwarded, stale results discarded and service failures not retried", async () => {
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		planTask("Database", [skill("database")], [], current, policy, never, controller.signal),
	);
	const active = new AbortController();
	await assert.rejects(
		assessTool(
			"Run tests",
			{ name: "bash", input: null },
			0,
			async (request, signal) => {
				assert.equal(signal, active.signal);
				active.abort();
				return positive(request);
			},
			active.signal,
		),
	);
	let calls = 0;
	await assert.rejects(
		planTask("Database", [], profiles, current, policy, async () => {
			calls++;
			throw new Error("Budget exhausted.");
		}),
		/Budget exhausted/,
	);
	assert.equal(calls, 1);
});
