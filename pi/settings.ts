import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import type { SettingItem } from "@earendil-works/pi-tui";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
import type { Policy } from "../src/contracts.ts";
import { defaultPolicy } from "./policy.ts";
import { loadPreferences, preferencesOf } from "./preferences.ts";
import { safeText } from "./presentation.ts";
import type { Runtime } from "./runtime.ts";

const fields = [
	[
		"autopilot",
		"skills",
		"Skill guidance",
		"Select useful skills for the next task.",
		["on", "off"],
	],
	[
		"autopilot",
		"models",
		"Model routing",
		"Suggest or switch among configured profiles. Eligibility checks still apply.",
		["off", "suggest", "switch"],
	],
	[
		"autopilot",
		"tools",
		"Pre-tool feedback",
		"Give optional advice on proposed calls. This advice never grants execution permission.",
		["off", "on"],
	],
	[
		"recovery",
		"mode",
		"Failure recovery",
		"Mode shadow records judgments. Mode steer permits bounded replan/ask-user messages.",
		["off", "shadow", "steer"],
	],
	[
		"verification",
		"select",
		"Select optional checks",
		"Use Jev relevance judgments. Mandatory checks and execution confirmation remain required.",
		["on", "off"],
	],
	[
		"autopilot",
		"threshold",
		"Skill / model threshold",
		"Minimum described utility or preference for automatic selection.",
		["0.5", "0.6", "0.7", "0.8", "0.9", "0.95", "1"],
	],
	[
		"recovery",
		"retryConcern",
		"Recovery retry threshold",
		"Minimum concern for a focused replan.",
		["0.7", "0.8", "0.85", "0.9", "0.95", "1"],
	],
	[
		"recovery",
		"userConcern",
		"Recovery user threshold",
		"Minimum concern for a user-only blocker.",
		["0.7", "0.8", "0.85", "0.9", "0.95", "1"],
	],
	[
		"recovery",
		"cooldownTurns",
		"Recovery cooldown (turns)",
		"Completed turns between interventions.",
		["1", "2", "3", "5", "10"],
	],
	[
		"recovery",
		"maxInterventions",
		"Recovery session cap",
		"Changes do not reset the count of interventions already used.",
		["1", "2", "3", "4", "5"],
	],
	[
		"verification",
		"relevance",
		"Check relevance threshold",
		"Uncertain optional checks stay selected.",
		["0.5", "0.6", "0.7", "0.8", "0.9", "1"],
	],
] as const;

type Field = (typeof fields)[number];
function settingValue(policy: Policy, field: Field): boolean | number | string {
	const [group, key] = field;
	switch (group) {
		case "autopilot":
			return policy.autopilot[key];
		case "recovery":
			return policy.recovery[key];
		case "verification":
			return policy.verification[key];
	}
}
const displayValue = (value: unknown) =>
	typeof value === "boolean" ? (value ? "on" : "off") : String(value);

export function settingsItems(policy: Policy): SettingItem[] {
	return fields.map((field) => {
		const currentValue = displayValue(settingValue(policy, field));
		return {
			id: `${field[0]}.${field[1]}`,
			label: field[2],
			description: field[3],
			currentValue,
			values: [...new Set([...field[4], currentValue])],
		};
	});
}

export function changeSetting(policy: Policy, id: string, value: string): Policy {
	const field = fields.find((field) => `${field[0]}.${field[1]}` === id);
	if (
		!field ||
		!settingsItems(policy)
			.find((item) => item.id === id)
			?.values?.includes(value)
	)
		throw new Error("Unknown settings selection.");
	const next = structuredClone(policy);
	const previous = settingValue(policy, field);
	Object.assign(next[field[0]], {
		[field[1]]:
			typeof previous === "boolean"
				? value === "on"
				: typeof previous === "number"
					? Number(value)
					: value,
	});
	return next;
}

type Action = "advanced" | "writer" | "reset";

