import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultPolicy } from "../pi/policy.ts";
import { registerRecovery } from "../pi/recovery.ts";
import type { Runtime } from "../pi/runtime.ts";
import type { Evaluate, Evaluation, Json, Request } from "../src/contracts.ts";
import { assessRecovery, RecoveryWindow, recoveryMessages } from "../src/recovery.ts";

function judgment(retry = 0.95, user = 0.1): Evaluation {
	return {
		model: "jev-test-actual",
		usage: { input_tokens: 8, output_tokens: 2 },
		elapsedMs: 1,
		answers: {
			ignoresCause: { type: "noul", noul: retry },
			userOnly: { type: "noul", noul: user },
			category: {
				type: "choice",
				choice: "invocation",
				confidence: 0.9,
				probabilities: {
					invocation: 0.95,
					environment: 0.02,
					implementation: 0.02,
					insufficient: 0.01,
				},
			},
		},
	};
}

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
function fixture(evaluate: Evaluate = async () => judgment()) {
	const handlers = new Map<string, Handler[]>();
	const entries: {
		type: string;
		customType: string;
		data: Record<string, unknown>;
	}[] = [];
	const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const requests: Request[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(customType: string, data: Record<string, unknown>) {
			entries.push({ type: "custom", customType, data });
		},
		sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>) {
			sent.push(args);
		},
	} as unknown as ExtensionAPI;
	const abort = new AbortController();
	const session = { id: "session", leaf: "leaf" };
	const ctx = {
		cwd: "/project",
		signal: abort.signal,
		sessionManager: {
			getSessionId: () => session.id,
			getLeafId: () => session.leaf,
			getEntries: () => entries,
			getBranch: () => [],
		},
	} as unknown as ExtensionContext;
	const runtime = {
		active: true,
		task: "Fix the failing check without publishing",
		taskRevision: 1,
		taskOmitted: false,
		policy: structuredClone(defaultPolicy),
		controller: new AbortController(),
		evaluator: () => async (request: Request, signal?: AbortSignal) => {
			requests.push(request);
			return evaluate(request, signal);
		},
	} as unknown as Runtime;
	runtime.policy!.recovery.mode = "steer";
	registerRecovery(pi, runtime);
	const emit = async (name: string, event: Record<string, unknown> = {}) => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
		return result;
	};
	let id = 0;
	const batch = async (error = true, text = "Unknown option --wrong", stopReason = "toolUse") => {
		await emit("turn_start");
		const call = {
			toolCallId: `call-${++id}`,
			toolName: "bash",
			input: { command: "check --wrong" },
		};
		await emit("tool_call", call);
		const result = {
			...call,
			content: [{ type: "text", text }],
			isError: error,
		};
		await emit("tool_result", result);
		await emit("turn_end", {
			toolResults: [result],
			message: { role: "assistant", stopReason },
		});
	};
	return { emit, runtime, ctx, session, abort, entries, sent, requests, batch };
}

test("window joins interleaved results by ID, preserves invocation order, and uses final batch flags", () => {
	const window = new RecoveryWindow();
	const input = { command: "check --wrong" };
	window.call("a", "bash", input, 1);
	input.command = "MUTATED";
	window.call("b", "bash", { command: "check --wrong" }, 2);
	window.result("b", "wrong option", false);
	window.result("a", "wrong option", true, true);
	window.result("b", "wrong option", true, true);
	window.result("b", "late provisional", false);
	const snapshot = window.snapshot();
	assert.equal(snapshot.complete, true);
	assert.deepEqual(
		snapshot.calls.map((c) => c.id),
		["a", "b"],
	);
	assert.equal(snapshot.calls[0]!.hash, snapshot.calls[1]!.hash);
	assert.deepEqual(
		snapshot.calls.map((c) => [c.repeats, c.failedRepeats]),
		[
			[2, 2],
			[2, 2],
		],
	);
	assert.deepEqual(snapshot.calls[0]!.input.value, {
		command: "check --wrong",
	});
});

test("oversized UTF-8 fields are omitted whole with exact serialized byte counts; window is bounded", () => {
	const window = new RecoveryWindow();
	const output = "🦄".repeat(1000);
	window.call("a", "bash", {}, 1);
	window.result("a", output, true, true);
	const snapshot = window.snapshot();
	assert.equal(snapshot.calls[0]!.output!.value, null);
	assert.equal(snapshot.omittedBytes, Buffer.byteLength(JSON.stringify(output)));
	assert.equal(snapshot.complete, false);
	for (let i = 0; i < 5; i++) {
		window.call(String(i), "read", { path: String(i) }, 2);
		window.result(String(i), "ok", false, true);
	}
	assert.equal(window.snapshot().calls.length, 4);
	assert.equal(window.snapshot().droppedCalls, 2);
	assert.ok(window.snapshot().droppedBytes >= snapshot.omittedBytes);
});

