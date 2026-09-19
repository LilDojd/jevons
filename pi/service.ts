import { AsyncLocalStorage } from "node:async_hooks";
import type { Fetch } from "@typesafe-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { Answer, Evaluation, Request } from "../src/contracts.ts";
import { parseRequest } from "./schema.ts";

export interface Receipt {
	purpose: string;
	model: string;
	elapsedMs: number;
	usage?: Evaluation["usage"];
	answers?: Record<string, Answer>;
	accounting: "reported" | "unknown" | "not-dispatched";
	status: "completed" | "cancelled" | "failed";
}

async function abortable<T>(operation: () => PromiseLike<T>, signal?: AbortSignal): Promise<T> {
	signal?.throwIfAborted();
	if (!signal) return operation();
	let cancel!: () => void;
	const aborted = new Promise<never>((_, reject) => {
		cancel = () => reject(signal.reason);
		signal.addEventListener("abort", cancel, { once: true });
	});
	try {
		return await Promise.race([
			aborted,
			Promise.resolve().then(() => {
				signal.throwIfAborted();
				return operation();
			}),
		]);
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

function modelName(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(value);
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class Jev {
	readonly client: TypeSafeClient;
	readonly model: string;
	readonly record: (receipt: Receipt) => void;
	private readonly attempts = new AsyncLocalStorage<{ dispatched: boolean }>();

	constructor(options: {
		model: string;
		record: (receipt: Receipt) => void;
		apiKey?: string;
		fetch?: Fetch;
	}) {
		if (!modelName(options.model)) throw new Error("Invalid Jev model name.");
		this.model = options.model;
		this.record = options.record;
		const transport = options.fetch ?? globalThis.fetch;
		this.client = new TypeSafeClient({
			apiKey: options.apiKey,
			baseURL: "https://api.typesafe.ai",
			defaultModel: options.model,
			logLevel: "off",
			retry: { maxRetries: 0 },
			timeout: 10000,
			fetch: async (url, init) => {
				const signal = init?.signal ?? undefined;
				const response = await abortable(async () => {
					const attempt = this.attempts.getStore();
					if (!attempt || attempt.dispatched)
						throw new Error("Jev request is outside its single dispatch.");
					attempt.dispatched = true;
					const response = await transport(url, { ...init, redirect: "error" });
					if (signal?.aborted) {
						void response.body?.cancel().catch(() => {});
						signal.throwIfAborted();
					}
					return response;
				}, signal);
				if (!response.body) return response;
				let bytes = 0;
				return new Response(
					response.body.pipeThrough(
						new TransformStream<Uint8Array, Uint8Array>({
							transform(chunk, controller) {
								bytes += chunk.byteLength;
								if (bytes > 256000) throw new Error("Jev response exceeds 256 KB.");
								controller.enqueue(chunk);
							},
						}),
					),
					{
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					},
				);
			},
		});
	}

	private receipt(receipt: Receipt): void {
		try {
			this.record(receipt);
		} catch {}
	}

	async evaluate(purpose: string, input: Request, signal?: AbortSignal): Promise<Evaluation> {
		signal?.throwIfAborted();
		const request = parseRequest(input);
		const started = Date.now();
		let usage: Evaluation["usage"] | undefined;
		let model = this.model;
		const attempt = { dispatched: false };
		let accounting: Receipt["accounting"] = "not-dispatched";
		try {
			signal?.throwIfAborted();
			const result = await this.attempts.run(attempt, () =>
				this.client.systemOne(
					{ ...request, model: this.model },
					{ signal, retry: { maxRetries: 0 } },
				),
			);
			const validModel = modelName(result?.model);
			if (validModel) model = result.model;
			const billed = result?.usage;
			if (
				!billed ||
				!Number.isSafeInteger(billed.input_tokens) ||
				!Number.isSafeInteger(billed.output_tokens) ||
				billed.input_tokens < 0 ||
				billed.output_tokens < 0 ||
				!Number.isSafeInteger(billed.input_tokens + billed.output_tokens)
			)
				throw new Error("Jev returned invalid usage.");
			usage = {
				input_tokens: billed.input_tokens,
				output_tokens: billed.output_tokens,
			};
			accounting = "reported";
			signal?.throwIfAborted();
			if (
				!validModel ||
				!object(result.answers) ||
				Object.keys(result.answers).length !== Object.keys(request.questions).length
			)
				throw new Error("Jev returned an incomplete result.");
			const answers: Record<string, Answer> = Object.fromEntries(
				Object.entries(request.questions).map(([id, question]): [string, Answer] => {
					const answer = Object.hasOwn(result.answers, id) ? result.answers[id] : undefined;
					if (!object(answer) || answer.type !== question.type)
						throw new Error("Jev returned a mismatched answer.");
					if (answer.type === "noul") {
						if (!probability(answer.noul)) throw new Error("Invalid Jev probability.");
						return [id, { type: "noul", noul: answer.noul }];
					}
					const keys =
						question.type === "choice"
							? Object.keys(question.criteria)
							: question.type === "score"
								? question.criteria.map((_, index) => String(index))
								: [];
					const values: unknown = answer.probabilities;
					if (
						!object(values) ||
						Object.keys(values).length !== keys.length ||
						keys.some((key) => !Object.hasOwn(values, key) || !probability(values[key])) ||
						!probability(answer.confidence)
					)
						throw new Error("Invalid Jev distribution.");
					const probabilities = Object.fromEntries(keys.map((key) => [key, values[key] as number]));
					if (Math.abs(Object.values(probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02)
						throw new Error("Invalid Jev distribution.");
					if (answer.type === "choice") {
						const selected =
							typeof answer.choice === "string" ? probabilities[answer.choice] : undefined;
						if (
							typeof answer.choice !== "string" ||
							!keys.includes(answer.choice) ||
							selected === undefined ||
							Object.values(probabilities).some((value) => value > selected)
						)
							throw new Error("Invalid Jev choice.");
						return [
							id,
							{
								type: "choice",
								choice: answer.choice,
								confidence: answer.confidence,
								probabilities,
							},
						];
					}
					if (
						typeof answer.score !== "number" ||
						!Number.isFinite(answer.score) ||
						answer.score < 0 ||
						answer.score > keys.length - 1
					)
						throw new Error("Invalid Jev score.");
					return [
						id,
						{
							type: "score",
							score: answer.score,
							confidence: answer.confidence,
							probabilities,
						},
					];
				}),
			);
			const evaluation = {
				model,
				answers,
				usage,
				elapsedMs: Date.now() - started,
			};
			this.receipt({ purpose, ...evaluation, accounting, status: "completed" });
			return evaluation;
		} catch {
			if (!usage) accounting = attempt.dispatched ? "unknown" : "not-dispatched";
			this.receipt({
				purpose,
				model,
				usage,
				accounting,
				elapsedMs: Date.now() - started,
				status: signal?.aborted ? "cancelled" : "failed",
			});
			throw new Error(
				signal?.aborted ? "Jev cancelled." : "Jev request failed; no retry was sent.",
			);
		}
	}
}

function probability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
