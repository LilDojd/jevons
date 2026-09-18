export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type Question =
  | {
      type: "noul";
      instructions: string;
      criteria?: { true: string; false: string };
    }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | {
      type: "score";
      instructions: string;
      criteria: [string, string, ...string[]];
    };

export interface Request {
  state: string | null | Json[] | { [key: string]: Json };
  questions: Record<string, Question>;
}

export type Answer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      probabilities: Record<string, number>;
    };

export interface Evaluation {
  model: string;
  answers: Record<string, Answer>;
  usage: { input_tokens: number; output_tokens: number };
  elapsedMs: number;
}

export type Evaluate = (
  request: Request,
  signal?: AbortSignal,
) => Promise<Evaluation>;

export interface ModelProfile {
  provider: string;
  model: string;
  description: string;
}

export interface DiffChunk {
  id: string;
  path: string;
  oldPath: string;
  oldStart: number;
  newStart: number;
  oldLines: number;
  newLines: number;
  added: number;
  deleted: number;
  patch: string;
}

export interface DiffSnapshot {
  fingerprint: string;
  comparison: string;
  files: string[];
  chunks: DiffChunk[];
  omitted: string[];
}

export interface Rule {
  id: string;
  label: string;
  instructions: string;
}

export interface CheckConfig {
  name: string;
  argv: string[];
  timeoutMs: number;
  description?: string;
  mandatory?: boolean;
}

export interface Policy {
  model: string;
  autopilot: {
    skills: boolean;
    models: "off" | "suggest" | "switch";
    tools: boolean;
    threshold: number;
  };
  recovery: {
    mode: "off" | "shadow" | "steer";
    retryConcern: number;
    userConcern: number;
    cooldownTurns: number;
    maxInterventions: number;
  };
  profiles: ModelProfile[];
  writer?: { provider: string; model: string };
  review: {
    automatic: boolean;
    investigate: boolean;
    investigateConcern: number;
    concern: number;
    clear: number;
    rules: Rule[];
  };
  verification: { select: boolean; relevance: number };
  checks: CheckConfig[];
}
