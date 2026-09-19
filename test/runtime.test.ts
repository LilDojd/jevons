import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime } from "../pi/runtime.ts";
import type { Request } from "../src/contracts.ts";

const request: Request = {
	state: { task: "Review a change" },
	questions: {
		relevant: {
			type: "noul",
			instructions: "Does this task request a review?",
		},
	},
};

async function fixture(t: TestContext, fetch: typeof globalThis.fetch) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "jevons-runtime-")));
	const previousFetch = globalThis.fetch;
	const previousKey = process.env.TYPESAFE_API_KEY;
	globalThis.fetch = fetch;
	process.env.TYPESAFE_API_KEY = "runtime-test-not-a-credential";
	t.after(async () => {
		globalThis.fetch = previousFetch;
		if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previousKey;
		await rm(root, { recursive: true, force: true });
	});
	const receipts: unknown[] = [];
	const runtime = new Runtime(
		{
			appendEntry: (_type: string, data: unknown) => {
				receipts.push(data);
			},
		} as unknown as ExtensionAPI,
		join(root, "agent"),
	);
	const ctx = {
		cwd: root,
		hasUI: false,
		isProjectTrusted: () => true,
		sessionManager: {
			getSessionId: () => "runtime-session",
			getBranch: () => [],
			getEntries: () =>
				receipts.map((data) => ({
					type: "custom",
					customType: "jevons.receipt",
					data,
				})),
		},
	} as unknown as ExtensionContext;
	t.after(() => runtime.pause(ctx));
	return { root, runtime, ctx, receipts };
}

test("evaluations report progress and accounting, and failures show pause", async (t) => {
	let fail = false;
	const { runtime, ctx, receipts } = await fixture(t, async () =>
		fail
			? new Response("unavailable", { status: 503 })
			: Response.json({
					model: "jev-test-version",
					answers: { relevant: { type: "noul", noul: 0.9 } },
					usage: { input_tokens: 10, output_tokens: 2 },
				}),
	);
	const statuses: { active: boolean; activity?: string }[] = [];
	runtime.status = (_ctx, activity) => {
		statuses.push({ active: runtime.active, activity });
	};
	await runtime.enable(ctx, true);
	statuses.length = 0;
	for (let batch = 0; batch < 2; batch++) await runtime.evaluator(ctx, "Review")(request);
	assert.equal(receipts.length, 2);
	assert.equal(statuses.length, 4);
	assert.equal(runtime.usageSummary(ctx).input, 20);
	statuses.length = 0;
	await runtime.evaluator(ctx, "Review")(request);
	assert.deepEqual(
		statuses.map((status) => status.activity),
		["Review", undefined],
	);
	statuses.length = 0;
	fail = true;
	await assert.rejects(runtime.evaluator(ctx, "Review")(request));
	assert.equal(receipts.length, 4);
	assert.deepEqual(statuses, [
		{ active: true, activity: "Review" },
		{ active: false, activity: undefined },
	]);
});

test("task restoration reads only delivered user entries on the current branch", () => {
	const runtime = new Runtime({} as ExtensionAPI);
	runtime.deliveredUser("Other branch instruction");
	const branch = [
		{
			type: "message",
			message: { role: "user", content: "Preserve credentials" },
		},
		{ type: "compaction", summary: "Incomplete summary" },
		{
			type: "message",
			message: { role: "user", content: [{ type: "text", text: "continue" }] },
		},
		{ type: "custom_message", content: "Not user authority" },
	];
	const ctx = {
		sessionManager: { getBranch: () => branch },
	} as unknown as ExtensionContext;
	const previous = runtime.taskRevision;
	runtime.restoreTask(ctx);
	assert.ok(runtime.taskRevision > previous);
	assert.equal(runtime.task, "Preserve credentials\nUser update:\ncontinue");
	assert.equal(runtime.taskOmitted, false);
	runtime.deliveredUser("x".repeat(8001));
	assert.equal(runtime.taskOmitted, true);
	runtime.deliveredUser("continue");
	assert.equal(runtime.taskOmitted, true);
	runtime.restoreTask(ctx);
	assert.equal(runtime.taskOmitted, false);
	runtime.deliveredUser("Image constraint", true);
	assert.equal(runtime.taskOmitted, true);
});