export async function openSettings(ctx: ExtensionContext, runtime: Runtime): Promise<void> {
	if (!ctx.hasUI) throw new Error("Use /jevons settings in an interactive Pi session.");
	if (!ctx.isProjectTrusted()) throw new Error("Trust the project before editing Jevons settings.");
	let controller = runtime.controller;
	const cwd = ctx.cwd;
	const session = ctx.sessionManager.getSessionId();
	const fresh = () =>
		controller === runtime.controller &&
		ctx.isProjectTrusted() &&
		ctx.cwd === cwd &&
		ctx.sessionManager.getSessionId() === session;
	let persistedPreferences = loadPreferences(runtime.agentDir);
	let policy = await runtime.readPolicy(ctx);
	const apply = (next: unknown) => {
		if (!fresh()) throw new Error("Settings context changed. Reopen settings.");
		// Detect intervening saves from other sessions; this is not filesystem compare-and-swap.
		if (!isDeepStrictEqual(persistedPreferences, loadPreferences(runtime.agentDir)))
			throw new Error("User preferences changed in another session. Reopen settings.");
		policy = runtime.updateSettings(ctx, next);
		persistedPreferences = preferencesOf(policy);
		controller = runtime.controller;
	};
	while (fresh()) {
		// RPC supports native dialogs, but not custom terminal components.
		const action =
			ctx.mode === "tui"
				? await ctx.ui.custom<Action | undefined>((tui, theme, keys, done) => {
						const container = new Container();
						const heading = new Text("", 1, 0);
						const updateHeading = () =>
							heading.setText(
								theme.fg("accent", `Jevons settings · ${runtime.active ? "on" : "paused"}`),
							);
						updateHeading();
						container.addChild(heading);
						container.addChild(
							new Text(
								"User preferences follow you across sessions and projects. Saved in the Pi agent directory, outside settings.json. Checks and profiles stay in project jevons.json. Changes cancel active Jev work and checks; paused stays paused.",
								1,
								1,
							),
						);
						const list = new SettingsList(
							[
								...settingsItems(policy),
								{
									id: "writer",
									label: "Question writer",
									currentValue: safeText(
										policy.writer
											? `${policy.writer.provider}/${policy.writer.model}`
											: "Current coding model",
									),
									values: ["choose"],
									description:
										"Free-text questions share explicit context with this provider at its normal cost.",
								},
								{
									id: "advanced",
									label: "Edit user preferences (JSON)",
									currentValue: "open",
									values: ["open"],
									description:
										"Exact thresholds, Jev model and writer. No credentials, execution permissions or project configuration.",
								},
								{
									id: "reset",
									label: "Reset user preferences",
									currentValue: "reset",
									values: ["reset"],
									description:
										"Save built-in preference defaults for all new sessions. Project checks and profiles remain unchanged.",
								},
							],
							Math.min(18, Math.max(4, tui.terminal.rows - 10)),
							getSettingsListTheme(),
							(id, value) => {
								if (!fresh()) {
									done(undefined);
									return;
								}
								if (id === "advanced" || id === "writer" || id === "reset") {
									done(id);
									return;
								}
								try {
									apply(preferencesOf(changeSetting(policy, id, value)));
								} catch (error) {
									const previous = settingsItems(policy).find((item) => item.id === id);
									if (previous) list.updateValue(id, previous.currentValue);
									ctx.ui.notify(
										safeText(error instanceof Error ? error.message : "Settings unchanged."),
										"error",
									);
								}
								updateHeading();
								tui.requestRender();
							},
							() => done(undefined),
							{ enableSearch: true },
						);
						container.addChild(list);
						container.addChild(
							new Text(
								`${keys.getKeys("tui.select.confirm").join("/")} change · ${keys.getKeys("tui.select.cancel").join("/")} close (changes kept) · type to search`,
								1,
								1,
							),
						);
						return {
							render: (width) => container.render(width),
							invalidate: () => {
								updateHeading();
								container.invalidate();
							},
							handleInput: (data) => {
								if (!fresh()) {
									done(undefined);
									return;
								}
								list.handleInput(data);
								tui.requestRender();
							},
						};
					})
				: "advanced";
		if (!fresh() || !action) return;
		if (action === "writer") {
			const models = ctx.modelRegistry.getAvailable();
			const labels = [
				"Current coding model",
				...models.map((model) => safeText(`${model.provider}/${model.id}`)),
			];
			const selected = await ctx.ui.select("Question writer", labels);
			if (!fresh()) return;
			if (selected !== undefined) {
				const next = structuredClone(policy);
				const index = labels.indexOf(selected);
				if (index === 0) delete next.writer;
				else {
					const model = models[index - 1];
					if (!model) continue;
					next.writer = { provider: model.provider, model: model.id };
				}
				apply(preferencesOf(next));
			}
		} else if (action === "reset") {
			const confirmed = await ctx.ui.confirm(
				"Reset user preferences?",
				"Save built-in preference defaults for all new sessions. Project files, usage and intervention counts remain unchanged. Paused sessions stay paused.",
			);
			if (!fresh()) return;
			if (confirmed) apply(preferencesOf(defaultPolicy));
		} else {
			let text = JSON.stringify(preferencesOf(policy), null, 2);
			while (fresh()) {
				const edited = await ctx.ui.editor(
					"Jevons user preferences · Save persists across sessions. Checks and profiles are project-only.",
					text,
				);
				if (!fresh() || edited === undefined) break;
				text = edited;
				try {
					if (Buffer.byteLength(text) > 32000) throw new Error("Settings exceed 32 KiB.");
					let input: unknown;
					try {
						input = JSON.parse(text);
					} catch {
						throw new Error("Invalid JSON. Settings unchanged.");
					}
					apply(input);
					ctx.ui.notify("User preferences saved. Project files unchanged.", "info");
					break;
				} catch (error) {
					ctx.ui.notify(
						safeText(error instanceof Error ? error.message : "Settings unchanged."),
						"error",
					);
				}
			}
			if (ctx.mode !== "tui") return;
		}
	}
}
