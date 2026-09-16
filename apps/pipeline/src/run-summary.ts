import { MISSING_CREDENTIAL_CODE } from "./providers/credentials.js";
import type { TargetEntry } from "./types/config.js";
import type { RunError } from "./types/unified-result.js";
import { logger } from "./util/logger.js";

/**
 * Provider-level accounting for a run.
 *
 * Errors are recorded per result in `UnifiedResult.error`, and every errored
 * result is excluded from every cohort and denominator downstream. That makes a
 * provider-wide outage invisible: the run completes, rows are written, the
 * aggregate moves, and the movement has nothing to do with the brand. This
 * module rolls the per-result errors back up to the (provider, model) target so
 * the run can say "anthropic returned 0 of 16" out loud, and exit non-zero when
 * a target that could have worked returned nothing at all.
 *
 * Two failure shapes are reported separately, because they mean different
 * things to the person reading the summary:
 *
 *   - `missing-credentials` — the key is absent or rejected. Expected when a
 *     forker has only configured some providers; the README promises the rest
 *     of the run still completes, so this does NOT fail the run on its own.
 *   - `failed` — the key worked well enough to get a real answer back, and the
 *     answer was an error: a wrong model id, a removed endpoint, an outage.
 *     This is the case a stale `DEFAULT_TARGETS` entry produces, and it fails
 *     the run.
 *
 * A run where *nothing* succeeded fails regardless of cause — an empty run is
 * never a success, however sympathetic the reason.
 */

export type TargetStatus =
  | "ok"
  | "partial"
  | "missing-credentials"
  | "failed"
  | "not-run";

/** The minimum a caller has to record per result to build a summary. */
export interface TargetOutcome {
  provider: string;
  model: string;
  error: RunError | null;
}

export interface TargetSummary {
  provider: string;
  model: string;
  attempted: number;
  succeeded: number;
  failed: number;
  status: TargetStatus;
  /** Error code → how many results carried it, most frequent first. */
  errorCodes: Record<string, number>;
  /** First error message seen for this target, truncated for logging. */
  sampleError?: string;
}

export interface RunSummary {
  targets: TargetSummary[];
  attempted: number;
  succeeded: number;
  failed: number;
  /** Targets that failed for a reason other than absent credentials. */
  failedTargets: string[];
  /** Targets that never produced a result at all. */
  notRunTargets: string[];
  /** Targets skipped because their credentials are absent or rejected. */
  missingCredentialTargets: string[];
  /** False when the run must not be treated as a clean success. */
  ok: boolean;
}

const SAMPLE_ERROR_MAX_LENGTH = 200;

/**
 * Error codes and message shapes that mean "we never got to ask the provider a
 * real question". Matched against what the SDKs in this repo actually throw:
 *
 *   openai      Missing credentials. Please pass an `apiKey`, or set the
 *               `OPENAI_API_KEY` environment variable.
 *   anthropic   Could not resolve authentication method. Expected either
 *               apiKey or authToken to be set.
 *   exa-js      API key must be provided as an argument or as an environment
 *               variable (EXA_API_KEY)
 *
 * plus `missing_credentials`, which this repo's own `MissingCredentialError`
 * throws for a provider whose key has to be resolved explicitly because the SDK
 * default would reach for another service's (see providers/credentials.ts), and
 * the HTTP codes a present-but-invalid key comes back as.
 */
const CREDENTIAL_ERROR_CODES = new Set([
  MISSING_CREDENTIAL_CODE,
  "HTTP_401",
  "HTTP_403",
  "authentication_error",
  "invalid_api_key",
  "permission_error",
]);

const CREDENTIAL_MESSAGE_PATTERNS = [
  /missing credentials/i,
  /could not resolve authentication method/i,
  /api[ _-]?key must be provided/i,
  /api[ _-]?key.{0,40}(missing|empty|not set|not provided|is required)/i,
  /(no|invalid|incorrect|unauthorized).{0,20}api[ _-]?key/i,
  /authentication (failed|error)/i,
  // The Claude Code CLI's own wording, read off a real subprocess run rather
  // than guessed: "Failed to authenticate. API Error: 401 API key is invalid."
  // It reaches us only because anthropic-agent now folds subprocess stderr into
  // the error message; before that this arrived as a bare exit code and was
  // indistinguishable from a broken model id.
  /failed to authenticate/i,
  /api[ _-]?key is (invalid|incorrect|not valid)/i,
];