test("usage restores historical and current receipts across branches without network", () => {
	const runtime = new Runtime({} as ExtensionAPI);
	const receipt = (data: unknown) => ({
		type: "custom",
		customType: "jevons.receipt",
		data,
	});
	const entries: unknown[] = [
		receipt({
			status: "completed",
			accounting: "settled",
			usage: { input_tokens: 10, output_tokens: 2 },
		}),
		receipt({
			status: "failed",
			accounting: "overrun",
			usage: { input_tokens: 100, output_tokens: 3 },
		}),
		receipt({ status: "failed", accounting: "reserved" }),
		receipt({ status: "cancelled", accounting: "released" }),
		receipt({
			status: "completed",
			accounting: "reported",
			usage: { input_tokens: 0, output_tokens: 0 },
		}),
		receipt({ status: "cancelled", accounting: "unknown" }),
		receipt({ status: "failed", accounting: "not-dispatched" }),
		receipt({
			status: "failed",
			accounting: "reported",
			usage: { input_tokens: -1, output_tokens: 2 },
		}),
		receipt(null),
		receipt({ private: "not usage" }),
		{
			type: "custom",
			customType: "other",
			data: {
				status: "completed",
				usage: { input_tokens: 999, output_tokens: 999 },
			},
		},
	];
	const ctx = {
		sessionManager: { getEntries: () => entries, getBranch: () => [] },
	} as unknown as ExtensionContext;
	const expected = { input: 110, output: 5, calls: 6, unknown: 3, failed: 6 };
	assert.deepEqual(runtime.usageSummary(ctx), expected);
	assert.deepEqual(runtime.usageSummary(ctx), expected);
	entries.length = 0;
	assert.deepEqual(runtime.usageSummary(ctx), {
		input: 0,
		output: 0,
		calls: 0,
		unknown: 0,
		failed: 0,
	});
});

test("usage marks cumulative token overflow unknown without rounding either total", () => {
	for (const field of ["input_tokens", "output_tokens"] as const) {
		const other = field === "input_tokens" ? "output_tokens" : "input_tokens";
		const entries = [
			{ [field]: Number.MAX_SAFE_INTEGER - 1, [other]: 0 },
			{ [field]: 1, [other]: 0 },
			{ [field]: 1, [other]: 7 },
			{ [field]: 0, [other]: 2 },
		].map((usage) => ({
			type: "custom",
			customType: "jevons.receipt",
			data: { status: "completed", accounting: "reported", usage },
		}));
		const runtime = new Runtime({} as ExtensionAPI);
		const ctx = {
			sessionManager: { getEntries: () => entries },
		} as unknown as ExtensionContext;
		assert.deepEqual(runtime.usageSummary(ctx), {
			input: field === "input_tokens" ? Number.MAX_SAFE_INTEGER : 2,
			output: field === "output_tokens" ? Number.MAX_SAFE_INTEGER : 2,
			calls: 4,
			unknown: 1,
			failed: 0,
		});
	}
});

test("network requires trusted project and explicit consent", async (t) => {
	let calls = 0;
	const { runtime, ctx } = await fixture(t, async () => {
		calls++;
		return response();
	});
	await assert.rejects(runtime.enable({ ...ctx, isProjectTrusted: () => false }, true), /Trust/);
	await assert.rejects(runtime.enable(ctx));
	await runtime.enable({
		...ctx,
		hasUI: true,
		ui: { confirm: async () => false },
	} as unknown as ExtensionContext);
	assert.equal(runtime.active, false);
	assert.equal(calls, 0);
});

for (const change of ["trust", "project", "session", "pause"] as const) {
	test(`enable rejects ${change} changes during confirmation`, async (t) => {
		const { runtime, ctx } = await fixture(t, async () => {
			throw new Error("Unexpected network");
		});
		const interactive = {
			...ctx,
			hasUI: true,
			ui: {
				setStatus() {},
				confirm: async () => {
					if (change === "trust") interactive.isProjectTrusted = () => false;
					else if (change === "project") interactive.cwd += "/other";
					else if (change === "session")
						interactive.sessionManager = { ...ctx.sessionManager, getSessionId: () => "other" };
					else runtime.pause(interactive);
					return true;
				},
			},
		} as unknown as ExtensionContext;
		await assert.rejects(runtime.enable(interactive));
		assert.equal(runtime.active, false);
		assert.equal(runtime.jev, undefined);
	});
}

