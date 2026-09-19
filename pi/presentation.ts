import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Answer, Evaluation, Question, Request } from "../src/contracts.ts";
import type { DiffReport } from "../src/diff-review.ts";
import type { AuthoredQuestions } from "./author.ts";
import type { Receipt } from "./service.ts";
import type { VerificationRun } from "./verify.ts";

export function safeText(text: string): string {
	return text.replace(
		/(?!\n)[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

const label = (text: string) => safeText(text).replaceAll("\n", "\\n");
const indent = (text: string) =>
	safeText(text)
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");
const section = (title: string, body: string) => `${title}\n${indent(body)}`;
type Writer = Omit<AuthoredQuestions, "questions">;
const ownValue = <T>(record: Record<string, T>, key: string): T | undefined =>
	Object.hasOwn(record, key) ? record[key] : undefined;

export interface DecisionDetails {
	request?: Request;
	questions?: Request["questions"];
	writer?: Writer;
	result?: Evaluation;
	status?: string;
}

function writerDetails(writer?: Writer): string {
	if (!writer) return "Writer: not recorded (typed questions do not need a writer).";
	const { usage } = writer;
	return section(
		"Writer",
		[
			`Actual model: ${label(writer.model)}`,
			`Time: ${writer.elapsedMs}ms`,
			`Tokens: ${usage.totalTokens} total · ${usage.input} input · ${usage.output} output`,
			`Cache tokens: ${usage.cacheRead} read · ${usage.cacheWrite} write`,
			`Reported cost: ${usage.cost.total} total · ${usage.cost.input} input · ${usage.cost.output} output · ${usage.cost.cacheRead} cache read · ${usage.cost.cacheWrite} cache write`,
		].join("\n"),
	);
}

function jevDetails(result?: Evaluation): string {
	return result
		? section(
				"Jev",
				`Actual model: ${label(result.model)}\nTime: ${result.elapsedMs}ms\nTokens: ${result.usage.input_tokens + result.usage.output_tokens} total · ${result.usage.input_tokens} input · ${result.usage.output_tokens} output`,
			)
		: "Jev: no completed evaluation recorded. No judgment available.";
}

function answerSummary(answer: Answer): string {
	if (answer.type === "noul") return `P(true) = ${answer.noul}`;
	if (answer.type === "choice")
		return `${label(answer.choice)} · P = ${answer.probabilities[answer.choice] ?? "missing"}`;
	return `score = ${answer.score}`;
}

export function formatEvaluation(result: Evaluation, _request?: Request, writer?: Writer): string {
	const answers = Object.entries(result.answers);
	return safeText(
		[
			...(writer
				? [
						`Writer ${label(writer.model)} · ${writer.usage.totalTokens} tokens · ${writer.elapsedMs}ms`,
					]
				: []),
			`Jev ${label(result.model)} · ${result.usage.input_tokens + result.usage.output_tokens} tokens · ${result.elapsedMs}ms`,
			...answers.slice(0, 6).map(([id, answer]) => `${label(id)}: ${answerSummary(answer)}`),
			...(answers.length > 6
				? [`${answers.length - 6} more answers. Expand for all questions and distributions.`]
				: []),
		].join("\n"),
	);
}

function answerDetails(answer?: Answer): string {
	if (!answer) return "Answer: missing; not assessed.";
	if (answer.type === "noul") return `Raw probability: P(true) = ${answer.noul}`;
	return [
		`Answer: ${answerSummary(answer)}`,
		`Confidence: ${answer.confidence}`,
		"Distribution (raw probabilities):",
		...Object.entries(answer.probabilities).map(([key, value]) => `  ${label(key)}: ${value}`),
	].join("\n");
}

function questionDetails(id: string, question: Question | undefined, answer?: Answer): string {
	const criteria = question?.criteria;
	return section(
		`${label(id)} · ${question?.type ?? answer?.type ?? "unknown"}`,
		[
			question ? `Question:\n${indent(question.instructions)}` : "Question: not retained.",
			criteria
				? `Criteria${question?.type === "score" ? " (ordered score levels)" : ""}:\n${Object.entries(
						criteria,
					)
						.map(([key, value]) => indent(`${label(key)}: ${value}`))
						.join("\n")}`
				: "Criteria: not supplied or not retained.",
			answerDetails(answer),
		].join("\n"),
	);
}

// State is normally bounded at admission. Restored or foreign details may not be.
function readableState(value: unknown): string {
	let remaining = 48_000;
	let nodes = 2000;
	const lines: string[] = [];
	function visit(item: unknown, name: string, depth: number): void {
		nodes--;
		const prefix = "  ".repeat(depth) + name;
		if (item !== null && typeof item === "object") {
			const entries = Object.entries(item);
			lines.push(
				prefix +
					(Array.isArray(item)
						? ` (${entries.length} items)`
						: entries.length
							? ""
							: " (empty object)"),
			);
			if (depth >= 24) {
				lines.push(`${prefix} [omitted: ${entries.length} fields at display depth limit]`);
				return;
			}
			for (const [index, [key, child]] of entries.entries()) {
				if (nodes <= 0 || remaining <= 0) {
					lines.push(
						`${prefix} [omitted: ${entries.length - index} fields at display limit; full data remains in the session]`,
					);
					break;
				}
				const keyText = label(key);
				const shownKey = keyText.slice(0, Math.max(0, remaining));
				remaining -= shownKey.length;
				visit(
					child,
					`${shownKey}${shownKey.length < keyText.length ? " [key omitted]" : ""}:`,
					depth + 1,
				);
			}
			return;
		}
		const text = safeText(item === undefined ? "not retained" : String(item));
		const shown = text.slice(0, Math.max(0, remaining));
		remaining -= shown.length;
		lines.push(`${prefix} ${shown.replaceAll("\n", `\n${"  ".repeat(depth + 1)}`)}`);
		if (shown.length < text.length)
			lines.push(
				`${prefix} [omitted: ${text.length - shown.length} characters at display limit; full data remains in the session]`,
			);
	}
	visit(value, "State:", 0);
	return lines.join("\n");
}

export function formatDecisionDetails(details?: DecisionDetails): string {
	const questions = details?.request?.questions ?? details?.questions ?? {};
	const answers = details?.result?.answers ?? {};
	const ids = [...new Set([...Object.keys(questions), ...Object.keys(answers)])];
	return [
		`Decision: ${label(details?.status ?? (details?.result ? "completed" : "unavailable"))}`,
		writerDetails(details?.writer),
		jevDetails(details?.result),
		details?.request
			? readableState(details.request.state)
			: "State: not retained in these details.",
		section(
			"Questions and answers",
			ids.length
				? ids
						.map((id) => questionDetails(id, ownValue(questions, id), ownValue(answers, id)))
						.join("\n\n")
				: "No questions or answers retained.",
		),
		"Model judgments are not proof or authorization.",
	].join("\n\n");
}

const range = (start: number, count: number) =>
	count ? `${start}–${start + count - 1} (${count} lines)` : `${start} (no lines)`;

export function formatReviewDetails(report?: DiffReport): string {
	if (!report) return "Review details: unavailable. No coverage established.";
	return [
		section(
			"Review coverage",
			[
				`Status: ${report.status} · ${report.complete ? "complete" : "PARTIAL — not a clean review"}`,
				`Changed chunks: ${report.reviewedChunks}/${report.totalChunks} fully reviewed`,
				`Comparison: ${label(report.comparison)}`,
				`Fingerprint: ${label(report.fingerprint)}`,
				`Files (${report.files.length}):\n${report.files.map(label).join("\n") || "none"}`,
			].join("\n"),
		),
		section(
			`Findings (${report.findings.length})`,
			report.findings
				.map((finding) =>
					[
						`${label(finding.path)} [${label(finding.id)}] · ${finding.status} · raw P(concern) = ${finding.probability}`,
						`Old: ${label(finding.oldPath)} · ${range(finding.oldStart, finding.oldLines)}`,
						`New: ${label(finding.path)} · ${range(finding.newStart, finding.newLines)} · +${finding.added} / -${finding.deleted}`,
						`Rule: ${label(finding.rule)} · ${label(finding.label)}`,
						`Criterion:\n${indent(finding.criterion)}`,
					].join("\n"),
				)
				.join("\n\n") || "None recorded. See coverage and omissions.",
		),
		section(
			`Omissions (${report.omitted.length})`,
			report.omitted.map((item) => `- ${safeText(item)}`).join("\n") || "None reported.",
		),
		section(
			"Jev batches and raw answers",
			Array.from(
				{
					length: Math.max(report.evaluations.length, report.questionMaps.length),
				},
				(_, index) => {
					const evaluation = report.evaluations[index];
					const mapping = report.questionMaps[index] ?? {};
					const answers = evaluation?.answers ?? {};
					const ids = [...new Set([...Object.keys(mapping), ...Object.keys(answers)])];
					return section(
						`Batch ${index + 1}`,
						[
							jevDetails(evaluation),
							...ids.map((id) => {
								const location = ownValue(mapping, id);
								return `${label(id)} · ${location ? `${label(location.path)} [${label(location.chunkId)}] · rule ${label(location.rule)}` : "question mapping missing"}\n${indent(answerDetails(ownValue(answers, id)))}`;
							}),
						].join("\n"),
					);
				},
			).join("\n\n") || "No completed evaluations.",
		),
		"Request state, full question text and ranges for non-finding chunks are not retained in this report. Findings include their retained rule criteria and ranges.",
		"Judgments cover individual chunks. They do not establish correctness across chunks or approve merging. Executable checks are separate.",
	].join("\n\n");
}

export function formatReceiptDetails(receipt: Receipt): string {
	// Deliberate allowlist: never send receipts through the request/state formatter.
	return [
		`Receipt: ${label(receipt.purpose)} · ${receipt.status}`,
		`Model${receipt.status === "completed" ? " (actual)" : " (requested or reported; completion unavailable)"}: ${label(receipt.model)}`,
		`Time: ${receipt.elapsedMs}ms · Accounting: ${receipt.accounting}`,
		receipt.usage
			? `Tokens: ${receipt.usage.input_tokens + receipt.usage.output_tokens} total · ${receipt.usage.input_tokens} input · ${receipt.usage.output_tokens} output`
			: "Token usage: unknown.",
		section(
			"Raw answers",
			Object.entries(receipt.answers ?? {})
				.map(([id, answer]) => section(label(id), answerDetails(answer)))
				.join("\n") || "None recorded; no judgment available.",
		),
		"Source-free receipt: request state, questions and criteria are not retained here.",
	].join("\n");
}

interface RecoveryDetails {
	status?: string;
	mode?: string;
	action?: string;
	baseline?: string;
	agreesWithBaseline?: boolean;
	reason?: string;
	calls?: number;
	batchCalls?: number;
	batchFailures?: number;
	omittedBytes?: number;
	droppedCalls?: number;
	droppedBytes?: number;
	unmatchedResults?: number;
	complete?: boolean;
	evaluation?: Evaluation;
}

const recoveryReasons: Record<string, Record<string, string>> = {
	observed: {
		"no-failures": "No tool failures reported in this batch.",
		"assistant-error": "Assistant ended with an error; recovery assessment skipped.",
		cooldown: "Recovery assessment skipped during cooldown.",
		"session-cap": "Recovery assessment skipped: session intervention limit reached.",
		"assessment-pending": "Assessment requested; see later records for the outcome.",
	},
	cancelled: { cancelled: "Recovery cancelled." },
	unassessed: {
		"incomplete-evidence": "Recovery not assessed: diagnostic evidence incomplete.",
		"unsupported-evidence": "Recovery not assessed: unsupported diagnostic evidence.",
	},
	assessed: {},
	unavailable: {},
};

function recoveryExplanation(details: RecoveryDetails): string | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details))
		throw new Error("Malformed recovery record.");
	const reasons =
		typeof details.status === "string" ? ownValue(recoveryReasons, details.status) : undefined;
	if (
		!reasons ||
		(details.mode !== undefined && !["steer", "shadow"].includes(details.mode)) ||
		[details.action, details.baseline].some(
			(value) => value !== undefined && !["none", "replan", "ask-user"].includes(value),
		) ||
		[details.complete, details.agreesWithBaseline].some(
			(value) => value !== undefined && typeof value !== "boolean",
		) ||
		[
			details.calls,
			details.batchCalls,
			details.batchFailures,
			details.omittedBytes,
			details.droppedCalls,
			details.droppedBytes,
			details.unmatchedResults,
		].some((value) => value !== undefined && (!Number.isSafeInteger(value) || value < 0))
	)
		throw new Error("Malformed or unsupported recovery record.");
	if (details.reason !== undefined) {
		const explanation =
			typeof details.reason === "string" ? ownValue(reasons, details.reason) : undefined;
		if (
			!explanation ||
			(details.reason === "no-failures" &&
				details.batchFailures !== undefined &&
				details.batchFailures !== 0)
		)
			throw new Error("Malformed or unsupported recovery reason.");
		return explanation;
	}
	if (details.status === "observed")
		return details.batchFailures === 0
			? "No tool failures reported in this batch."
			: "Batch observed; assessment outcome not recorded here.";
	return undefined;
}

