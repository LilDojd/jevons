import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPreferences, savePreferences } from "../pi/preferences.ts";

test("user preferences validate before publication, reject project authority and leave unrelated files alone", async (t) => {
	const agentDir = await mkdtemp(join(tmpdir(), "jevons-preferences-"));
	t.after(() => rm(agentDir, { recursive: true, force: true }));
	const path = join(agentDir, "jevons.json");
	const managed = join(agentDir, "settings.json");
	await writeFile(managed, "managed configuration");
	assert.equal(loadPreferences(agentDir), undefined);
	assert.deepEqual(await readdir(agentDir), ["settings.json"]);
	savePreferences(agentDir, {
		autopilot: { skills: false },
		writer: { provider: "test", model: "writer" },
	});
	const before = await readFile(path, "utf8");
	assert.equal(loadPreferences(agentDir)!.autopilot.skills, false);
	assert.equal((await stat(path)).mode & 0o777, 0o600);
	for (const invalid of [
		null,
		[],
		{ active: true },
		{ checks: [] },
		{ profiles: [] },
		{ model: "x".repeat(32001) },
		{ compaction: {} },
	]) {
		assert.throws(() => savePreferences(agentDir, invalid));
		assert.equal(await readFile(path, "utf8"), before);
	}
	savePreferences(agentDir, {});
	assert.equal(loadPreferences(agentDir)!.writer, undefined);
	assert.equal(await readFile(managed, "utf8"), "managed configuration");
	assert.deepEqual((await readdir(agentDir)).sort(), ["jevons.json", "settings.json"]);
	for (const invalid of ["null", "not json", " ".repeat(32001), '{"checks":[]}']) {
		await writeFile(path, invalid);
		assert.throws(() => loadPreferences(agentDir));
	}
	await rm(path);
	await symlink(managed, path);
	assert.throws(() => loadPreferences(agentDir));
	savePreferences(agentDir, {});
	assert.equal(await readFile(managed, "utf8"), "managed configuration");
	assert.equal((await stat(path)).isFile(), true);
});
