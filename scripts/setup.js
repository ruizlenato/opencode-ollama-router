#!/usr/bin/env node

import { existsSync } from "fs";
import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import readline from "readline";

const CONFIG_PATH = join(homedir(), ".config", "opencode", "opencode.json");
const AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");
const PLUGIN_CONFIG_PATH = join(homedir(), ".config", "opencode", "ollama-router.json");
const IS_INTERACTIVE = Boolean(process.stdin.isTTY && process.stdout.isTTY);

const FALLBACK_MODELS = {
  "minimax-m2.7": { id: "minimax-m2.7", name: "MiniMax M2.7", family: "minimax", reasoning: true, tool_call: true, attachment: false, limit: { context: 196608, output: 16384 } },
  "qwen3-coder-next": { id: "qwen3-coder-next", name: "Qwen3 Coder Next", family: "qwen", reasoning: false, tool_call: true, attachment: false, limit: { context: 262144, output: 16384 } },
  "gpt-oss:120b": { id: "gpt-oss:120b", name: "GPT OSS 120B", family: "gpt", reasoning: true, tool_call: true, attachment: false, limit: { context: 131072, output: 16384 } },
  "mistral-large-3:675b": { id: "mistral-large-3:675b", name: "Mistral Large 3 675B", family: "mistral", reasoning: false, tool_call: true, attachment: true, limit: { context: 262144, output: 16384 } },
  "glm-4.7": { id: "glm-4.7", name: "GLM 4.7", family: "glm", reasoning: true, tool_call: true, attachment: false, limit: { context: 202752, output: 16384 } },
  "qwen3-next:80b": { id: "qwen3-next:80b", name: "Qwen3 Next 80B", family: "qwen", reasoning: true, tool_call: true, attachment: false, limit: { context: 262144, output: 16384 } },
  "gemma4:31b": { id: "gemma4:31b", name: "Gemma 4 31B", family: "gemma", reasoning: true, tool_call: true, attachment: true, limit: { context: 262144, output: 16384 } },
  "deepseek-v3.2": { id: "deepseek-v3.2", name: "DeepSeek V3.2", family: "deepseek", reasoning: true, tool_call: true, attachment: false, limit: { context: 163840, output: 16384 } },
  "devstral-small-2:24b": { id: "devstral-small-2:24b", name: "Devstral Small 2 24B", family: "devstral", reasoning: false, tool_call: true, attachment: true, limit: { context: 262144, output: 16384 } },
  "gemini-3-flash-preview": { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", family: "gemini", reasoning: true, tool_call: true, attachment: true, limit: { context: 1048576, output: 16384 } },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function question(prompt) {
  return new Promise((resolve) => rl.question(prompt, (answer) => resolve(answer.trim())));
}

async function ensureDir(dir) {
  try {
    await mkdir(dir, { recursive: true });
  } catch {}
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(path, data) {
  await ensureDir(join(path, ".."));
  await writeFile(path, JSON.stringify(data, null, 2));
}

function print(msg) {
  console.log(msg);
}

function clear() {
  console.clear();
}

function header() {
  clear();
  print("\n🦙 opencode-ollama-router Setup\n");
}

async function menu() {
  header();
  print("1. Add new API keys");
  print("2. List current keys");
  print("3. Remove a key");
  print("4. Configure options (fail window, max retries, key order)");
  print("5. Refresh models from Ollama API");
  print("6. Reset failed keys (clear rate-limit blocks without restart)");
  print("7. Exit\n");

  const choice = await question("Choose an option: ");
  return choice;
}

async function addKeys(config) {
  print("\n📝 Add API Keys\n");
  print("Enter your Ollama Cloud API keys (one per line).");
  print("Press Enter twice when done.\n");

  const keys = [];
  while (true) {
    const key = await question(`API Key ${keys.length + 1}: `);
    if (!key) break;
    keys.push(key);
  }

  if (keys.length === 0) {
    print("\n⚠️  No keys provided.");
    await question("\nPress Enter to continue...");
    return;
  }

  const currentKeys = config.keys || [];
  const newKeys = [...currentKeys, ...keys.filter((k) => !currentKeys.includes(k))];
  config.keys = newKeys;

  await writeJson(PLUGIN_CONFIG_PATH, config);

  const auth = (await readJson(AUTH_PATH)) || {};
  auth["ollama-router"] = { type: "api", key: newKeys[0] };
  await writeJson(AUTH_PATH, auth);

  print(`\n✅ Added ${keys.length} key(s). Total: ${newKeys.length}`);
  await question("\nPress Enter to continue...");
}

async function listKeys(config) {
  print("\n📋 Current Keys\n");
  const keys = config.keys || [];
  if (keys.length === 0) {
    print("No keys configured.");
  } else {
    keys.forEach((key, i) => print(`  ${i + 1}. ${key}`));
    print(`\nTotal: ${keys.length} key(s)`);
  }
  await question("\nPress Enter to continue...");
}

async function removeKey(config) {
  const keys = config.keys || [];
  if (keys.length === 0) {
    print("\n⚠️  No keys to remove.");
    return;
  }

  print("\n🗑️  Remove Key\n");
  keys.forEach((key, i) => print(`  ${i + 1}. ${key}`));
  print("\nEnter the number to remove (or 0 to cancel):");

  const choice = await question("> ");
  const idx = parseInt(choice) - 1;

  if (idx >= 0 && idx < keys.length) {
    const removed = keys.splice(idx, 1)[0];
    config.keys = keys;
    await writeJson(PLUGIN_CONFIG_PATH, config);

    const auth = (await readJson(AUTH_PATH)) || {};
    if (auth["ollama-router"]?.key === removed) {
      auth["ollama-router"] = { type: "api", key: keys[0] || "" };
      await writeJson(AUTH_PATH, auth);
    }

    print(`\n✅ Removed key: ${removed}`);
  }
  await question("\nPress Enter to continue...");
}

async function configureOptions(config) {
  print("\n⚙️  Configure Options\n");

  const currentRetries = config.maxRetries ?? 5;
  const currentFailWindow = config.failWindowMs ?? 18000000;
  const currentShuffle = config.shuffle !== false;

  print(`Current max retries: ${currentRetries}`);
  print(`Current fail window: ${currentFailWindow / 1000 / 60} minutes`);
  print(`Random key rotation: ${currentShuffle ? "enabled" : "disabled"}\n`);

  const newRetries = await question(`Max retries [${currentRetries}]: `);
  const newFailWindow = await question(`Fail window in minutes [${currentFailWindow / 1000 / 60}]: `);
  const newShuffle = await question(`Random key rotation (y/n) [${currentShuffle ? "y" : "n"}]: `);

  if (newRetries) config.maxRetries = parseInt(newRetries) || currentRetries;
  if (newFailWindow) config.failWindowMs = (parseInt(newFailWindow) * 60 * 1000) || currentFailWindow;
  if (newShuffle.toLowerCase() === "y" || newShuffle.toLowerCase() === "yes") {
    config.shuffle = true;
  } else if (newShuffle.toLowerCase() === "n" || newShuffle.toLowerCase() === "no") {
    config.shuffle = false;
  }

  await writeJson(PLUGIN_CONFIG_PATH, config);
  print(`\n✅ Options updated. Random key rotation: ${config.shuffle !== false ? "enabled" : "disabled"}.`);
  await question("\nPress Enter to continue...");
}

async function refreshModels(config) {
  print("\n🔄 Refresh Models from Ollama API\n");

  const apiKey = config.keys?.[0];
  if (!apiKey) {
    print("⚠️  No API keys configured. Add keys first (option 1).\n");
    await question("Press Enter to continue...");
    return;
  }

  const existingConfig = await readJson(CONFIG_PATH);
  if (!existingConfig) {
    print("⚠️  OpenCode configuration not found. Run setup again.\n");
    await question("Press Enter to continue...");
    return;
  }

  print("Fetching available models from Ollama...");
  const models = await fetchAvailableModels(apiKey);

  let modelsMap;
  let modelNames;
  let source;

  if (models && models.length > 0) {
    print(`Found ${models.length} models. Fetching capabilities for each...`);
    const showData = {};
    for (const m of models) {
      const id = m.name || m.model;
      if (!id) continue;
      const show = await fetchModelShow(id, apiKey);
      if (show) showData[id] = show;
    }
    modelsMap = buildModelsMap(models, showData);
    modelNames = models.map((m) => m.name || m.model).filter(Boolean);
    source = `Ollama API (${Object.keys(showData).length}/${models.length} with capabilities)`;
  } else {
    print("\n⚠️  Could not fetch models from Ollama API — using built-in fallback list.\n");
    modelsMap = FALLBACK_MODELS;
    modelNames = Object.keys(FALLBACK_MODELS);
    source = "fallback";
  }

  existingConfig.provider = existingConfig.provider || {};
  existingConfig.provider["ollama-router"] = {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://ollama.com/v1" },
    models: modelsMap,
  };

  if (!existingConfig.model) {
    existingConfig.model = `ollama-router/${modelNames[0]}`;
  }

  await writeJson(CONFIG_PATH, existingConfig);

  print(`\n✅ Updated ${modelNames.length} models in opencode.json (${source}):\n`);
  modelNames.forEach((name, i) => print(`  ${i + 1}. ${name}`));
  await question("\nPress Enter to continue...");
}

async function fetchAvailableModels(apiKey) {
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  try {
    const res = await fetch("https://ollama.com/api/tags", { headers });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data.models)) return null;
    return data.models;
  } catch {
    return null;
  }
}

