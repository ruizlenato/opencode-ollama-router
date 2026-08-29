import { Plugin, type ProviderHookContext } from "@opencode-ai/plugin";
import type { Provider as ProviderV2, Model as ModelV2 } from "@opencode-ai/sdk/v2";
import { readFile, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const DEFAULT_PROVIDER_ID = "ollama-router";
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_FAIL_WINDOW_MS = 18000000;
const AUTH_JSON_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "auth.json",
);
const STATE_DIR = join(homedir(), ".opencode");
const PLUGIN_CONFIG_JSON_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "ollama-router.json",
);
const PLUGIN_CONFIG_JSONC_PATH = join(
  homedir(),
  ".config",
  "opencode",
  "ollama-router.jsonc",
);

const OLLAMA_API_BASE = "https://ollama.com";

/** Model info returned by Ollama /api/show */
interface OllamaModelShow {
  capabilities?: string[];
  model_info?: Record<string, number | string>;
  details?: {
    family?: string;
    parameter_size?: string;
  };
}

/** Cache for model capabilities fetched from Ollama API */
let modelsCache: Record<string, OllamaModelShow> | null = null;
let modelsCacheExpiry = 0;
const MODELS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface OllamaRouterAuthConfig {
  keys?: string[];
  providerId?: string;
  maxRetries?: number;
  failWindowMs?: number;
  shuffle?: boolean;
  failedKeys?: Record<string, number>;
}

function isQuoteEscaped(input: string, quoteIndex: number): boolean {
  let backslashes = 0;
  let i = quoteIndex - 1;
  while (i >= 0 && input[i] === "\\") {
    backslashes++;
    i--;
  }
  return backslashes % 2 === 1;
}

function stripJsonComments(input: string): string {
  let output = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (current === "\n") inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        inBlockComment = false;
        i++;
        continue;
      }
      continue;
    }

    if (!inString && current === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }

    if (!inString && current === "/" && next === "*") {
      inBlockComment = true;
      i += 2;
      continue;
    }

    if (current === '"') {
      inString = !inString;
    }

    output += current;
  }

  return output;
}

function removeTrailingCommas(input: string): string {
  let output = "";
  let inString = false;

  for (let i = 0; i < input.length; i++) {
    const current = input[i];
    if (current === '"' && !isQuoteEscaped(input, i)) {
      inString = !inString;
      output += current;
      continue;
    }
    if (!inString && current === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      const next = input[j];
      if (next === "}" || next === "]") continue;
    }
    output += current;
  }

  return output;
}

function parseJsonOrJsonc(content: string): OllamaRouterAuthConfig {
  const cleaned = removeTrailingCommas(stripJsonComments(content));
  return JSON.parse(cleaned);
}

async function readPluginConfig(): Promise<OllamaRouterAuthConfig> {
  const path = existsSync(PLUGIN_CONFIG_JSONC_PATH)
    ? PLUGIN_CONFIG_JSONC_PATH
    : PLUGIN_CONFIG_JSON_PATH;
  if (!existsSync(path)) return {};
  try {
    const content = await readFile(path, "utf-8");
    return parseJsonOrJsonc(content);
  } catch (err) {
    console.warn(`[ollama-router] Config parse error: ${err}`);
    return {};
  }
}

async function readAuthJson(): Promise<Record<string, any>> {
  try {
    if (!existsSync(AUTH_JSON_PATH)) return {};
    const content = await readFile(AUTH_JSON_PATH, "utf-8");
    return JSON.parse(content);
  } catch {
    return {};
  }
}

async function writeAuthJson(auth: Record<string, any>): Promise<void> {
  await writeFile(AUTH_JSON_PATH, JSON.stringify(auth, null, 2), "utf-8");
}

async function updateKey(key: string, targetProviderId: string): Promise<void> {
  const auth = await readAuthJson();
  if (
    auth[targetProviderId]?.type === "api" &&
    auth[targetProviderId]?.key === key
  )
    return;
  auth[targetProviderId] = { type: "api", key };
  await writeAuthJson(auth);
}

function getApiKeysFromConfig(config: OllamaRouterAuthConfig): string[] {
  if (Array.isArray(config.keys))
    return config.keys.filter((k) => typeof k === "string");
  return [];
}

function getApiKeysFromEnv(): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  const mainKey = process.env.OLLAMA_API_KEY;
  if (mainKey && !seen.has(mainKey)) {
    seen.add(mainKey);
    keys.unshift(mainKey);
  }
  let i = 1;
  while (true) {
    const envKey = `OLLAMA_API_KEY_${i}`;
    const value = process.env[envKey];
    if (!value) break;
    if (!seen.has(value)) {
      seen.add(value);
      keys.push(value);
    }
    i++;
  }
  return keys;
}

