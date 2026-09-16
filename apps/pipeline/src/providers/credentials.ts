/**
 * Explicit credential resolution for provider clients.
 *
 * Every SDK in this repo resolves a missing `apiKey` option from an environment
 * variable of its own choosing. That is correct when the client points at the
 * SDK's own service, and wrong the moment it does not: the OpenAI SDK's
 * constructor destructures `apiKey = readEnv("OPENAI_API_KEY")`, so passing
 * `process.env.PERPLEXITY_API_KEY` when that variable is unset passes
 * `undefined`, the default fires, and a client aimed at
 * `https://api.perplexity.ai` authenticates with the *OpenAI* key. Measured, with
 * a sentinel:
 *
 *   PERPLEXITY_API_KEY in env?   false
 *   OPENAI_API_KEY in env?       true
 *   resolved === OPENAI_API_KEY? true
 *
 * The consequence is not a wrong number — it is a secret in a third party's
 * request log. A forker who sets only `OPENAI_API_KEY`, which the quickstart
 * invites, ships it to Perplexity and OpenRouter in an `Authorization` header on
 * every run. The requests are rejected, but by then the key has left the machine.
 *
 * It also corrupts the run summary. An absent key arrived as a wrong-key `401`
 * from the remote, so `run-summary.ts` told the operator their Perplexity key was
 * invalid when they had never set one, and the two failure shapes it reports —
 * `missing-credentials` (tolerated) and `failed` (fails the run) — stopped
 * meaning what they say.
 *
 * So: resolve the variable here, fail by name before a client exists, and never
 * hand an SDK an `undefined` it will fill in from somewhere else.
 */

/** `RunError.code` for an absent credential. Matched by `isCredentialError`. */
export const MISSING_CREDENTIAL_CODE = "missing_credentials";

/**
 * A required credential is absent. Thrown before any client is constructed, so
 * no request is ever built with a borrowed key.
 *
 * `code` is what `BaseProvider` lifts into `RunError.code`, and `run-summary.ts`
 * classifies it as `missing-credentials` — the status that does not fail the run,
 * because the README promises an unconfigured provider leaves the rest of the run
 * intact.
 */
export class MissingCredentialError extends Error {
  override readonly name = "MissingCredentialError";
  readonly code = MISSING_CREDENTIAL_CODE;
  /** The environment variable the operator has to set. */
  readonly variable: string;
  /** The service that variable authenticates against. */
  readonly service: string;

  constructor(variable: string, service: string) {
    super(
      `Missing credentials: ${variable} is not set, so ${service} cannot run. Set ${variable} in .env, or drop ${service} from your targets. No request was sent.`,
    );
    this.variable = variable;
    this.service = service;
  }
}

/**
 * Read `variable` from the environment, or throw a `MissingCredentialError`
 * naming it. Use this for every client whose endpoint is not the SDK's own —
 * passing `process.env.X` straight through is the bug this exists to prevent.
 *
 * A variable set to whitespace counts as absent: an empty `.env` line is an
 * unconfigured provider, not a credential to send.
 */
export function requireApiKey(
  variable: string,
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const value = env[variable];
  if (value === undefined || value.trim() === "") {
    throw new MissingCredentialError(variable, service);
  }
  return value;
}
