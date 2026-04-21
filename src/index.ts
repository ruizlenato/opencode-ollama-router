import { Plugin } from "@opencode-ai/plugin";
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

interface OllamaRouterAuthConfig {
  keys?: string[];
  providerId?: string;
  maxRetries?: number;
  failWindowMs?: number;
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

export const OllamaRouterAuth: Plugin = async ({ client }) => {
  const config = await readPluginConfig();
  const providerId = config.providerId || DEFAULT_PROVIDER_ID;
  const maxRetries = getMaxRetries(config);
  const failWindowMs = getFailWindowMs(config);

  const configKeys = getApiKeysFromConfig(config);
  const envKeys = getApiKeysFromEnv();
  const allKeys = [...configKeys, ...envKeys];
  const uniqueKeys = deduplicateKeys(allKeys);

  if (uniqueKeys.length === 0) return {};

  let existingConfig: OllamaRouterAuthConfig = {};
  try {
    const content = await readFile(PLUGIN_CONFIG_JSON_PATH, "utf-8");
    existingConfig = JSON.parse(content);
  } catch {
  }

  const allowedKeys = new Set(uniqueKeys);
  const failedKeys = new Map<string, number>();
  for (const [key, failedAt] of Object.entries(existingConfig.failedKeys || {})) {
    if (allowedKeys.has(key) && typeof failedAt === "number")
      failedKeys.set(key, failedAt);
  }

  const writeState = async () => {
    await mkdir(STATE_DIR, { recursive: true });
    await writeFile(
      PLUGIN_CONFIG_JSON_PATH,
      JSON.stringify({ ...existingConfig, failedKeys: Object.fromEntries(failedKeys) }, null, 2),
      "utf-8",
    );
  };

  let currentKeyIndex = Math.floor(Math.random() * uniqueKeys.length);

  function isKeyAvailable(key: string, now: number): boolean {
    const failedAt = failedKeys.get(key);
    if (failedAt === undefined) return true;
    if (now - failedAt >= failWindowMs) {
      failedKeys.delete(key);
      return true;
    }
    return false;
  }

  function getAvailableKeysShuffled(): { index: number; key: string }[] {
    const now = Date.now();
    const available: { index: number; key: string }[] = [];
    for (let i = 0; i < uniqueKeys.length; i++) {
      const key = uniqueKeys[i];
      if (isKeyAvailable(key, now)) available.push({ index: i, key });
    }
    return shuffleArray(available);
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

            const shuffledKeys = getAvailableKeysShuffled();
            const keyErrors: {
              index: number;
              key: string;
              status: number;
              message: string;
            }[] = [];

            for (const { index, key } of shuffledKeys) {
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

                let responseBody = "";
                let responseClone: Response | null = null;
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

                if (responseClone.status >= 500 || responseClone.status === 200) {
                  await log(
                    "info",
                    `Response status ${responseClone.status}`,
                    {
                      status: responseClone.status,
                      keyIndex: currentKeyIndex + 1,
                      body: responseBody.slice(0, 300),
                    },
                  );
                } else {
                  await log(
                    "info",
                    `Response status ${responseClone.status}`,
                    {
                      status: responseClone.status,
                      keyIndex: currentKeyIndex + 1,
                    },
                  );
                }

                if (isAuthErrorByStatus(responseClone.status)) {
                const isSubscriptionError = responseBody.includes(
                  "this model requires a subscription",
                );

                if (isSubscriptionError) {
                  failedKeys.set(key, Date.now());
                  await writeState();
                  const refMatch = responseBody.match(/ref: ([^)]+)/);
                  await log(
                    "info",
                    `Model access denied (${responseClone.status})`,
                    {
                      status: responseClone.status,
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
                    `Auth/rate-limit error (${responseClone.status})`,
                    {
                      status: responseClone.status,
                      keyIndex: currentKeyIndex + 1,
                    },
                  );
                  await showToast(
                    "warning",
                    `Key ${currentKeyIndex + 1} failed (${responseClone.status}), trying next...`,
                  );
                }

                keyErrors.push({
                    index: currentKeyIndex,
                    key: getMaskedKeyPreview(key),
                    status: responseClone.status,
                    message: isSubscriptionError
                      ? `subscription_error: ref=${responseBody.match(/ref: ([^)]+)/)?.[1] || "unknown"}`
                      : `auth_error_${responseClone.status}`,
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
                return responseClone;
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
  };
};

export default OllamaRouterAuth;
