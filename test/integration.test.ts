import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import extension from "../pi/extension.ts";
import type { Policy, Request } from "../src/contracts.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;

async function fixture(t: TestContext, checks: Policy["checks"] = [], toolFeedback = false) {
	const root = await realpath(await mkdtemp(join(tmpdir(), "jevons-integration-")));
	const previousKey = process.env.TYPESAFE_API_KEY;
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.TYPESAFE_API_KEY = "integration-test-not-a-credential";
	t.after(async () => {
		if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY;
		else process.env.TYPESAFE_API_KEY = previousKey;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});
	const requests: Request[] = [];
	t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
		const request = JSON.parse(String(init?.body)) as Request;
		requests.push(request);
		return Response.json({
			model: "jev-integration-test",
			usage: { input_tokens: 10, output_tokens: 2 },
			answers: Object.fromEntries(
				Object.keys(request.questions).map((key) => [key, { type: "noul", noul: 0.95 }]),
			),
		});
	});
	await writeFile(
		join(root, "jevons.json"),
		JSON.stringify({ checks, autopilot: { tools: toolFeedback } }),
	);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const tools = new Map<string, Parameters<ExtensionAPI["registerTool"]>[0]>();
	const pi = {
		on: (name: string, handler: Handler) =>
			handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
			commands.set(name, command),
		sendMessage: (...args: Parameters<ExtensionAPI["sendMessage"]>) => sent.push(args),
		registerTool: (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => tools.set(tool.name, tool),
		registerFlag() {},
		registerEntryRenderer() {},
		registerMessageRenderer() {},
		appendEntry() {},
		getFlag: () => false,
	} as unknown as ExtensionAPI;
	const session = { id: "first" };
	const ctx = {
		cwd: root,
		hasUI: true,
		isProjectTrusted: () => true,
		model: { provider: "test", id: "current" },
		scopedModels: [],
		modelRegistry: { getAvailable: () => [] },
		getContextUsage: () => ({ tokens: 0 }),
		sessionManager: {
			getSessionId: () => session.id,
			getBranch: () => [],
			getEntries: () => [],
			getLeafId: () => "leaf",
		},
		ui: { confirm: async () => true, setStatus() {}, notify() {} },
	} as unknown as ExtensionCommandContext;
	extension(pi);
	const emit = async (name: string, event: Record<string, unknown>) => {
		const results: unknown[] = [];
		for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
		return results;
	};
	const command = (args: string) => commands.get("jevons")!.handler(args, ctx);
	await emit("session_start", { reason: "startup" });
	t.after(() => emit("session_shutdown", { reason: "quit" }).then(() => {}));
	return { root, ctx, session, emit, command, requests, sent, tools };
}

test("native tool renderers contain malformed saved metadata without dumping its source", async (t) => {
	const { tools } = await fixture(t);
	for (const [name, details] of [["jevons_decide", { result: { model: "old-model" } }]] as const) {
		const render = tools.get(name)!.renderResult as unknown as (
			result: unknown,
			options: { expanded: boolean },
		) => { render(width: number): string[] };
		const text = render(
			{
				content: [{ type: "text", text: "private-output-sentinel" }],
				details: { ...details, source: "private-metadata-sentinel" },
			},
			{ expanded: true },
		)
			.render(100)
			.join("\n");
		assert.match(text, /unavailable/i);
		assert.doesNotMatch(text, /private-(output|metadata)-sentinel/);
	}
});

test("usage displays an exact combined total when separate columns exceed the numeric sum range", async (t) => {
	const h = await fixture(t);
	t.mock.method(h.ctx.sessionManager, "getEntries", () =>
		[
			{ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 },
			{ input_tokens: 0, output_tokens: 2 },
		].map((usage) => ({
			type: "custom",
			customType: "jevons.receipt",
			data: { status: "completed", accounting: "reported", usage },
		})),
	);
	await h.command("usage");
	const content = h.sent.at(-1)![0].content;
	assert.equal(typeof content, "string");
	assert.ok((content as string).includes((BigInt(Number.MAX_SAFE_INTEGER) + 2n).toLocaleString()));
	assert.equal(h.requests.length, 0);
});