test("fixed independent judgments retain raw values and select only bounded text", async () => {
	const window = new RecoveryWindow();
	window.call("a", "bash", { command: "wrong" }, 1);
	window.result("a", "unknown option", true, true);
	const evaluation = judgment(0.99, 0.99);
	const result = await assessRecovery(
		"Fix",
		window.snapshot(),
		defaultPolicy.recovery,
		async (request) => {
			assert.equal(Object.keys(request.questions).length, 3);
			assert.deepEqual(
				Object.values(request.questions).map((q) => q.type),
				["noul", "choice", "noul"],
			);
			return evaluation;
		},
	);
	assert.equal(result.action, "ask-user");
	assert.equal(result.baseline, "none");
	assert.equal(result.evaluation, evaluation);
	assert.ok(recoveryMessages[result.action]);
});

test("no requests before consent or in off mode; final success supersedes provisional failure", async () => {
	const h = fixture();
	h.runtime.active = false;
	await h.batch();
	h.runtime.active = true;
	h.runtime.policy!.recovery.mode = "off";
	await h.batch();
	h.runtime.policy!.recovery.mode = "steer";
	await h.emit("turn_start");
	const call = { toolCallId: "final", toolName: "bash", input: {} };
	await h.emit("tool_call", call);
	await h.emit("tool_result", { ...call, content: [], isError: true });
	await h.emit("turn_end", {
		toolResults: [{ ...call, content: [], isError: false }],
		message: { role: "assistant", stopReason: "toolUse" },
	});
	assert.equal(h.requests.length, 0);
	assert.equal(h.entries.at(-1)!.data.batchFailures, 0);
});

test("recovery observations distinguish skipped checks from assessment starts", async () => {
	for (const mode of ["steer", "shadow"] as const) {
		const h = fixture();
		h.runtime.policy!.recovery.mode = mode;
		await h.batch(false);
		assert.equal(h.entries.at(-1)!.data.reason, "no-failures");
		assert.equal(h.entries.at(-1)!.data.mode, mode);
		assert.equal(h.requests.length, 0);

		await h.batch(true, "Failure", "error");
		assert.equal(h.entries.at(-1)!.data.reason, "assistant-error");
		await h.batch(true, "Failure", "aborted");
		assert.equal(h.entries.at(-1)!.data.status, "cancelled");
		assert.equal(h.entries.at(-1)!.data.reason, "cancelled");
		assert.equal(h.requests.length, 0);

		const start = h.entries.length;
		await h.batch();
		assert.equal(h.entries[start]!.data.reason, "assessment-pending");
		assert.equal(h.entries[start]!.data.action, undefined);
		assert.equal(h.entries[start + 1]!.data.status, "assessed");
		assert.equal(h.requests.length, 1);

		await h.batch();
		assert.equal(h.entries.at(-1)!.data.reason, "cooldown");
		assert.equal(h.requests.length, 1);
		for (let i = 0; i < h.runtime.policy!.recovery.cooldownTurns; i++) await h.batch();
		assert.equal(h.requests.length, 2);
		await h.batch();
		assert.equal(h.entries.at(-1)!.data.reason, "session-cap");
		assert.equal(h.entries.at(-1)!.data.mode, mode);
		assert.equal(h.requests.length, 2);
		assert.equal(h.sent.length, mode === "steer" ? 2 : 0);
	}
});

test("final batch can steer once; no tool blocking, execution, or generated action text", async () => {
	const h = fixture();
	await h.batch();
	assert.equal(h.requests.length, 1);
	assert.equal(h.sent.length, 1);
	assert.equal(h.sent[0]![0].content, recoveryMessages.replan);
	assert.deepEqual(h.sent[0]![1], { deliverAs: "steer", triggerTurn: false });
	const report = h.entries.find((e) => e.data.status === "assessed")!.data;
	assert.equal((report.evaluation as Evaluation).model, "jev-test-actual");
	assert.equal(report.agreesWithBaseline, false);
	const logs = JSON.stringify(h.entries);
	assert.ok(!logs.includes("check --wrong") && !logs.includes("Unknown option"));
});