/** True when this error means the provider's credentials are absent or refused. */
export function isCredentialError(error: RunError): boolean {
  if (CREDENTIAL_ERROR_CODES.has(error.code)) return true;
  return CREDENTIAL_MESSAGE_PATTERNS.some((p) => p.test(error.message));
}

export function targetKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Collapse a per-result target list to the distinct targets it covered. Used by
 * the partial commands (`run-missing`, `rerun-failed`), which touch only part
 * of the matrix — summarizing them against the full matrix would report every
 * untouched target as "not run".
 */
export function distinctTargets(targets: TargetEntry[]): TargetEntry[] {
  const seen = new Map<string, TargetEntry>();
  for (const target of targets) {
    seen.set(targetKey(target.provider, target.model), target);
  }
  return [...seen.values()];
}

/**
 * Roll per-result outcomes up to per-target status.
 *
 * `targets` is the matrix the run intended to cover, so a target that produced
 * no results at all is still reported (as `not-run`) instead of vanishing.
 */
export function summarizeRun(
  targets: TargetEntry[],
  outcomes: TargetOutcome[],
): RunSummary {
  const byKey = new Map<string, TargetSummary>();

  for (const target of targets) {
    byKey.set(targetKey(target.provider, target.model), {
      provider: target.provider,
      model: target.model,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      status: "not-run",
      errorCodes: {},
    });
  }

  // Track whether every failure for a target was a credential failure. A target
  // with a mix (say, a 401 and a 404) is a real failure, not a missing key.
  const credentialOnly = new Map<string, boolean>();

  for (const outcome of outcomes) {
    const key = targetKey(outcome.provider, outcome.model);
    let entry = byKey.get(key);
    if (!entry) {
      // A result for a target that isn't in the configured matrix — a re-run
      // against an older results file can produce these. Report it rather than
      // drop it.
      entry = {
        provider: outcome.provider,
        model: outcome.model,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        status: "not-run",
        errorCodes: {},
      };
      byKey.set(key, entry);
    }

    entry.attempted++;
    if (outcome.error === null) {
      entry.succeeded++;
      continue;
    }

    entry.failed++;
    entry.errorCodes[outcome.error.code] =
      (entry.errorCodes[outcome.error.code] ?? 0) + 1;
    entry.sampleError ??= outcome.error.message.slice(
      0,
      SAMPLE_ERROR_MAX_LENGTH,
    );
    credentialOnly.set(
      key,
      (credentialOnly.get(key) ?? true) && isCredentialError(outcome.error),
    );
  }

  const summary: RunSummary = {
    targets: [],
    attempted: 0,
    succeeded: 0,
    failed: 0,
    failedTargets: [],
    notRunTargets: [],
    missingCredentialTargets: [],
    ok: true,
  };

  for (const [key, entry] of byKey) {
    entry.errorCodes = sortCountsDescending(entry.errorCodes);
    entry.status = statusFor(entry, credentialOnly.get(key) ?? false);

    summary.targets.push(entry);
    summary.attempted += entry.attempted;
    summary.succeeded += entry.succeeded;
    summary.failed += entry.failed;

    if (entry.status === "failed") summary.failedTargets.push(key);
    if (entry.status === "not-run") summary.notRunTargets.push(key);
    if (entry.status === "missing-credentials")
      summary.missingCredentialTargets.push(key);
  }

  summary.ok =
    summary.failedTargets.length === 0 &&
    summary.notRunTargets.length === 0 &&
    summary.succeeded > 0;

  return summary;
}

function statusFor(
  entry: TargetSummary,
  credentialOnly: boolean,
): TargetStatus {
  if (entry.attempted === 0) return "not-run";
  if (entry.succeeded === 0) {
    return credentialOnly ? "missing-credentials" : "failed";
  }
  return entry.failed === 0 ? "ok" : "partial";
}