test("loading the extension enables trusted-session decisions without creating project state", async (t) => {
	const h = await fixture(t);
	await h.tools.get("jevons_decide")!.execute(
		"decision",
		{
			state: { task: "Check a supplied fact" },
			questions: {
				supported: { type: "noul", instructions: "Is the task supplied?" },
			},
		},
		undefined,
		undefined,
		h.ctx,
	);
	assert.equal(h.requests.length, 1);
	assert.deepEqual(await readdir(h.root), ["jevons.json"]);
	await h.command("pause");
	await h.command("usage");
	await h.command("activity");
	assert.equal(h.requests.length, 1);
});

test("refusing resume confirmation keeps Jevons paused and prevents manual judgments", async (t) => {
	const h = await fixture(t);
	await h.command("pause");
	const confirm = t.mock.method(h.ctx.ui, "confirm", async () => false);
	await h.command("on");
	assert.equal(confirm.mock.callCount(), 1);
	await assert.rejects(
		h.tools.get("jevons_decide")!.execute(
			"declined",
			{
				state: "task",
				questions: {
					q: { type: "noul", instructions: "Is the task supplied?" },
				},
			},
			undefined,
			undefined,
			h.ctx,
		),
		/paused/,
	);
	assert.equal(h.requests.length, 0);
});

test("completed writer usage survives a subsequent Jev failure as an errored native tool result", async (t) => {
	const h = await fixture(t);
	const usage = {
		input: 13,
		output: 7,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 20,
		cost: {
			input: 0.01,
			output: 0.02,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0.03,
		},
	};
	h.ctx.modelRegistry.getAvailable = () => [h.ctx.model!];
	h.ctx.modelRegistry.complete = async () => ({
		role: "assistant",
		provider: "test",
		model: "current",
		responseModel: "writer-actual",
		api: "openai-responses",
		timestamp: 1,
		stopReason: "toolUse",
		usage,
		content: [
			{
				type: "toolCall",
				id: "author",
				name: "author_questions",
				arguments: {
					questions: {
						q: { type: "noul", instructions: "Is the task clear?" },
					},
				},
			},
		],
	});
	t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 503 }));
	await h.command("on");
	await assert.rejects(
		h.tools
			.get("jevons_decide")!
			.execute("decision", { state: "task", prompt: "Check clarity" }, undefined, undefined, h.ctx),
	);
	const patches = await h.emit("tool_result", {
		toolName: "jevons_decide",
		toolCallId: "decision",
		input: {},
		isError: true,
		content: [{ type: "text", text: "Jev failed" }],
	});
	const patch = patches.find((value) => value && typeof value === "object" && "usage" in value) as {
		usage: unknown;
		details: { status: string; writer: { model: string } };
	};
	assert.deepEqual(patch.usage, usage);
	assert.equal(patch.details.status, "failed");
	assert.equal(patch.details.writer.model, "writer-actual");
	assert.ok(!("isError" in patch));
	const repeated = await h.emit("tool_result", {
		toolName: "jevons_decide",
		toolCallId: "decision",
		input: {},
		isError: true,
	});
	assert.ok(repeated.every((value) => value === undefined));
});