test("cooldown and cap survive user continue, task changes, branch restoration, and reload", async () => {
	const h = fixture();
	await h.batch();
	for (let i = 0; i < 3; i++) await h.batch();
	assert.equal(h.sent.length, 1);
	await h.emit("message_start", { message: { role: "user" } });
	h.runtime.task += "\nContinue";
	h.runtime.taskRevision++;
	await h.batch();
	assert.equal(h.sent.length, 2);
	await h.emit("session_tree");
	await h.emit("session_start");
	for (let i = 0; i < 5; i++) await h.batch();
	assert.equal(h.sent.length, 2);
});

test("shadow compares the same decision without steering and has its own bounded cap", async () => {
	const h = fixture();
	h.runtime.policy!.recovery.mode = "shadow";
	h.runtime.policy!.recovery.cooldownTurns = 0;
	for (let i = 0; i < 5; i++) await h.batch();
	assert.equal(h.sent.length, 0);
	assert.equal(h.requests.length, 2);
	const reports = h.entries.filter((e) => e.data.status === "assessed");
	assert.equal(reports[0]!.data.agreesWithBaseline, false);
	assert.equal(reports[1]!.data.agreesWithBaseline, true);
	h.runtime.policy!.recovery.mode = "steer";
	await h.batch();
	assert.equal(h.sent.length, 1);
});

for (const change of [
	"task",
	"policy",
	"session",
	"branch",
	"evidence",
	"pause",
	"cancel",
] as const) {
	test(`in-flight ${change} invalidation cannot steer or consume intervention cap`, async () => {
		const gate = Promise.withResolvers<Evaluation>();
		const started = Promise.withResolvers<void>();
		const h = fixture(async () => {
			started.resolve();
			return gate.promise;
		});
		const pending = h.batch();
		await started.promise;
		if (change === "task") {
			h.runtime.taskRevision++;
			h.runtime.task += " changed";
		}
		if (change === "policy") h.runtime.policy!.recovery.retryConcern = 0.99;
		if (change === "session") h.session.id = "replacement";
		if (change === "branch") await h.emit("session_tree");
		if (change === "evidence")
			await h.emit("tool_call", {
				toolCallId: "new",
				toolName: "read",
				input: {},
			});
		if (change === "pause") {
			h.runtime.active = false;
			h.runtime.controller.abort();
		}
		if (change === "cancel") h.abort.abort();
		gate.resolve(judgment());
		await pending;
		assert.equal(h.sent.length, 0);
		assert.ok(!h.entries.some((e) => e.customType === "jevons.recovery.state"));
	});
}

test("queued advisory is excluded from model context after task or evidence changes", async () => {
	const h = fixture();
	await h.batch();
	const message = { ...h.sent[0]![0], role: "custom" };
	const before = (await h.emit("context", { messages: [message] })) as {
		messages: unknown[];
	};
	assert.equal(before.messages.length, 1);
	h.runtime.taskRevision++;
	const after = (await h.emit("context", { messages: [message] })) as {
		messages: unknown[];
	};
	assert.equal(after.messages.length, 0);
});

test("omitted task or output and unmatched/overflow batch results remain unassessed", async () => {
	const h = fixture();
	h.runtime.taskOmitted = true;
	await h.batch();
	h.runtime.taskOmitted = false;
	await h.batch(true, "🦄".repeat(1000));
	await h.emit("turn_start");
	const results = [];
	for (let i = 0; i < 5; i++) {
		const call = { toolCallId: `overflow-${i}`, toolName: "bash", input: {} };
		await h.emit("tool_call", call);
		results.push({ ...call, content: [], isError: true });
	}
	await h.emit("turn_end", {
		toolResults: results,
		message: { role: "assistant", stopReason: "toolUse" },
	});
	assert.equal(h.requests.length, 0);
	assert.equal(h.sent.length, 0);
	assert.equal(h.entries.at(-1)!.data.unmatchedResults, 1);
	assert.equal(h.entries.at(-1)!.data.complete, false);
	assert.ok(h.entries.some((e) => Number(e.data.omittedBytes) > 1500));
});

test("unsupported evidence cannot block a tool or become a partial green result", async () => {
	const h = fixture();
	await h.emit("turn_start");
	const input: Record<string, unknown> = {};
	input.self = input;
	assert.equal(
		await h.emit("tool_call", { toolCallId: "cycle", toolName: "bash", input }),
		undefined,
	);
	assert.equal(h.entries.at(-1)!.data.status, "unassessed");
	assert.equal(h.entries.at(-1)!.data.byteCountUnavailable, true);
	assert.equal(h.requests.length, 0);
});

