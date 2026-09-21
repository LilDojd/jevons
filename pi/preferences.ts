import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "../src/contracts.ts";
import { parsePolicy, readSettingsFile } from "./policy.ts";

export type Preferences = Omit<Policy, "checks" | "profiles">;

export function preferencesOf(policy: Policy): Preferences {
	const { checks: _checks, profiles: _profiles, ...preferences } = structuredClone(policy);
	return preferences;
}

export function parsePreferences(input: unknown): Preferences {
	if (input && typeof input === "object") {
		const raw = input as Record<string, unknown>;
		if (Object.hasOwn(raw, "checks") || Object.hasOwn(raw, "profiles"))
			throw new Error("Checks and profiles belong in project jevons.json, not user preferences.");
	}
	return preferencesOf(parsePolicy(input));
}

export function applyPreferences(project: Policy, preferences: Preferences): Policy {
	const policy = parsePolicy({
		...project,
		...preferences,
	});
	if (!preferences.writer) delete policy.writer;
	return policy;
}

export function loadPreferences(agentDir: string): Preferences | undefined {
	const input = readSettingsFile(join(agentDir, "jevons.json"));
	return input === undefined ? undefined : parsePreferences(input);
}

export function savePreferences(agentDir: string, input: unknown): void {
	const preferences = parsePreferences(input);
	const text = `${JSON.stringify(preferences)}\n`;
	if (Buffer.byteLength(text) > 32000) throw new Error("Jevons preferences exceed 32 KiB.");
	mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const temporary = join(agentDir, `.jevons-${randomUUID()}.tmp`);
	// Same-directory rename publishes a complete validated snapshot before runtime changes.
	try {
		writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
		renameSync(temporary, join(agentDir, "jevons.json"));
	} finally {
		rmSync(temporary, { force: true });
	}
}