for (const dialog of ["menu", "prompt", "context"] as const) {
	test(`a pending ${dialog} dialog cannot act in a replacement session`, async (t) => {
		const h = await fixture(t);
		const answer = Promise.withResolvers<string>();
		const opened = Promise.withResolvers<void>();
		const pending = async () => {
			opened.resolve();
			return answer.promise;
		};
		h.ctx.ui.select = pending;
		h.ctx.ui.input = pending;
		h.ctx.ui.editor = pending;
		let writerCalls = 0;
		h.ctx.modelRegistry.getAvailable = () => [h.ctx.model!];
		h.ctx.modelRegistry.complete = async () => {
			writerCalls++;
			throw new Error("Unexpected stale writer call");
		};
		const command = h.command(
			dialog === "menu" ? "" : dialog === "prompt" ? "ask" : "ask Check clarity",
		);
		await opened.promise;
		await h.emit("session_before_switch", { reason: "new" });
		h.session.id = "replacement";
		await h.emit("session_start", { reason: "new" });
		answer.resolve(dialog === "menu" ? "pause — Stop sharing and automation" : "Old context");
		await command;
		assert.equal(writerCalls, 0);
		// A stale menu selection must not pause the replacement session either.
		await h.tools.get("jevons_decide")!.execute(
			"fresh-decision",
			{
				state: "fresh",
				questions: {
					q: { type: "noul", instructions: "Is fresh supplied?" },
				},
			},
			undefined,
			undefined,
			h.ctx,
		);
		assert.equal(h.requests.length, 1);
	});
}

test("decision tools reject both or neither question sources before network use", async (t) => {
	const h = await fixture(t);
	for (const sources of [
		{},
		{
			prompt: "Check",
			questions: { q: { type: "noul", instructions: "Check" } },
		},
	]) {
		await assert.rejects(
			h.tools
				.get("jevons_decide")!
				.execute("invalid", { state: null, ...sources }, undefined, undefined, h.ctx),
			/Supply questions or a prompt/,
		);
	}
	assert.equal(h.requests.length, 0);
});

const toolCall = {
	toolName: "bash",
	toolCallId: "test-call",
	input: { command: "inspect database" },
};

test("explicit-only skills never enter shared candidates or selected skill context", async (t) => {
	const h = await fixture(t);
	const hidden = {
		name: "database-private",
		description: "Database private metadata",
		filePath: join(h.root, "hidden.md"),
		disableModelInvocation: true,
	};
	const visible = {
		name: "database-public",
		description: "Database guidance",
		filePath: join(h.root, "visible.md"),
	};
	await writeFile(hidden.filePath, "EXPLICIT_ONLY_BODY");
	await writeFile(visible.filePath, "PUBLIC_SKILL_BODY");
	const task = "Database maintenance";
	const event = {
		prompt: task,
		systemPrompt: "Preserve user constraints; no commits.",
		systemPromptOptions: { skills: [hidden, visible] },
	};
	await h.emit("input", { source: "interactive", text: task });
	const [result] = (await h.emit("before_agent_start", event)) as {
		systemPrompt: string;
	}[];
	assert.equal(h.requests.length, 1);
	const shared = JSON.stringify(h.requests[0]);
	assert.ok(shared.includes(visible.name));
	for (const value of [hidden.name, hidden.description, hidden.filePath, "EXPLICIT_ONLY_BODY"])
		assert.ok(!shared.includes(value));
	assert.ok(result!.systemPrompt.includes(event.systemPrompt));
	assert.ok(result!.systemPrompt.includes("PUBLIC_SKILL_BODY"));
	assert.ok(!result!.systemPrompt.includes("EXPLICIT_ONLY_BODY"));
	await h.emit("input", { source: "interactive", text: task });
	await h.emit("before_agent_start", {
		...event,
		systemPromptOptions: { skills: [hidden] },
	});
	assert.equal(h.requests.length, 1);
});