export function formatRecoveryDetails(details: RecoveryDetails): string {
	const explanation = recoveryExplanation(details);
	return [
		section(
			"Recovery",
			[
				`Status: ${label(details.status ?? "unknown")} · Mode: ${label(details.mode ?? "not recorded")}`,
				...(explanation ? [explanation] : []),
				`Action: ${label(details.action ?? "none recorded")}${details.mode === "shadow" ? " (shadow only; not sent)" : ""}`,
				`Baseline: ${label(details.baseline ?? "not recorded")} · Agreement: ${details.agreesWithBaseline ?? "not recorded"}`,
				...(details.reason ? [`Reason: ${label(details.reason)}`] : []),
			].join("\n"),
		),
		section(
			"Evidence coverage",
			[
				`Diagnostic coverage complete: ${details.complete ?? "unknown"}`,
				"Coverage is limited to the retained window. Successful output bodies are omitted as irrelevant. Jev does not assess them. Omitted bytes alone do not mean that diagnostic coverage is incomplete.",
				`Calls: ${details.calls ?? "unknown"} · Batch calls: ${details.batchCalls ?? "unknown"} · Batch failures: ${details.batchFailures ?? "unknown"}`,
				`Omitted bytes: ${details.omittedBytes ?? "unknown"} · Dropped calls: ${details.droppedCalls ?? "unknown"} · Dropped bytes: ${details.droppedBytes ?? "unknown"} · Unmatched results: ${details.unmatchedResults ?? "unknown"}`,
			].join("\n"),
		),
		jevDetails(details.evaluation),
		section(
			"Raw answers",
			Object.entries(details.evaluation?.answers ?? {})
				.map(([id, answer]) => section(label(id), answerDetails(answer)))
				.join("\n") || "None recorded; no judgment available.",
		),
		"Source-free recovery record: task, tool inputs and outputs are not retained here. Actions are bounded guidance, not authorization.",
	].join("\n\n");
}