function sortCountsDescending(counts: Record<string, number>) {
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

const STATUS_LABEL: Record<TargetStatus, string> = {
  ok: "OK",
  partial: "PARTIAL",
  "missing-credentials": "NO CREDENTIALS",
  failed: "FAILED",
  "not-run": "NOT RUN",
};

/**
 * A fixed-width block meant for a human reading the terminal. The structured
 * record is logged alongside it; this exists so a provider returning 0 of 16 is
 * impossible to miss in a wall of progress lines.
 */
export function formatRunSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("─".repeat(72));
  lines.push("RUN SUMMARY");
  lines.push("─".repeat(72));

  const providerWidth = Math.max(
    8,
    ...summary.targets.map((t) => targetKey(t.provider, t.model).length),
  );

  for (const target of summary.targets) {
    const key = targetKey(target.provider, target.model).padEnd(providerWidth);
    const counts = `${target.succeeded}/${target.attempted} ok`.padEnd(12);
    const label = STATUS_LABEL[target.status].padEnd(14);
    const codes = Object.entries(target.errorCodes)
      .map(([code, count]) => `${code}×${count}`)
      .join(" ");
    lines.push(`  ${label} ${key}  ${counts} ${codes}`.trimEnd());
    // NO CREDENTIALS quotes its error too: "which key" is the whole question a
    // reader of that line has, and an absent PERPLEXITY_API_KEY used to arrive
    // here as a 401 that read as a *wrong* key.
    if (
      (target.status === "failed" || target.status === "missing-credentials") &&
      target.sampleError
    ) {
      lines.push(
        `  ${" ".repeat(14)} ${" ".repeat(providerWidth)}  ↳ ${target.sampleError}`,
      );
    }
  }

  lines.push("─".repeat(72));
  lines.push(
    `  ${summary.succeeded}/${summary.attempted} results without error across ${summary.targets.length} targets`,
  );

  if (summary.missingCredentialTargets.length > 0) {
    lines.push(
      `  No credentials (expected if unconfigured): ${summary.missingCredentialTargets.join(", ")}`,
    );
  }
  if (summary.notRunTargets.length > 0) {
    lines.push(`  Never ran: ${summary.notRunTargets.join(", ")}`);
  }
  if (summary.failedTargets.length > 0) {
    lines.push(
      `  PROVIDER FAILURE — returned no usable result: ${summary.failedTargets.join(", ")}`,
    );
    lines.push(
      "  Every row these wrote is excluded from downstream denominators, so the",
    );
    lines.push(
      "  dashboard will move for reasons unrelated to the brand. Fix before ingest.",
    );
  }
  if (summary.ok) {
    lines.push(
      "  Every configured target returned at least one usable result.",
    );
  } else if (summary.succeeded === 0) {
    lines.push("  NOTHING SUCCEEDED — this run produced no usable data.");
  }

  lines.push("─".repeat(72));
  lines.push("");
  return lines.join("\n");
}

/**
 * Print the summary for a human and log it structured, then report whether the
 * caller should exit non-zero. Every command that drives providers ends here so
 * a partial run cannot exit clean from one entrypoint and loudly from another.
 */
export function reportRunSummary(summary: RunSummary): void {
  process.stdout.write(formatRunSummary(summary));

  for (const target of summary.targets) {
    const context = {
      provider: target.provider,
      model: target.model,
      succeeded: target.succeeded,
      attempted: target.attempted,
      errorCodes: target.errorCodes,
      sampleError: target.sampleError,
    };
    if (target.status === "failed" || target.status === "not-run") {
      logger.error(
        context,
        `Provider failure: ${targetKey(target.provider, target.model)} returned no usable result`,
      );
    } else if (target.status === "missing-credentials") {
      logger.warn(
        context,
        `No credentials for ${targetKey(target.provider, target.model)}; target skipped`,
      );
    } else if (target.status === "partial") {
      logger.warn(
        context,
        `Partial results for ${targetKey(target.provider, target.model)}`,
      );
    }
  }

  logger.info(
    { summary },
    summary.ok ? "Run summary: ok" : "Run summary: provider-level failure",
  );
}
