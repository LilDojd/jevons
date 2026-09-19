import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "../src/checks.ts";
import { runChecks } from "../src/checks.ts";
import type { DiffSnapshot } from "../src/contracts.ts";
import { selectVerification } from "../src/verification.ts";
import { collectLocalDiff } from "./diff.ts";
import { safeText } from "./presentation.ts";
import type { Runtime } from "./runtime.ts";

export interface VerificationRun {
	status: "passed" | "failed" | "stale" | "unverified";
	results: CheckResult[];
	selection: Awaited<ReturnType<typeof selectVerification>>;
	fingerprint?: string;
	comparison?: string;
	taskRevision: number;
	observedAt: number;
	omitted: string[];
}

export async function verifyConfigured(
	ctx: ExtensionContext,
	runtime: Runtime,
): Promise<VerificationRun | undefined> {
	if (!ctx.hasUI) return;
	const evaluate = runtime.evaluator(ctx, "Verification selection");
	const configuredPolicy = runtime.policy;
	if (!configuredPolicy) throw new Error("Jev policy unavailable.");
	const policy = structuredClone(configuredPolicy);
	const signal = runtime.controller.signal;
	const taskRevision = runtime.taskRevision;
	const sessionId = runtime.sessionId;
	const cwd = ctx.cwd;
	const current = () =>
		runtime.policy === configuredPolicy &&
		runtime.controller.signal === signal &&
		runtime.taskRevision === taskRevision &&
		runtime.sessionId === sessionId &&
		ctx.sessionManager.getSessionId() === sessionId &&
		ctx.cwd === cwd;
	const requireCurrent = () => {
		signal.throwIfAborted();
		if (!current())
			throw new Error(
				"Verification context changed. No checks started. Request confirmation again.",
			);
	};
	if (!policy.checks.length) throw new Error("No executable checks configured in jevons.json.");
	const omitted: string[] = [];
	let snapshot: DiffSnapshot | undefined;
	try {
		// Verification concerns the entire workspace, not only the requested review paths.
		snapshot = await collectLocalDiff(ctx.cwd, [], signal);
		omitted.push(...snapshot.omitted);
	} catch {
		signal.throwIfAborted();
		omitted.push(
			"Workspace diff unavailable. All checks remain eligible. Jevons cannot confirm that results apply to the current workspace.",
		);
	}
	if (runtime.taskOmitted)
		omitted.push("Task evidence is incomplete. Optional checks cannot be excluded.");
	const selection = await selectVerification(
		policy.checks,
		{
			task: runtime.task,
			diff: snapshot?.chunks.map((chunk) => `${chunk.path}\n${chunk.patch}`).join("\n") ?? "",
			omitted,
		},
		policy.verification,
		evaluate,
		signal,
	);
	requireCurrent();
	if (
		!(await ctx.ui.confirm(
			"Run configured project code?",
			safeText(
				[
					...selection.selected.map(
						(check) =>
							`${check.mandatory !== false ? "Mandatory" : "Optional"} · ${JSON.stringify(check.name)}: ${JSON.stringify(check.argv)}`,
					),
					...selection.selections
						.filter((check) => !check.selected)
						.map((check) => `Not run · ${JSON.stringify(check.name)}: ${check.reason}`),
					"Commands execute with your account permissions. Jev relevance judgments do not authorize execution.",
				].join("\n"),
			),
			{ signal },
		))
	)
		return;
	requireCurrent();
	if (snapshot && (await collectLocalDiff(cwd, [], signal)).fingerprint !== snapshot.fingerprint)
		throw new Error("Workspace changed during confirmation. No checks started.");
	requireCurrent();
	const results = await runChecks(cwd, selection.selected, signal);
	signal.throwIfAborted();
	let stale = !current();
	if (snapshot) {
		try {
			stale ||= (await collectLocalDiff(cwd, [], signal)).fingerprint !== snapshot.fingerprint;
		} catch {
			signal.throwIfAborted();
			stale = true;
		}
	}
	stale ||= !current();
	signal.throwIfAborted();
	if (stale)
		omitted.push(
			"The workspace or task changed. Check results describe the earlier state. They do not verify the current state.",
		);
	// A failed Jev request can deactivate sharing without revoking separately confirmed execution.
	return {
		status: stale
			? "stale"
			: results.some((result) => !result.passed)
				? "failed"
				: results.length && snapshot && !snapshot.omitted.length
					? "passed"
					: "unverified",
		results,
		selection,
		fingerprint: snapshot?.fingerprint,
		comparison: snapshot?.comparison,
		taskRevision,
		observedAt: Date.now(),
		omitted: [...new Set([...omitted, ...selection.omitted])],
	};
}

export function formatVerification(run: VerificationRun): string {
	return [
		`Verification: ${run.status} · ${run.results.length} checks run`,
		...run.results.map(
			(result) =>
				`${result.name}: ${result.passed ? "passed" : "FAILED"} · exit ${result.exitCode ?? "unknown"} · ${result.termination} · ${result.elapsedMs}ms${result.omittedBytes ? ` · ${result.omittedBytes} output bytes omitted` : ""}`,
		),
		...run.selection.selections
			.filter((check) => !check.selected)
			.map((check) => `${check.name}: not run · ${check.reason}`),
		...run.omitted.map((reason) => `Coverage: ${reason}`),
	].join("\n");
}
