import { LLMRequestError, type ChatRequest, type ChatResponse, type LLMProvider } from "./types.js";

/**
 * Tries a list of models in order. When the current one is unavailable even
 * after its own retries (overloaded 503, rate limit 429, server or network
 * error), the run switches to the next model and stays there, so one busy
 * model doesn't sink a whole test run. Errors you can fix (bad key, wrong
 * model name) are thrown immediately instead of being hidden by a fallback.
 * Enable with LLM_FALLBACK_MODELS=model-a,model-b.
 */
export class FallbackProvider implements LLMProvider {
  private current = 0;

  constructor(
    private readonly chain: LLMProvider[],
    private readonly onSwitch: (from: LLMProvider, to: LLMProvider, reason: string) => void = (from, to, reason) =>
      console.warn(`[llm] ${from.provider}/${from.model} unavailable (${reason}); switching to ${to.provider}/${to.model}`),
  ) {
    if (!chain.length) throw new Error("FallbackProvider needs at least one provider");
  }

  get provider() {
    return this.chain[this.current].provider;
  }

  get model() {
    return this.chain[this.current].model;
  }

  /** Every model this instance has used so far, e.g. ["gemini-3.8-flash", "gemini-3.5-flash-lite"]. */
  get modelsUsed() {
    return this.chain.slice(0, this.current + 1).map((p) => p.model);
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    for (;;) {
      try {
        return await this.chain[this.current].chat(req);
      } catch (err) {
        const transient = err instanceof LLMRequestError && err.retryable;
        if (!transient || this.current >= this.chain.length - 1) throw err;
        const from = this.chain[this.current++];
        this.onSwitch(from, this.chain[this.current], `${err.status ? `HTTP ${err.status}` : "network error"}`);
      }
    }
  }
}
