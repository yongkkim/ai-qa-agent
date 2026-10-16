import { LLMRequestError } from "./types.js";

export interface PostOptions {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  /** Provider name, used in error messages. */
  provider: string;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 5 retries with exponential backoff ≈ 1 minute of patience for overloaded (503) or rate-limited (429) providers. */
export const DEFAULT_RETRIES = 5;

/**
 * POST JSON with timeout and retry on rate limits / server errors.
 * Free tiers (Gemini especially) return 429 often, so backing off matters.
 */
export async function postJson<T>({ url, headers, body, provider, timeoutMs = 120_000, retries = DEFAULT_RETRIES }: PostOptions): Promise<T> {
  let attempt = 0;
  for (;;) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt < retries) {
        await sleep(backoff(attempt++));
        continue;
      }
      throw new LLMRequestError(`[${provider}] could not reach ${new URL(url).origin} after ${retries + 1} attempts: ${msg}`, undefined, true);
    }

    if (res.ok) return (await res.json()) as T;

    const text = await res.text();
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < retries) {
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      attempt++;
      continue;
    }
    const tries = retryable ? ` (after ${attempt + 1} attempts)` : "";
    throw new LLMRequestError(`[${provider}] HTTP ${res.status}: ${explain(res.status)}${tries}\n${truncate(text, 800)}`, res.status, retryable);
  }
}

function backoff(attempt: number) {
  // 2s, 4s, 8s, 16s, 30s (+ jitter so parallel clients don't retry in lockstep)
  return Math.min(30_000, 2_000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function explain(status: number): string {
  if (status === 400) return "the provider rejected the request (often a wrong model name or unsupported option)";
  if (status === 401 || status === 403) return "the API key is missing, invalid, or not allowed to use this model";
  if (status === 404) return "model or endpoint not found (check LLM_MODEL / LLM_BASE_URL)";
  if (status === 429) return "rate limit or quota exceeded (free tiers have per-minute and per-day limits)";
  if (status === 503 || status === 529) return "the provider is overloaded or temporarily unavailable (not a problem with your setup; retry later or use another model)";
  if (status >= 500) return "the provider had a server error (usually temporary)";
  return "request failed";
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
