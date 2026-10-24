import { FallbackProvider } from "./fallback.js";
import { JsonToolCallingProvider } from "./json-tools.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAICompatibleProvider } from "./providers/openai.js";
import { LLMConfigError, type LLMProvider } from "./types.js";

export const SUPPORTED_PROVIDERS = ["gemini", "openai", "anthropic", "ollama", "openai-compatible"] as const;
export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export interface LLMConfig {
  provider: ProviderName;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  toolMode: "native" | "json";
  /** Same-provider models to switch to when the main one is overloaded or rate-limited. */
  fallbackModels: string[];
  /** HTTP retries per request before giving up (or falling back). */
  maxRetries?: number;
  /** The model can read screenshots (used by the agent's look tool for visual criteria). */
  vision: boolean;
}

const DEFAULT_MODELS: Partial<Record<ProviderName, string>> = {
  gemini: "gemini-3.5-flash-lite",
  anthropic: "claude-sonnet-5-5",
};

const KEY_FALLBACKS: Partial<Record<ProviderName, string>> = {
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
};

const KEY_URLS: Partial<Record<ProviderName, string>> = {
  gemini: "https://aistudio.google.com/apikey",
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
};

const HINT = "Run `npm run setup`, or copy .env.example to .env and fill in the LLM section (see README → Choosing a model).";

/** Reads and validates LLM settings from env vars. Throws LLMConfigError with a human-readable fix. */
export function readLLMConfig(env: NodeJS.ProcessEnv = process.env): LLMConfig {
  const provider = (env.LLM_PROVIDER ?? "").trim().toLowerCase();
  if (!provider) throw new LLMConfigError(`LLM_PROVIDER is not set. ${HINT}`);
  if (!SUPPORTED_PROVIDERS.includes(provider as ProviderName)) {
    throw new LLMConfigError(`LLM_PROVIDER="${provider}" is not supported. Use one of: ${SUPPORTED_PROVIDERS.join(", ")}.`);
  }
  const p = provider as ProviderName;

  const model = (env.LLM_MODEL ?? "").trim() || DEFAULT_MODELS[p];
  if (!model) throw new LLMConfigError(`LLM_MODEL is required for provider "${p}". ${HINT}`);

  const fallbackVar = KEY_FALLBACKS[p];
  const apiKey = (env.LLM_API_KEY ?? "").trim() || (fallbackVar ? (env[fallbackVar] ?? "").trim() : "") || undefined;
  const needsKey = p === "gemini" || p === "openai" || p === "anthropic";
  if (needsKey && !apiKey) throw new LLMConfigError(
      `LLM_API_KEY is empty, but provider "${p}" needs an API key.` +
        (KEY_URLS[p] ? ` Get one at ${KEY_URLS[p]}, then put it in .env as LLM_API_KEY=... (or run \`npm run setup\` again).` : ` ${HINT}`),
    );

  let baseUrl = (env.LLM_BASE_URL ?? "").trim() || undefined;
  if (p === "ollama") baseUrl ??= "http://localhost:11434/v1";
  if (p === "openai-compatible" && !baseUrl) {
    throw new LLMConfigError(`LLM_BASE_URL is required for provider "openai-compatible" (e.g. https://api.groq.com/openai/v1).`);
  }

  const toolMode = (env.LLM_TOOL_MODE ?? "native").trim().toLowerCase();
  if (toolMode !== "native" && toolMode !== "json") throw new LLMConfigError(`LLM_TOOL_MODE must be "native" or "json".`);

  const fallbackModels = (env.LLM_FALLBACK_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m && m !== model);

  const retriesRaw = (env.LLM_MAX_RETRIES ?? "").trim();
  const maxRetries = retriesRaw === "" ? undefined : Number(retriesRaw);
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries < 0)) {
    throw new LLMConfigError(`LLM_MAX_RETRIES must be a whole number (got "${retriesRaw}").`);
  }

  // Hosted Gemini, OpenAI and Claude models read images; local and other compatible models often don't.
  const visionRaw = (env.LLM_VISION ?? "").trim().toLowerCase();
  if (visionRaw && visionRaw !== "true" && visionRaw !== "false") throw new LLMConfigError(`LLM_VISION must be "true" or "false" (got "${visionRaw}").`);
  const vision = visionRaw ? visionRaw === "true" : p === "gemini" || p === "openai" || p === "anthropic";

  return { provider: p, model, apiKey, baseUrl, toolMode, fallbackModels, maxRetries, vision };
}

export function createProvider(config: LLMConfig): LLMProvider {
  const build = (model: string): LLMProvider => {
    const common = { model, baseUrl: config.baseUrl, retries: config.maxRetries, vision: config.vision };
    let provider: LLMProvider;
    switch (config.provider) {
      case "gemini":
        provider = new GeminiProvider({ ...common, apiKey: config.apiKey! });
        break;
      case "anthropic":
        provider = new AnthropicProvider({ ...common, apiKey: config.apiKey! });
        break;
      case "openai":
      case "ollama":
      case "openai-compatible":
        provider = new OpenAICompatibleProvider({ ...common, apiKey: config.apiKey, providerName: config.provider });
        break;
    }
    return config.toolMode === "json" ? new JsonToolCallingProvider(provider) : provider;
  };

  const models = [config.model, ...config.fallbackModels];
  return models.length > 1 ? new FallbackProvider(models.map(build)) : build(config.model);
}

/** One-liner used by the apps: read env, validate, build the provider. */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider {
  return createProvider(readLLMConfig(env));
}