test("only delivered steering and follow-up constraints affect tool assessments", async (t) => {
	const h = await fixture(t, [], true);
	const task = "Maintain the database";
	await h.emit("input", { source: "interactive", text: task });
	await h.emit("message_start", { message: { role: "user", content: task } });
	const delivered: string[] = [];
	for (const streamingBehavior of ["steer", "followUp"]) {
		const update =
			streamingBehavior === "steer" ? "Preserve the archive" : "Do not change the schema";
		await h.emit("input", {
			source: "interactive",
			text: update,
			streamingBehavior,
		});
		await h.emit("tool_call", toolCall);
		const before = (h.requests.at(-1)!.state as { task: string }).task;
		assert.ok(!before.includes(update));
		await h.emit("message_start", {
			message: { role: "user", content: [{ type: "text", text: update }] },
		});
		await h.emit("tool_call", toolCall);
		delivered.push(update);
		const after = (h.requests.at(-1)!.state as { task: string }).task;
		for (const text of [task, ...delivered]) assert.ok(after.includes(text));
	}
	assert.equal(h.requests.length, 4);
	const feedback = h.sent.at(-1)!;
	assert.equal(feedback[0].display, true);
	assert.equal(feedback[1]?.deliverAs, "steer");
});

test("continue preserves delivered constraints and queued or handled input cannot overwrite them", async (t) => {
	const h = await fixture(t, [], true);
	const original = "Fix the parser; do not publish or delete fixtures.";
	await h.emit("input", { source: "interactive", text: "not delivered" });
	await h.emit("message_start", {
		message: { role: "user", content: original },
	});
	await h.emit("input", { source: "interactive", text: "continue" });
	await h.emit("tool_call", toolCall);
	const before = (h.requests.at(-1)!.state as { task: string }).task;
	assert.equal(before, original);
	await h.emit("message_start", {
		message: { role: "user", content: "continue" },
	});
	await h.emit("tool_call", toolCall);
	const after = (h.requests.at(-1)!.state as { task: string }).task;
	assert.ok(after.includes(original) && after.endsWith("continue"));
	assert.ok(!after.includes("not delivered"));
	const count = h.requests.length;
	await h.emit("message_start", {
		message: { role: "user", content: "x".repeat(8001) },
	});
	await h.emit("message_start", {
		message: { role: "user", content: "continue" },
	});
	await h.emit("tool_call", toolCall);
	assert.equal(h.requests.length, count);
});

for (const replacement of ["policy", "session"] as const) {
	test(`gate confirmation cannot authorize replacement ${replacement}`, async (t) => {
		const check = (name: string) => ({
			name,
			argv: [
				process.execPath,
				"--eval",
				`require('node:fs').writeFileSync('${name}', 'ran'); process.exit(1)`,
			],
			timeoutMs: 2000,
		});
		const h = await fixture(t, [check("original")]);
		const confirmation = Promise.withResolvers<boolean>();
		const prompted = Promise.withResolvers<void>();
		const pendingConfirm = t.mock.method(h.ctx.ui, "confirm", async () => {
			prompted.resolve();
			return confirmation.promise;
		});
		const pendingGate = h.command("gate");
		await prompted.promise;
		pendingConfirm.mock.restore();
		await writeFile(
			join(h.root, "jevons.json"),
			JSON.stringify({ checks: [check("replacement")] }),
		);
		if (replacement === "session") {
			await h.emit("session_before_switch", { reason: "new" });
			h.session.id = "second";
			await h.emit("session_start", { reason: "new" });
		}
		await h.command("on");
		confirmation.resolve(true);
		await pendingGate;
		const files = await readdir(h.root);
		assert.ok(!files.includes("original") && !files.includes("replacement"));
		await h.command("gate");
		assert.equal(await readFile(join(h.root, "replacement"), "utf8"), "ran");
		assert.ok(!(await readdir(h.root)).includes("original"));
		assert.equal(h.requests.length, 0);
	});
}

test("administrative replies are displayed without waiting for another user turn", async (t) => {
	const h = await fixture(t);
	for (const action of ["settings", "usage", "activity"]) {
		const before = h.sent.length;
		await h.command(action);
		assert.equal(h.sent.length, before + 1);
		const [message, options] = h.sent.at(-1)!;
		assert.equal(message.display, true);
		assert.ok(message.content.length > 0);
		assert.notEqual(options?.deliverAs, "nextTurn");
		assert.equal(options?.triggerTurn, false);
	}
	assert.equal(h.requests.length, 0);
});
