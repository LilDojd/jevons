import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { parseDiff } from "../pi/diff.ts";
import { registerInvestigation } from "../pi/investigation.ts";
import { defaultPolicy } from "../pi/policy.ts";
import type { Runtime } from "../pi/runtime.ts";
import type { DiffSnapshot } from "../src/contracts.ts";
import { reviewDiff } from "../src/diff-review.ts";
import { selectConcern } from "../src/investigation.ts";

type Handler = (event: Record<string, unknown>, ctx: ExtensionContext) => unknown;
async function fixture() {
	const root = "/project";
	const snapshot = parseDiff(
		[
			"diff --git a/source.ts b/source.ts",
			"--- a/source.ts",
			"+++ b/source.ts",
			"@@ -1 +1 @@",
			"-old",
			"+SOURCE_EVIDENCE",
			"",
		].join("\n"),
		`jj ${root} ${"a".repeat(40)}..working-copy`,
	);
	const report = await reviewDiff(snapshot, defaultPolicy.review, async (request) => ({
		model: "jev-actual-version",
		usage: { input_tokens: 1, output_tokens: 1 },
		elapsedMs: 1,
		answers: Object.fromEntries(
			Object.keys(request.questions).map((key) => [key, { type: "noul" as const, noul: 0.95 }]),
		),
	}));
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({
		role: "user",
		content: "Investigate only",
		timestamp: 1,
	});
	const handlers = new Map<string, Handler[]>();
	const sent: Parameters<ExtensionAPI["sendMessage"]>[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			manager.appendCustomEntry(customType, data);
		},
		sendMessage(...args: Parameters<ExtensionAPI["sendMessage"]>) {
			sent.push(args);
			const message = args[0];
			manager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
		},
	} as unknown as ExtensionAPI;
	const abort = new AbortController();
	const ctx = {
		cwd: root,
		sessionManager: manager,
		signal: abort.signal,
		isProjectTrusted: () => true,
		isIdle: () => true,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const runtime = {
		active: true,
		taskRevision: 1,
		taskOmitted: false,
		policy: structuredClone(defaultPolicy),
		controller: new AbortController(),
		sessionId: manager.getSessionId(),
		evaluator: () => {
			throw new Error("No second evaluator call is allowed.");
		},
	} as unknown as Runtime;
	runtime.policy!.review.investigate = true;
	let investigate = registerInvestigation(pi, runtime);
	return {
		snapshot,
		report,
		ctx,
		runtime,
		manager,
		sent,
		abort,
		run: (recheck = async () => snapshot) => investigate(report, ctx, recheck),
		reload() {
			handlers.clear();
			investigate = registerInvestigation(pi, runtime);
		},
		async emit(name: string, event: Record<string, unknown> = {}) {
			let result: unknown;
			for (const handler of handlers.get(name) ?? []) result = await handler(event, ctx);
			return result as { messages: unknown[] } | undefined;
		},
		messages: () => sent.map(([message]) => ({ ...message, role: "custom", timestamp: 1 })),
	};
}

test("highest supported concern is deterministic, preserves actual model and raw probability", async () => {
	const { report } = await fixture();
	const finding = report.findings[0]!;
	report.findings.push({ ...finding, id: "unmapped", probability: 1 });
	const chosen = selectConcern(report, 0.9)!;
	assert.equal(chosen.finding.id, finding.id);
	assert.equal(chosen.model, "jev-actual-version");
	assert.equal(chosen.finding.probability, 0.95);
	report.findings.reverse();
	assert.deepEqual(selectConcern(report, 0.9), chosen);
	assert.equal(selectConcern(report, 0.96), undefined);
	assert.equal(selectConcern(report, Number.NaN), undefined);
	report.evaluations[0]!.answers = {};
	assert.equal(selectConcern(report, 0.9), undefined);
});

test("reuses exactly one reviewed patch in one turn; source-free cap survives policy changes and reload", async () => {
	const h = await fixture();
	await Promise.all([h.run(), h.run()]);
	assert.equal(h.sent.length, 1);
	assert.deepEqual(h.sent[0]![1], { deliverAs: "followUp", triggerTurn: true });
	const content = h.sent[0]![0].content as string;
	const evidence = JSON.parse(content.split("\n").at(-1)!);
	assert.deepEqual(evidence.chunk, h.snapshot.chunks[0]);
	assert.equal(evidence.model, "jev-actual-version");
	assert.equal(evidence.probability, 0.95);
	assert.equal(evidence.otherFindingsNotInvestigated, h.report.findings.length - 1);
	const checkpoints = h.manager.getEntries().filter((entry) => entry.type === "custom");
	assert.equal(checkpoints.length, 1);
	assert.ok(!JSON.stringify(checkpoints).includes("SOURCE_EVIDENCE"));
	h.runtime.policy!.review.investigate = false;
	await h.run();
	h.runtime.policy = structuredClone(h.runtime.policy!);
	h.runtime.policy.review.investigate = true;
	h.runtime.policy.review.investigateConcern = 0.8;
	h.runtime.controller = new AbortController();
	h.reload();
	await h.emit("session_start");
	await h.run();
	assert.equal(h.sent.length, 1);
	assert.equal((await h.emit("context", { messages: h.messages() }))!.messages.length, 0);
	h.report.fingerprint = h.snapshot.fingerprint = "f".repeat(64);
	await h.run();
	assert.equal(h.sent.length, 2);
});

