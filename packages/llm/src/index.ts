import { AnthropicLlm, DEFAULT_MODEL } from "./anthropic.ts";
import { UnavailableLlm } from "./scripted.ts";
import type { Effort, LlmClient } from "./types.ts";

export * from "./types.ts";
export * from "./anthropic.ts";
export * from "./scripted.ts";
export * from "./embeddings.ts";
export * from "./json.ts";
export * from "./schema.ts";

/**
 * Pick the LLM from the environment:
 * - EB_LLM_PROVIDER=anthropic forces Claude (credentials from ANTHROPIC_API_KEY,
 *   ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile);
 * - EB_LLM_PROVIDER=offline forces offline mode;
 * - otherwise Claude is used when Anthropic credentials are present.
 */
export function createLlmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient {
  const provider = env.EB_LLM_PROVIDER?.toLowerCase();
  if (provider === "offline" || provider === "none") return new UnavailableLlm();
  const hasCredentials = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE);
  if (provider === "anthropic" || hasCredentials) {
    return new AnthropicLlm({
      model: env.EB_LLM_MODEL || DEFAULT_MODEL,
      fallbacks: env.EB_LLM_FALLBACKS !== "off",
      defaultEffort: (env.EB_LLM_EFFORT as Effort | undefined) || undefined,
    });
  }
  return new UnavailableLlm();
}