test("evaluator failures and invalid judgments never send or retry a steering action", async () => {
	for (const evaluate of [
		async () => {
			throw new Error("private detail");
		},
		async () => judgment(Number.NaN),
	] as Evaluate[]) {
		const h = fixture(evaluate);
		await h.batch();
		assert.equal(h.requests.length, 1);
		assert.equal(h.sent.length, 0);
		assert.equal(h.entries.at(-1)!.data.status, "unavailable");
		assert.ok(!JSON.stringify(h.entries).includes("private detail"));
	}
});

test("unchanged final outcomes are billed once, including no-action judgments", async () => {
	const h = fixture(async () => judgment(0.1));
	await h.emit("turn_start");
	const call = { toolCallId: "same", toolName: "bash", input: {} };
	await h.emit("tool_call", call);
	const event = {
		toolResults: [{ ...call, content: [], isError: true }],
		message: { role: "assistant", stopReason: "toolUse" },
	};
	await h.emit("turn_end", event);
	await h.emit("turn_end", event);
	assert.equal(h.requests.length, 1);
	assert.equal(h.sent.length, 0);
});

test("insufficient category abstains from replan without suppressing user-only questions", async () => {
	for (const user of [0.1, 0.99]) {
		const h = fixture(async () => {
			const result = judgment(0.99, user);
			result.answers.category = {
				type: "choice",
				choice: "insufficient",
				confidence: 1,
				probabilities: {
					invocation: 0,
					environment: 0,
					implementation: 0,
					insufficient: 1,
				},
			};
			return result;
		});
		await h.batch();
		assert.equal(h.sent.length, user === 0.99 ? 1 : 0);
		if (h.sent.length) assert.equal(h.sent[0]![0].content, recoveryMessages["ask-user"]);
	}
});

test("successful source output is omitted without preventing later failure assessment; image data is never shared", async () => {
	const h = fixture();
	const source = "SOURCE_BODY".repeat(1000);
	await h.batch(false, source);
	await h.batch();
	assert.equal(h.requests.length, 1);
	assert.ok(!JSON.stringify(h.requests).includes("SOURCE_BODY"));
	const state = h.requests[0]!.state as {
		window: ReturnType<RecoveryWindow["snapshot"]>;
	};
	assert.ok(state.window.omittedBytes > 10000);
	assert.equal(state.window.complete, true);
	const image = new RecoveryWindow();
	image.call("image", "read", {}, 1);
	const output = {
		content: [{ type: "image", data: "SMALL_IMAGE", mimeType: "image/png" }],
	};
	image.result("image", output, true, true);
	assert.equal(image.snapshot().omittedBytes, Buffer.byteLength(JSON.stringify(output)));
	assert.equal(image.snapshot().complete, false);
	assert.ok(!JSON.stringify(image.snapshot()).includes("SMALL_IMAGE"));
});

test("tool result reconciles arguments actually executed after other middleware", async () => {
	const h = fixture();
	await h.emit("turn_start");
	const call = {
		toolCallId: "patched",
		toolName: "bash",
		input: { command: "original" },
	};
	await h.emit("tool_call", call);
	call.input.command = "executed";
	const result = { ...call, content: [], isError: true };
	await h.emit("tool_result", result);
	await h.emit("turn_end", {
		toolResults: [result],
		message: { role: "assistant", stopReason: "toolUse" },
	});
	const state = h.requests[0]!.state as {
		window: ReturnType<RecoveryWindow["snapshot"]>;
	};
	assert.deepEqual(state.window.calls[0]!.input.value, { command: "executed" });
});

test("oversized tool IDs/names are bounded with original invocation hash and explicit byte omissions", () => {
	const window = new RecoveryWindow();
	const id = "🦄".repeat(1000);
	const name = "tool".repeat(1000);
	window.call(id, name, {}, 1);
	window.result(id, "failure", true, true);
	const snapshot = window.snapshot();
	assert.equal(snapshot.omittedBytes, Buffer.byteLength(id) + Buffer.byteLength(name));
	assert.ok(JSON.stringify(snapshot).length < 3000);
	assert.equal(snapshot.complete, false);
	assert.equal(snapshot.calls[0]!.final, true);
});

test("a cancelled final batch is accounted but not assessed", async () => {
	const h = fixture();
	await h.emit("turn_start");
	const call = { toolCallId: "cancel", toolName: "bash", input: {} };
	await h.emit("tool_call", call);
	await h.emit("turn_end", {
		toolResults: [{ ...call, content: [] as Json[], isError: true }],
		message: { role: "assistant", stopReason: "aborted" },
	});
	assert.equal(h.requests.length, 0);
	assert.equal(h.entries.at(-1)!.data.batchFailures, 1);
});