function deduplicateKeys(keys: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(key);
    }
  }
  return unique;
}

function isAuthErrorByStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429;
}

function getMaxRetries(config: OllamaRouterAuthConfig): number {
  const value = config.maxRetries;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return DEFAULT_MAX_RETRIES;
  return Math.floor(value);
}

function getFailWindowMs(config: OllamaRouterAuthConfig): number {
  const value = config.failWindowMs;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    return DEFAULT_FAIL_WINDOW_MS;
  return Math.floor(value);
}

function shuffleArray<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function fetchModelShow(
  modelName: string,
  apiKey: string,
): Promise<OllamaModelShow | null> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/show`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchAvailableModels(
  apiKey: string,
): Promise<Array<{ name: string; model?: string }> | null> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
    const res = await fetch(`${OLLAMA_API_BASE}/api/tags`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.models)) return null;
    return data.models;
  } catch {
    return null;
  }
}

async function fetchAllModelCapabilities(
  apiKey: string,
): Promise<Record<string, OllamaModelShow>> {
  const now = Date.now();
  if (modelsCache && now < modelsCacheExpiry) return modelsCache;

  const models = await fetchAvailableModels(apiKey);
  if (!models) return modelsCache || {};

  const results: Record<string, OllamaModelShow> = {};
  await Promise.all(
    models.map(async (m) => {
      const name = m.name || m.model;
      if (!name) return;
      const show = await fetchModelShow(name, apiKey);
      if (show) results[name] = show;
    }),
  );

  modelsCache = results;
  modelsCacheExpiry = now + MODELS_CACHE_TTL;
  return results;
}

/**
 * Convert Ollama API capabilities + model_info into an OpenCode model definition
 * with full capability metadata.
 */
function buildModelEntry(
  modelId: string,
  show: OllamaModelShow | null,
  staticEntry: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const caps = show?.capabilities || [];
  const modelInfo = show?.model_info || {};
  const family = show?.details?.family || (modelId.split(/[:/-]/)[0]?.toLowerCase());

  // Derive context length from model_info (arch-specific key like "glm5.1.context_length")
  let contextLength = 0;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && typeof value === "number") {
      contextLength = value;
      break;
    }
  }

  // Start with static config values (from opencode.json) as the base
  const entry: Record<string, unknown> = {
    id: modelId,
    family,
    ...(staticEntry || {}),
  };

  // Name: use static if set, else derive from model ID
  if (!entry.name) {
    entry.name = modelId
      .split(":")[0]
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Capabilities from Ollama API
  const hasVision = caps.includes("vision");
  const hasTools = caps.includes("tools");
  const hasThinking = caps.includes("thinking");

  // Only override if static config doesn't already set these explicitly
  if (entry.attachment === undefined) entry.attachment = hasVision;
  if (entry.reasoning === undefined) entry.reasoning = hasThinking;
  if (entry.tool_call === undefined) entry.tool_call = hasTools;
  if (entry.temperature === undefined) entry.temperature = true;

  if (entry.interleaved === undefined && hasThinking) {
    entry.interleaved = { field: "reasoning_content" };
  }

  // Modalities
  if (entry.modalities === undefined) {
    entry.modalities = {
      input: ["text", ...(hasVision ? ["image" as const] : [])],
      output: ["text"],
    };
  }

  // Context length
  if (contextLength > 0 && entry.limit === undefined) {
    entry.limit = {
      context: contextLength,
      output: Math.min(contextLength, 16384),
    };
  } else if (contextLength > 0 && typeof entry.limit === "object") {
    const limit = entry.limit as Record<string, unknown>;
    if (!limit.context) limit.context = contextLength;
  }

  return entry;
}

export const OllamaRouterAuth: Plugin = async ({ client }) => {
  // Mutable state — re-read from disk on every request via syncConfigFromDisk()
  let providerId = DEFAULT_PROVIDER_ID;
  let maxRetries = DEFAULT_MAX_RETRIES;
  let failWindowMs = DEFAULT_FAIL_WINDOW_MS;
  let shuffle = true;
  let uniqueKeys: string[] = [];
  let staticModels: Record<string, Record<string, unknown>> = {};
  let existingConfig: OllamaRouterAuthConfig = {};
  const failedKeys = new Map<string, number>();

  /**
   * Re-read all config from disk so changes made via the setup script
   * (adding/removing keys, changing maxRetries, failWindowMs, shuffle,
   * resetting failed keys, etc.) take effect immediately without restarting
   * OpenCode.
   */
  async function syncConfigFromDisk(): Promise<void> {
    const config = await readPluginConfig();
    providerId = config.providerId || DEFAULT_PROVIDER_ID;
    maxRetries = getMaxRetries(config);
    failWindowMs = getFailWindowMs(config);
    shuffle = config.shuffle !== false; // default true

    const configKeys = getApiKeysFromConfig(config);
    const envKeys = getApiKeysFromEnv();
    const allKeys = [...configKeys, ...envKeys];
    uniqueKeys = deduplicateKeys(allKeys);

    // Re-read opencode.json for model list enrichment
    try {
      const opencodeJsonPath = join(homedir(), ".config", "opencode", "opencode.json");
      if (existsSync(opencodeJsonPath)) {
        const raw = await readFile(opencodeJsonPath, "utf-8");
        const parsed = JSON.parse(raw);
        staticModels = parsed?.provider?.[providerId]?.models || {};
      }
    } catch {
      // Non-critical
    }

    // Re-read state file for failedKeys
    try {
      const content = await readFile(PLUGIN_CONFIG_JSON_PATH, "utf-8");
      existingConfig = JSON.parse(content);
    } catch {
      existingConfig = {};
    }

    // Sync in-memory failedKeys with disk
    const diskFailed = existingConfig.failedKeys || {};

    // If disk has empty failedKeys, clear the in-memory map (reset triggered by setup script)
    if (Object.keys(diskFailed).length === 0 && failedKeys.size > 0) {
      failedKeys.clear();
    } else {
      // Remove in-memory entries that are no longer on disk (removed by setup)
      for (const key of failedKeys.keys()) {
        if (!(key in diskFailed)) {
          failedKeys.delete(key);
        }
      }
      // Add entries from disk that aren't in memory
      const allowedKeys = new Set(uniqueKeys);
      for (const [key, failedAt] of Object.entries(diskFailed)) {
        if (allowedKeys.has(key) && typeof failedAt === "number" && !failedKeys.has(key)) {
          failedKeys.set(key, failedAt);
        }
      }
    }
  }

  // Initial load
  await syncConfigFromDisk();
  if (uniqueKeys.length === 0) return {};

  const writeState = async () => {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(
      PLUGIN_CONFIG_JSON_PATH,
      JSON.stringify({ ...existingConfig, failedKeys: Object.fromEntries(failedKeys) }, null, 2),
      "utf-8",
    );
  };

  let currentKeyIndex = shuffle
    ? Math.floor(Math.random() * uniqueKeys.length)
    : 0;

  function isKeyAvailable(key: string, now: number): boolean {
    const failedAt = failedKeys.get(key);
    if (failedAt === undefined) return true;
    if (now - failedAt >= failWindowMs) {
      failedKeys.delete(key);
      return true;
    }
    return false;
  }

  function getAvailableKeysOrdered(): { index: number; key: string }[] {
    const now = Date.now();
    const available: { index: number; key: string }[] = [];
    for (let i = 0; i < uniqueKeys.length; i++) {
      const key = uniqueKeys[i];
      if (isKeyAvailable(key, now)) available.push({ index: i, key });
    }
    return shuffle ? shuffleArray(available) : available;
  }

  function getMaskedKeyPreview(key: string): string {
    return key.slice(0, 5);
  }

  async function log(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await client.app.log({
        body: { service: "ollama-router", level, message, extra },
      });
    } catch {
      console.warn(`[ollama-router] Log error: ${message}`);
    }
  }

  async function showToast(
    variant: "info" | "success" | "warning" | "error",
    message: string,
    duration = 2500,
  ): Promise<void> {
    try {
      await client.tui.showToast({
        body: { title: "ollama-router", message, variant, duration },
      });
    } catch {
      console.warn(`[ollama-router] Toast error: ${message}`);
    }
  }

  function throwIfAborted(signal?: AbortSignal | null): void {
    if (signal?.aborted)
      throw new Error(`[${providerId}] Request aborted by user`);
  }

  let lastToastKeyIndex = -1;

  return {
    auth: {
      provider: providerId,
      loader: async () => {
        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const signal = init?.signal ?? undefined;
            throwIfAborted(signal);

            // Re-read all config from disk before each request (allows runtime changes without restart)
            await syncConfigFromDisk();

            if (uniqueKeys.length === 0) {
              throw new Error(
                `[${providerId}] No API keys configured. Add keys via opencode-ollama-router-setup or the OLLAMA_API_KEY environment variable.`,
              );
            }

            const orderedKeys = getAvailableKeysOrdered();
            const keyErrors: {
              index: number;
              key: string;
              status: number;
              message: string;
            }[] = [];

            for (const { index, key } of orderedKeys) {
              currentKeyIndex = index;

              for (let retry = 0; retry < maxRetries; retry++) {
                const isRetry = retry > 0;

                if (isRetry) {
                  await log("info", `Retry ${retry}/${maxRetries - 1} for key ${getMaskedKeyPreview(key)}`, {
                    keyIndex: currentKeyIndex + 1, retry, maxRetries
                  });
                } else {
                  await log(
                    "info",
                    `Trying key ${currentKeyIndex + 1}/${uniqueKeys.length} (${getMaskedKeyPreview(key)})`,
                    {
                      keyIndex: currentKeyIndex + 1,
                      totalKeys: uniqueKeys.length,
                    },
                  );

                  if (lastToastKeyIndex !== currentKeyIndex) {
                    await showToast(
                      "info",
                      `Using key ${getMaskedKeyPreview(key)}...`,
                    );
                    lastToastKeyIndex = currentKeyIndex;
                  }
                }

                const headers = new Headers(init?.headers);
                headers.delete("authorization");
                headers.delete("Authorization");
                headers.set("Authorization", `Bearer ${key}`);

                const response = await fetch(input, { ...init, headers, signal });

                // Pass streaming (SSE) responses through live so first tokens reach
                // OpenCode immediately — buffering would stall the UI for minutes
                // while a model reasons, until OpenCode's chunk/step timeout aborts.
                const contentType = response.headers.get("content-type") || "";
                const isEventStream = contentType.includes("text/event-stream");

                let responseBody = "";
                let responseClone: Response | null = null;
                if (isEventStream) {
                  responseClone = response;
                } else {
                  try {
                    responseBody = await response.text();
                    responseClone = new Response(responseBody, {
                      status: response.status,
                      statusText: response.statusText,
                      headers: response.headers,
                    });
                  } catch {
                    responseClone = response;
                  }
                }

                if (!isEventStream && (responseClone!.status >= 500 || responseClone!.status === 200)) {
                  await log(
                    "info",
                    `Response status ${responseClone!.status}`,
                    {
                      status: responseClone!.status,
                      keyIndex: currentKeyIndex + 1,
                      body: responseBody.slice(0, 300),
                    },
                  );
                } else {
                  await log(
                    "info",
                    `Response status ${responseClone!.status}`,
                    {
                      status: responseClone!.status,
                      keyIndex: currentKeyIndex + 1,
                      stream: isEventStream || undefined,
                    },
                  );
                }

                if (isAuthErrorByStatus(responseClone!.status)) {
                  // After streaming has started we cannot retry transparently on a
                  // different key — bytes were already consumed by the caller.
                  const isSubscriptionError = isEventStream
                    ? false
                    : responseBody.includes(
                        "this model requires a subscription",
                      );

                if (!isEventStream && isSubscriptionError) {
                  failedKeys.set(key, Date.now());
                  await writeState();
                  const refMatch = responseBody.match(/ref: ([^)]+)/);
                  await log(
                    "info",
                    `Model access denied (${responseClone!.status})`,
                    {
                      status: responseClone!.status,
                      keyIndex: currentKeyIndex + 1,
                      type: "subscription_error",
                      ref: refMatch?.[1] || "unknown",
                    },
                  );
                  await showToast(
                    "error",
                    `Key has no model access (ref: ${refMatch?.[1] || "unknown"})`,
                  );
                } else {
                  failedKeys.set(key, Date.now());
                  await writeState();
                  await log(
                    "info",
                    `Auth/rate-limit error (${responseClone!.status})`,
                    {
                      status: responseClone!.status,
                      keyIndex: currentKeyIndex + 1,
                    },
                  );
                  await showToast(
                    "warning",
                    `Key ${currentKeyIndex + 1} failed (${responseClone!.status}), trying next...`,
                  );
                }

                keyErrors.push({
                    index: currentKeyIndex,
                    key: getMaskedKeyPreview(key),
                    status: responseClone!.status,
                    message: isSubscriptionError
                      ? `subscription_error: ref=${responseBody.match(/ref: ([^)]+)/)?.[1] || "unknown"}`
                      : `auth_error_${responseClone!.status}`,
                  });

                  if (failedKeys.size >= uniqueKeys.length) {
                    const summary = keyErrors.length;
                    const subscriptionCount = keyErrors.filter((e) =>
                      e.message.includes("subscription_error"),
                    ).length;
                    const rateLimitCount = keyErrors.filter(
                      (e) => e.status === 429,
                    ).length;
                    const otherCount =
                      summary - subscriptionCount - rateLimitCount;

                    const detailList = keyErrors
                      .map(
                        (e, i) =>
                          `  ${i + 1}. key${e.index + 1} (${e.key}...) - ${e.status}\n     ${e.message}`,
                      )
                      .join("\n\n");

                    let reason = "unknown";
                    if (subscriptionCount === summary)
                      reason =
                        "keys have no model access (subscription required)";
                    else if (rateLimitCount === summary)
                      reason = "all keys are rate-limited";

                    const fullMessage = [
                      `[${providerId}] ALL KEYS EXHAUSTED!`,
                      `Summary: ${summary} keys failed.`,
                      `${subscriptionCount} no model access, ${rateLimitCount} rate-limited, ${otherCount} other errors.`,
                      reason !== "unknown" ? `Reason: ${reason}` : "",
                      "",
                      `Details:\n${detailList}`,
                    ]
                      .filter(Boolean)
                      .join("\n");

                    throw new Error(fullMessage);
                  }

                  continue;
                }

                await updateKey(key, providerId);
                await log("debug", `Request successful with key ${getMaskedKeyPreview(key)}`);
                return responseClone!;
              }
            }

            throw new Error(
              `[${providerId}] No available keys found. All keys may be in fail window (${failWindowMs}ms). Please wait and retry later.`,
            );
          },
        };
      },
      methods: [{ type: "api" as const, label: "Ollama Router API" }],
    },
      provider: {
        id: providerId,
        models: async (provider: ProviderV2, ctx: ProviderHookContext) => {
          // Re-read config so model list reflects latest changes without restart
          await syncConfigFromDisk();

          // Use the first available key for API calls
          const authKey = ctx.auth?.type === "api" || ctx.auth?.type === "wellknown" ? (ctx.auth as { key: string }).key : "";
          const apiKey = authKey || uniqueKeys[0] || "";
        const caps = apiKey ? await fetchAllModelCapabilities(apiKey) : {};

        const models: Record<string, ModelV2> = {};

        // If we have static models from opencode.json, enrich them
        // Otherwise build from what the Ollama API returned
        const modelIds = Object.keys(staticModels).length > 0
          ? Object.keys(staticModels)
          : Object.keys(caps).length > 0
            ? Object.keys(caps)
            : [];

        for (const modelId of modelIds) {
          const show = caps[modelId] || null;
          const staticEntry = staticModels[modelId];
          const enriched = buildModelEntry(modelId, show, staticEntry as Record<string, unknown> | undefined);

          models[modelId] = {
            id: (enriched.id as string) || modelId,
            providerID: providerId,
            api: {
              id: modelId,
              url: "https://ollama.com/v1",
              npm: "@ai-sdk/openai-compatible",
            },
            name: (enriched.name as string) || modelId,
            family: (enriched.family as string) || undefined,
            capabilities: {
              temperature: (enriched.temperature as boolean) ?? true,
              reasoning: (enriched.reasoning as boolean) ?? false,
              attachment: (enriched.attachment as boolean) ?? false,
              toolcall: (enriched.tool_call as boolean) ?? true,
              input: {
                text: true,
                audio: false,
                image: (enriched.attachment as boolean) ?? false,
                video: false,
                pdf: (enriched.attachment as boolean) ?? false,
              },
              output: {
                text: true,
                audio: false,
                image: false,
                video: false,
                pdf: false,
              },
              interleaved: enriched.interleaved
                ? (enriched.interleaved as boolean | { field: "reasoning_content" | "reasoning_details" })
                : false,
            },
            cost: {
              input: (enriched.cost as Record<string, unknown>)?.input as number || 0,
              output: (enriched.cost as Record<string, unknown>)?.output as number || 0,
              cache: {
                read: (enriched.cost as Record<string, unknown>)?.cache_read as number || 0,
                write: (enriched.cost as Record<string, unknown>)?.cache_write as number || 0,
              },
            },
            limit: {
              context: (enriched.limit as Record<string, unknown>)?.context as number || 0,
              output: (enriched.limit as Record<string, unknown>)?.output as number || 4096,
            },
            status: "active",
            options: {},
            headers: {},
            release_date: (enriched.release_date as string) || "",
          } satisfies ModelV2;
        }

        return models;
      },
    },
  };
};

export default OllamaRouterAuth;