function response(tokens = 20): Response {
	return Response.json({
		model: "jev-runtime-test",
		usage: { input_tokens: tokens, output_tokens: 0 },
		answers: { relevant: { type: "noul", noul: 0.9 } },
	});
}

test("pause cancels an in-flight evaluation even when the transport ignores abort", {
	timeout: 3000,
}, async (t) => {
	let started!: () => void;
	const sent = new Promise<void>((resolve) => {
		started = resolve;
	});
	let observedSignal: AbortSignal | null | undefined;
	let complete!: (value: Response) => void;
	const { runtime, ctx, receipts } = await fixture(t, async (_url, init) => {
		observedSignal = init?.signal;
		started();
		return new Promise<Response>((resolve) => {
			complete = resolve;
		});
	});
	await runtime.enable(ctx, true);
	const pending = runtime.evaluator(ctx, "Review")(request);
	const rejected = assert.rejects(pending, /cancel|abort/i);
	await sent;
	runtime.pause(ctx);
	assert.equal(observedSignal?.aborted, true);
	await rejected;
	assert.equal(runtime.active, false);
	assert.throws(() => runtime.evaluator(ctx, "Review"), /paused/i);
	complete(response());
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(receipts.length, 1);
	assert.equal((receipts[0] as { status: string }).status, "cancelled");
});

for (const cancellation of ["caller abort", "new generation"] as const) {
	test(`${cancellation} after receipt rejects a late success without pausing the active generation`, {
		timeout: 3000,
	}, async (t) => {
		const { runtime, ctx } = await fixture(t, async () => response());
		await runtime.enable(ctx, true);
		const caller = new AbortController();
		const oldJev = runtime.jev!;
		const evaluate = oldJev.evaluate.bind(oldJev);
		oldJev.evaluate = async (...args) => {
			const result = await evaluate(...args);
			if (cancellation === "caller abort") caller.abort();
			else {
				runtime.pause(ctx);
				await runtime.enable(ctx, true);
			}
			return result;
		};
		await assert.rejects(
			runtime.evaluator(ctx, "Review")(request, caller.signal),
			/abort|cancel|session changed/i,
		);
		oldJev.evaluate = evaluate;
		assert.equal(runtime.active, true);
		assert.equal((await runtime.evaluator(ctx, "Fresh review")(request)).model, "jev-runtime-test");
	});
}

test("reenabling after pause permits fresh evaluations but never revives an old evaluator", {
	timeout: 3000,
}, async (t) => {
	let calls = 0;
	const { runtime, ctx } = await fixture(t, async () => {
		calls++;
		return response();
	});
	assert.throws(() => runtime.evaluator(ctx, "Review"), /paused/i);
	await runtime.enable(ctx, true);
	const old = runtime.evaluator(ctx, "Review");
	assert.equal((await old(request)).model, "jev-runtime-test");
	runtime.pause(ctx);
	await runtime.enable(ctx, true);
	await assert.rejects(old(request));
	assert.equal(calls, 1);
	assert.equal((await runtime.evaluator(ctx, "Review")(request)).answers.relevant?.type, "noul");
	assert.equal(calls, 2);
	assert.equal(runtime.active, true);
});

test("reenabling and reloading restore receipts without disk state or spending limits", {
	timeout: 3000,
}, async (t) => {
	let calls = 0;
	const { root, runtime, ctx } = await fixture(t, async () => {
		calls++;
		return response(1_000_000);
	});
	await runtime.enable(ctx, true);
	await runtime.evaluator(ctx, "Review")(request);
	runtime.pause(ctx);
	await runtime.enable(ctx, true);
	assert.equal(runtime.usageSummary(ctx).input, 1_000_000);
	await runtime.evaluator(ctx, "Review")(request);
	const reloaded = new Runtime({} as ExtensionAPI);
	assert.deepEqual(reloaded.usageSummary(ctx), {
		input: 2_000_000,
		output: 0,
		calls: 2,
		unknown: 0,
		failed: 0,
	});
	assert.equal(calls, 2);
	assert.equal(runtime.active, true);
	assert.deepEqual(await readdir(root), []);
});
