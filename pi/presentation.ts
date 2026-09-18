import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Evaluation, Request } from "../src/contracts.ts";
import type { Receipt } from "./service.ts";
import type { AuthoredQuestions } from "./author.ts";

export function safeText(text: string): string {
  return text.replace(
    /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g,
    "?",
  );
}

export function formatEvaluation(
  result: Evaluation,
  request?: Request,
  writer?: Omit<AuthoredQuestions, "questions">,
): string {
  return [
    ...(writer
      ? [
          `Writer ${writer.model} · ${writer.usage.totalTokens} tokens · ${writer.elapsedMs}ms`,
        ]
      : []),
    `Jev ${result.model} · ${result.usage.input_tokens + result.usage.output_tokens} tokens · ${result.elapsedMs}ms`,
    ...Object.entries(result.answers).map(([id, answer]) => {
      const question = request?.questions[id];
      const label = question
        ? `${id}: ${question.instructions.length > 240 ? question.instructions.slice(0, 240) + "…" : question.instructions}\n  `
        : `${id}: `;
      if (answer.type === "noul")
        return `${label}yes ${(answer.noul * 100).toFixed(1)}%`;
      if (answer.type === "choice")
        return `${label}${answer.choice} (${(answer.probabilities[answer.choice]! * 100).toFixed(1)}%)`;
      return `${label}${answer.score.toFixed(2)} · ${JSON.stringify(answer.probabilities)}`;
    }),
  ]
    .map(safeText)
    .join("\n");
}

export function registerPresentation(pi: ExtensionAPI): void {
  pi.registerEntryRenderer("jevons.receipt", (entry, { expanded }, theme) => {
    const receipt = entry.data as Receipt;
    const tokens = receipt.usage
      ? `${receipt.usage.input_tokens + receipt.usage.output_tokens} tokens`
      : "usage unknown";
    const heading = `${receipt.purpose} · ${receipt.status} · ${tokens} · ${receipt.elapsedMs}ms`;
    return new Text(
      theme.fg("muted", safeText(heading)) +
        (expanded ? `\n${safeText(JSON.stringify(receipt, null, 2))}` : ""),
      0,
      0,
    );
  });
  pi.registerMessageRenderer(
    "jevons",
    (message, { expanded }, theme) =>
      new Text(
        theme.fg("accent", "Jevons ") +
          safeText(
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
          ) +
          (expanded && message.details
            ? `\n${safeText(JSON.stringify(message.details, null, 2))}`
            : ""),
        0,
        0,
      ),
  );
}