async function fetchModelShow(modelName, apiKey) {
  try {
    const res = await fetch("https://ollama.com/api/show", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function buildModelsMap(models, showData = {}) {
  const map = {};
  for (const m of models) {
    const id = m.name || m.model;
    if (!id) continue;
    const show = showData[id];
    const caps = show?.capabilities || [];
    const modelInfo = show?.model_info || {};
    const hasVision = caps.includes("vision");
    const hasTools = caps.includes("tools");
    const hasThinking = caps.includes("thinking");

    // Derive context length from model_info
    let contextLength = 0;
    for (const [key, value] of Object.entries(modelInfo)) {
      if (key.endsWith(".context_length") && typeof value === "number") {
        contextLength = value;
        break;
      }
    }

    const family = show?.details?.family || m.details?.family || id.split(/[:/-]/)[0].toLowerCase();
    const name = id
      .split(":")[0]
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());

    const entry = { id, name, family };

    // Capabilities
    entry.attachment = hasVision;
    entry.reasoning = hasThinking;
    entry.tool_call = hasTools;
    entry.temperature = true;

    if (hasThinking) {
      entry.interleaved = { field: "reasoning_content" };
    }

    // Modalities
    entry.modalities = {
      input: ["text", ...(hasVision ? ["image"] : [])],
      output: ["text"],
    };

    // Context/limit
    if (contextLength > 0) {
      entry.limit = { context: contextLength, output: Math.min(contextLength, 16384) };
    }

    map[id] = entry;
  }
  return map;
}

async function registerPluginInConfig(existingConfig, modelsMap, firstModelId) {
  existingConfig.provider = existingConfig.provider || {};
  existingConfig.provider["ollama-router"] = {
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "https://ollama.com/v1" },
    models: modelsMap,
  };

  existingConfig.plugin = existingConfig.plugin || [];
  existingConfig.plugin = existingConfig.plugin.filter(
    (p) => !Array.isArray(p) && !p?.includes("ollama-router")
  );
  existingConfig.plugin.push("opencode-ollama-router");

  if (firstModelId && !existingConfig.model) {
    existingConfig.model = `ollama-router/${firstModelId}`;
  }

  await writeJson(CONFIG_PATH, existingConfig);
}

async function resetFailedKeys(config) {
  const failedKeys = config.failedKeys || {};
  const count = Object.keys(failedKeys).length;

  if (count === 0) {
    print("\n✅ No failed keys to reset. All keys are healthy.\n");
    await question("Press Enter to continue...");
    return;
  }

  print("\n🔑 Reset Failed Keys\n");
  print(`Found ${count} failed key(s):\n`);

  for (const [key, failedAt] of Object.entries(failedKeys)) {
    const ago = Math.round((Date.now() - failedAt) / 60000);
    const remaining = Math.max(0, Math.round((config.failWindowMs ?? 18000000 - (Date.now() - failedAt)) / 60000));
    print(`  ${key} — failed ${ago}m ago, ${remaining}m remaining`);
  }

  print("\nResetting will clear all rate-limit blocks immediately.");
  print("The running OpenCode plugin will pick up the change on the next request.\n");

  const confirm = await question("Reset all failed keys? (y/n): ");
  if (confirm.toLowerCase() === "y" || confirm.toLowerCase() === "yes") {
    config.failedKeys = {};
    await writeJson(PLUGIN_CONFIG_PATH, config);
    print(`\n✅ Reset ${count} failed key(s). All keys are now available.\n`);
  } else {
    print("\nCancelled. No changes made.\n");
  }
  await question("Press Enter to continue...");
}

async function setupPlugin() {
  const existingConfig = await readJson(CONFIG_PATH);

  if (existingConfig) {
    print("✓ Found OpenCode configuration\n");
  } else {
    print("⚠️  OpenCode not configured. Run OpenCode first.\n");
    return false;
  }

  const hasPlugin = existingConfig.plugin?.some((p) =>
    Array.isArray(p) ? p[0]?.includes("ollama-router") : p?.includes("ollama-router")
  );

  if (!hasPlugin) {
    const pluginConfig = await readJson(PLUGIN_CONFIG_PATH);
    const apiKey = pluginConfig?.keys?.[0];

    const models = await fetchAvailableModels(apiKey);

    if (models && models.length > 0) {
      print(`Fetched ${models.length} models from Ollama API, fetching capabilities...`);
      const showData = {};
      for (const m of models) {
        const id = m.name || m.model;
        if (!id) continue;
        const show = await fetchModelShow(id, apiKey);
        if (show) showData[id] = show;
      }
      const modelsMap = buildModelsMap(models, showData);
      const firstModelId = models[0].name || models[0].model;
      print(`✓ Fetched ${models.length} models from Ollama API with capabilities\n`);
      await registerPluginInConfig(existingConfig, modelsMap, firstModelId);
      print("✓ Registered plugin in opencode.json\n");
    } else {
      print("⚠️  Could not fetch models from Ollama API — using built-in fallback list.\n");
      print("   Run option 5 (Refresh models) once you have keys and connectivity.\n");
      await registerPluginInConfig(existingConfig, FALLBACK_MODELS, "minimax-m2.7");
      print("✓ Registered plugin in opencode.json (fallback models)\n");
    }
  }

  return true;
}

async function main() {
  const pluginReady = await setupPlugin();
  if (!pluginReady) {
    rl.close();
    return;
  }

  let config = await readJson(PLUGIN_CONFIG_PATH);
  if (!config) {
    config = { providerId: "ollama-router", maxRetries: 5, failWindowMs: 18000000, keys: [] };
    await writeJson(PLUGIN_CONFIG_PATH, config);
  }

  if (!IS_INTERACTIVE) {
    print(`\nℹ️  Config file: ${PLUGIN_CONFIG_PATH}`);
    print("   Run in interactive terminal for menu (add keys, refresh models, etc.).\n");
    rl.close();
    return;
  }

  while (true) {
    const choice = await menu();

    switch (choice) {
      case "1":
        await addKeys(config);
        break;
      case "2":
        await listKeys(config);
        break;
      case "3":
        await removeKey(config);
        break;
      case "4":
        await configureOptions(config);
        break;
      case "5":
        await refreshModels(config);
        break;
      case "6":
        await resetFailedKeys(config);
        break;
      case "7":
        print("\n👋 Goodbye!\n");
        rl.close();
        return;
      default:
        print("\n⚠️  Invalid option.\n");
    }
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
