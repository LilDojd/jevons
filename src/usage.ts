export interface UsageSummary {
  input: number;
  output: number;
  calls: number;
  unknown: number;
  failed: number;
}

export function summarizeUsage(receipts: Iterable<unknown>): UsageSummary {
  const summary: UsageSummary = {
    input: 0,
    output: 0,
    calls: 0,
    unknown: 0,
    failed: 0,
  };
  for (const value of receipts) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const receipt = value as Record<string, unknown>;
    if (
      receipt.status !== "completed" &&
      receipt.status !== "failed" &&
      receipt.status !== "cancelled"
    )
      continue;
    if (receipt.status !== "completed") summary.failed++;
    if (
      receipt.accounting === "not-dispatched" ||
      receipt.accounting === "released"
    )
      continue;
    summary.calls++;
    const usage = receipt.usage as Record<string, unknown> | undefined;
    const input = usage?.input_tokens;
    const output = usage?.output_tokens;
    if (
      typeof input === "number" &&
      typeof output === "number" &&
      Number.isSafeInteger(input) &&
      input >= 0 &&
      Number.isSafeInteger(output) &&
      output >= 0 &&
      Number.isSafeInteger(input + output) &&
      Number.isSafeInteger(summary.input + input) &&
      Number.isSafeInteger(summary.output + output)
    ) {
      summary.input += input;
      summary.output += output;
    } else summary.unknown++;
  }
  return summary;
}
