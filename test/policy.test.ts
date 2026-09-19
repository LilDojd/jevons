import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPolicy } from "../pi/policy.ts";

test("policy defaults keep intervention experiments opt-in and preserve described checks", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jevons-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const defaults = await loadPolicy(root);
	assert.equal(defaults.recovery.mode, "shadow");
	assert.equal(defaults.review.investigate, false);
	assert.equal(defaults.autopilot.tools, false);
	const checks = [
		{
			name: "docs",
			argv: ["check-docs"],
			timeoutMs: 1000,
			mandatory: false,
			description: "Documentation links",
		},
	];
	await writeFile(
		join(root, "jevons.json"),
		JSON.stringify({
			checks,
			review: { investigate: true },
		}),
	);
	const configured = await loadPolicy(root);
	assert.deepEqual(configured.checks, checks);
	assert.equal(configured.review.investigate, true);
});

test("obsolete budgets and invalid execution-selection configuration fail closed", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "jevons-policy-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	for (const policy of [
		{ compaction: { automatic: true } },
		null,
		{ budget: { sessionTokens: 10 } },
		{ verification: { relevance: 2 } },
		{ checks: [{ name: "test", argv: [], timeoutMs: 1000 }] },
		{ review: { investigate: "yes" } },
	]) {
		await writeFile(join(root, "jevons.json"), JSON.stringify(policy));
		await assert.rejects(loadPolicy(root));
	}
});