export function formatVerificationDetails(run: VerificationRun): string {
	return [
		`Verification: ${label(run.status)} · observed ${new Date(run.observedAt).toISOString()}`,
		`Snapshot: ${label(run.fingerprint ?? "unavailable")} · task revision ${run.taskRevision}`,
		`Comparison: ${label(run.comparison ?? "unavailable")}`,
		section(
			"Configured checks",
			run.selection.selections
				.map(
					(check) =>
						`${label(check.name)}: ${check.selected ? "selected" : "not run"} · ${label(check.reason)}${check.probability === undefined ? "" : ` · relevance P(true) = ${check.probability}`}`,
				)
				.join("\n"),
		),
		section(
			"Execution observations",
			run.results
				.map((result) =>
					[
						`${label(result.name)}: ${result.passed ? "passed" : "FAILED"} · exit ${result.exitCode ?? "unknown"} · ${result.termination} · ${result.elapsedMs}ms`,
						`Output (${result.omittedBytes} bytes omitted):\n${indent(result.output || "No output.")}`,
					].join("\n"),
				)
				.join("\n\n") || "No checks executed; no verification established.",
		),
		section(
			"Selection judgments",
			run.selection.evaluations.map(jevDetails).join("\n") ||
				"No model judgment required or available.",
		),
		section("Omissions", run.omitted.join("\n") || "None reported."),
		"These observations describe past execution. They do not prove current correctness. Jev assesses relevance. Exit status and termination determine check success.",
	].join("\n\n");
}