test("explicit enable, trust, idle, task completeness and threshold gate investigation", async () => {
	const h = await fixture();
	h.runtime.policy!.review.investigate = false;
	await h.run();
	h.runtime.policy!.review.investigate = true;
	h.ctx.isProjectTrusted = () => false;
	await h.run();
	h.ctx.isProjectTrusted = () => true;
	h.ctx.isIdle = () => false;
	await h.run();
	h.ctx.isIdle = () => true;
	h.runtime.taskOmitted = true;
	await h.run();
	h.runtime.taskOmitted = false;
	h.runtime.policy!.review.investigateConcern = 0.99;
	await h.run();
	assert.equal(h.sent.length, 0);
	assert.equal(h.manager.getEntries().filter((entry) => entry.type === "custom").length, 0);
});

for (const change of [
	"task",
	"policy",
	"controller",
	"session",
	"branch",
	"hash",
	"abort",
] as const) {
	test(`post-recheck ${change} invalidation suppresses delivery and cannot retry unchanged snapshot`, async () => {
		const h = await fixture();
		await h.run(async () => {
			if (change === "task") h.runtime.taskRevision++;
			if (change === "policy") h.runtime.policy!.review.investigateConcern = 0.8;
			if (change === "controller") h.runtime.controller = new AbortController();
			if (change === "session") h.runtime.sessionId = "replacement";
			if (change === "branch") await h.emit("session_before_tree");
			if (change === "abort") h.abort.abort();
			return change === "hash" ? { ...h.snapshot, fingerprint: "changed" } : h.snapshot;
		});
		assert.equal(h.sent.length, 0);
		await h.run();
		assert.equal(h.sent.length, 0);
	});
}

test("native read can retain advisory; later context hash mismatch removes it", async () => {
	const h = await fixture();
	await h.run();
	assert.equal((await h.emit("context", { messages: h.messages() }))!.messages.length, 1);
	await h.emit("tool_call", { toolName: "read", input: { path: "source.ts" } });
	assert.equal((await h.emit("context", { messages: h.messages() }))!.messages.length, 1);
	h.snapshot.fingerprint = "changed";
	assert.equal((await h.emit("context", { messages: h.messages() }))!.messages.length, 0);
});

test("context checks task freshness again after async snapshot collection", async () => {
	const h = await fixture();
	let calls = 0;
	await h.run(async () => {
		if (++calls > 1) h.runtime.taskRevision++;
		return h.snapshot;
	});
	assert.equal((await h.emit("context", { messages: h.messages() }))!.messages.length, 0);
});

test("incomplete reports and remote reports never trigger or reserve investigation", async () => {
	for (const change of ["partial", "omitted", "remote"] as const) {
		const h = await fixture();
		if (change === "partial") h.report.complete = false;
		if (change === "omitted") h.report.omitted.push("Untracked files omitted");
		if (change === "remote") h.report.comparison = "github owner/repo#1 base...head";
		await h.run(async () => {
			throw new Error("Must not collect");
		});
		assert.equal(h.sent.length, 0);
		assert.equal(h.manager.getEntries().filter((entry) => entry.type === "custom").length, 0);
	}
});

test("fresh snapshot must have complete coverage and one exact ID/path bounded chunk", async () => {
	for (const change of ["omitted", "id", "path", "duplicate", "oversized"] as const) {
		const h = await fixture();
		const changed = structuredClone(h.snapshot);
		if (change === "omitted") changed.omitted.push("Sensitive source omitted");
		if (change === "id") changed.chunks[0]!.id = "other";
		if (change === "path") changed.chunks[0]!.path = "other.ts";
		if (change === "duplicate") changed.chunks.push(changed.chunks[0]!);
		if (change === "oversized") changed.chunks[0]!.patch = "🦄".repeat(2001);
		await h.run(async () => changed);
		assert.equal(h.sent.length, 0);
		await h.run();
		assert.equal(h.sent.length, 0);
	}
});

test("unavailable recheck is source-free and cancellation stops waiting for an uncooperative callback", async () => {
	const failed = await fixture();
	await failed.run(async () => {
		throw new Error("PRIVATE_SOURCE");
	});
	const entries = failed.manager.getEntries().filter((entry) => entry.type === "custom");
	assert.equal(entries.length, 2);
	assert.equal((entries.at(-1) as { data: { status: string } }).data.status, "unavailable");
	assert.ok(!JSON.stringify(entries).includes("PRIVATE_SOURCE"));
	await failed.run();
	assert.equal(failed.sent.length, 0);
	const h = await fixture();
	const started = Promise.withResolvers<void>();
	const pending = h.run(() => {
		started.resolve();
		return new Promise<DiffSnapshot>(() => {});
	});
	await started.promise;
	h.abort.abort();
	await pending;
	assert.equal(h.sent.length, 0);
});
