import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Policy } from "./contracts.ts";

interface Charge {
  session: string;
  day: string;
  tokens: number;
  pending: boolean;
  overrun?: true;
}
export interface BudgetUsage {
  session: number;
  day: number;
  pending: number;
  overrun?: true;
}

const queues = new Map<string, Promise<void>>();
const LEDGER_BYTES = 4 * 1024 * 1024;

async function ensureDirectory(directory: string): Promise<void> {
  const parents: string[] = [];
  for (let path = directory; dirname(path) !== path; path = dirname(path))
    parents.push(path);
  for (const path of parents.reverse()) {
    let created = false;
    try {
      await mkdir(path, { mode: 0o700 });
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!(await lstat(path)).isDirectory())
      throw new Error(
        "Budget directory or parent is a symlink or not a directory.",
      );
    if (created) {
      const parent = await open(
        dirname(path),
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  }
}

export class Budget {
  readonly directory: string;
  readonly session: string;
  readonly limits: Readonly<Policy["budget"]>;

  constructor(directory: string, session: string, limits: Policy["budget"]) {
    if (
      !directory ||
      !session ||
      [limits.requestTokens, limits.sessionTokens, limits.dayTokens].some(
        (value) => !Number.isSafeInteger(value) || value <= 0,
      )
    )
      throw new Error("Invalid budget directory, session or limits.");
    this.directory = resolve(directory);
    this.session = session;
    this.limits = Object.freeze({ ...limits });
  }

  private async transaction<T>(
    update: (charges: Record<string, Charge>) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const previous = queues.get(this.directory);
    let release!: () => void;
    const finished = new Promise<void>((done) => {
      release = done;
    });
    // A cancelled waiter cannot let its successors overtake the current owner.
    const queued = Promise.all([previous, finished]).then(() => {});
    queues.set(this.directory, queued);
    void queued.then(() => {
      if (queues.get(this.directory) === queued) queues.delete(this.directory);
    });
    let abort: (() => void) | undefined;
    try {
      if (signal && previous) {
        const cancelled = new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
        await Promise.race([previous, cancelled]);
      } else await previous;
      signal?.throwIfAborted();
      return await this.lockedTransaction(update, signal);
    } finally {
      if (abort) signal!.removeEventListener("abort", abort);
      release();
    }
  }

  private async lockedTransaction<T>(
    update: (charges: Record<string, Charge>) => T,
    signal?: AbortSignal,
  ): Promise<T> {
    await ensureDirectory(this.directory);
    const lock = join(this.directory, "lock");
    const deadline = performance.now() + 1000;
    let handle;
    while (!handle) {
      signal?.throwIfAborted();
      try {
        handle = await open(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0)
          throw new Error(
            "Budget is busy. Inspect a leftover lock before removing it.",
          );
        await delay(Math.min(20, remaining), undefined, { signal });
      }
    }
    const file = join(this.directory, "tokens.json");
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      let charges: Record<string, Charge> = {};
      let input;
      try {
        input = await open(
          file,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (input) {
        try {
          const stat = await input.stat();
          if (!stat.isFile() || stat.size > LEDGER_BYTES)
            throw new Error("Invalid budget ledger.");
          const buffer = Buffer.alloc(LEDGER_BYTES + 1);
          let bytes = 0;
          while (bytes < buffer.length) {
            const chunk = await input.read(
              buffer,
              bytes,
              buffer.length - bytes,
            );
            if (!chunk.bytesRead) break;
            bytes += chunk.bytesRead;
          }
          if (bytes > LEDGER_BYTES) throw new Error("Invalid budget ledger.");
          charges = JSON.parse(buffer.toString("utf8", 0, bytes)) as Record<
            string,
            Charge
          >;
          if (
            !charges ||
            Array.isArray(charges) ||
            typeof charges !== "object" ||
            Object.values(charges).some(
              (c) =>
                !c ||
                typeof c.session !== "string" ||
                !c.session ||
                typeof c.day !== "string" ||
                !/^\d{4}-\d{2}-\d{2}$/.test(c.day) ||
                !Number.isFinite(Date.parse(c.day)) ||
                new Date(c.day).toISOString().slice(0, 10) !== c.day ||
                !Number.isSafeInteger(c.tokens) ||
                c.tokens < 0 ||
                typeof c.pending !== "boolean" ||
                (c.overrun !== undefined && (c.overrun !== true || c.pending)),
            )
          )
            throw new Error("Invalid budget ledger.");
        } finally {
          await input.close();
        }
      }
      this.totals(charges);
      signal?.throwIfAborted();
      const result = update(charges);
      this.totals(charges);
      const serialized = JSON.stringify(charges);
      if (Buffer.byteLength(serialized) > LEDGER_BYTES)
        throw new Error("Budget ledger is full.");
      const output = await open(temporary, "wx", 0o600);
      try {
        await output.writeFile(serialized);
        await output.sync();
      } finally {
        await output.close();
      }
      await rename(temporary, file);
      const directory = await open(
        this.directory,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return result;
    } finally {
      try {
        await handle.close();
      } finally {
        try {
          await rm(temporary, { force: true });
        } finally {
          await rm(lock);
        }
      }
    }
  }

  totals(
    charges: Record<string, Charge>,
    day = new Date().toISOString().slice(0, 10),
  ): BudgetUsage {
    const usage: BudgetUsage = { session: 0, day: 0, pending: 0 };
    for (const charge of Object.values(charges)) {
      if (charge.session === this.session) usage.session += charge.tokens;
      if (charge.day === day) usage.day += charge.tokens;
      if (
        charge.pending &&
        (charge.day === day || charge.session === this.session)
      )
        usage.pending++;
      if (
        charge.overrun &&
        (charge.day === day || charge.session === this.session)
      )
        usage.overrun = true;
    }
    if (
      !Number.isSafeInteger(usage.session) ||
      !Number.isSafeInteger(usage.day)
    )
      throw new Error("Invalid budget totals.");
    return usage;
  }

  async reserve(signal?: AbortSignal): Promise<string> {
    return this.transaction((charges) => {
      const day = new Date().toISOString().slice(0, 10);
      const usage = this.totals(charges, day);
      if (usage.overrun)
        throw new Error(
          "Budget paused after usage exceeded a request reservation.",
        );
      if (this.limits.requestTokens > this.limits.sessionTokens - usage.session)
        throw new Error("Session Jev token budget exhausted.");
      if (this.limits.requestTokens > this.limits.dayTokens - usage.day)
        throw new Error("Daily Jev token budget exhausted.");
      const id = randomUUID();
      charges[id] = {
        session: this.session,
        day,
        tokens: this.limits.requestTokens,
        pending: true,
      };
      return id;
    }, signal);
  }

  async settle(id: string, tokens: number): Promise<void> {
    if (!Number.isSafeInteger(tokens) || tokens < 0)
      throw new Error("Invalid token usage.");
    await this.transaction((charges) => {
      const charge = Object.hasOwn(charges, id) ? charges[id] : undefined;
      if (!charge || charge.session !== this.session || !charge.pending)
        throw new Error("Unknown budget reservation.");
      if (tokens > charge.tokens) charge.overrun = true;
      charge.tokens = tokens;
      charge.pending = false;
    });
  }

  async usage(): Promise<BudgetUsage> {
    return this.transaction((charges) => this.totals(charges));
  }
}