const UNAVAILABLE_DETAILS =
	"Details unavailable: malformed or unsupported record. No judgment established.";

// Session metadata is not schema-validated by Pi. Keep malformed historical
// records visible as unavailable, without falling back to a raw source dump.
export function formatRestoredDetails(format: () => string): string {
	try {
		return format();
	} catch {
		return UNAVAILABLE_DETAILS;
	}
}

function messageDetails(details: unknown): string {
	if (!details) return "Details: not retained.";
	if (Array.isArray(details))
		return (
			details
				.map((receipt) => formatRestoredDetails(() => formatReceiptDetails(receipt as Receipt)))
				.join("\n\n") || "No receipts on this page."
		);
	if (typeof details === "object") {
		if (
			"kind" in details &&
			details.kind === "autopilot" &&
			"coverage" in details &&
			typeof details.coverage === "string"
		)
			return safeText(details.coverage);
		if ("selection" in details && "results" in details)
			return formatVerificationDetails(details as VerificationRun);
		if ("reviewedChunks" in details) return formatReviewDetails(details as DiffReport);
		if (
			"result" in details ||
			"writer" in details ||
			"request" in details ||
			"questions" in details
		)
			return formatDecisionDetails(details as DecisionDetails);
	}
	return UNAVAILABLE_DETAILS;
}

export function registerPresentation(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<Receipt>("jevons.receipt", (entry, { expanded }, theme) => {
		const receipt = entry.data;
		if (!receipt) return new Text("Jevons receipt: unavailable", 0, 0);
		return new Text(
			formatRestoredDetails(() => {
				const tokens = receipt.usage
					? `${receipt.usage.input_tokens + receipt.usage.output_tokens} tokens`
					: "usage unknown";
				const heading = `${receipt.purpose} · ${receipt.status} · ${tokens} · ${receipt.elapsedMs}ms`;
				return expanded ? formatReceiptDetails(receipt) : theme.fg("muted", label(heading));
			}),
			0,
			0,
		);
	});
	pi.registerEntryRenderer<RecoveryDetails>("jevons.recovery", (entry, { expanded }, theme) => {
		const details = entry.data ?? {};
		return new Text(
			formatRestoredDetails(() => {
				if (expanded) return formatRecoveryDetails(details);
				const explanation = recoveryExplanation(details);
				return theme.fg(
					"muted",
					`Recovery · ${label(details.status ?? "unknown")}${details.mode ? ` · ${label(details.mode)}` : ""} · ${explanation ?? label(details.action ?? "no action recorded")}`,
				);
			}),
			0,
			0,
		);
	});
	for (const customType of ["jevons", "jevons.recovery"]) {
		pi.registerMessageRenderer(customType, (message, { expanded }, theme) => {
			const content =
				typeof message.content === "string"
					? message.content
					: message.content
							.map((part) =>
								part.type === "text" ? part.text : "[image omitted from text presentation]",
							)
							.join("\n");
			return new Text(
				theme.fg("accent", customType === "jevons.recovery" ? "Recovery " : "Jevons ") +
					safeText(content) +
					(expanded && message.details && customType === "jevons"
						? `\n\n${formatRestoredDetails(() => messageDetails(message.details))}`
						: ""),
				0,
				0,
			);
		});
	}
}
