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
  print("4. Configure options (fail window, max retries)");
  print("5. Exit\n");

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
    keys.forEach((key, i) => print(`  ${i + 1}. ${key.slice(0, 12)}...`));
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
  keys.forEach((key, i) => print(`  ${i + 1}. ${key.slice(0, 12)}...`));
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

    print(`\n✅ Removed key: ${removed.slice(0, 12)}...`);
  }
  await question("\nPress Enter to continue...");
}

async function configureOptions(config) {
  print("\n⚙️  Configure Options\n");

  const currentRetries = config.maxRetries || 5;
  const currentFailWindow = config.failWindowMs || 18000000;

  print(`Current max retries: ${currentRetries}`);
  print(`Current fail window: ${currentFailWindow / 1000 / 60} minutes\n`);

  const newRetries = await question(`Max retries [${currentRetries}]: `);
  const newFailWindow = await question(`Fail window in minutes [${currentFailWindow / 1000 / 60}]: `);

  if (newRetries) config.maxRetries = parseInt(newRetries) || currentRetries;
  if (newFailWindow) config.failWindowMs = (parseInt(newFailWindow) * 60 * 1000) || currentFailWindow;

  await writeJson(PLUGIN_CONFIG_PATH, config);
  print("\n✅ Options updated.");
  await question("\nPress Enter to continue...");
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
    existingConfig.model = existingConfig.model || "ollama-router/kimi-k2.5";
    existingConfig.provider = existingConfig.provider || {};
    existingConfig.provider["ollama-router"] = {
      npm: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://ollama.com/v1" },
      models: {
        "kimi-k2.5": { id: "kimi-k2.5", name: "Kimi K2.5", family: "kimi" },
        "qwen3.5:397b": { id: "qwen3.5:397b", name: "Qwen 3.5 397B", family: "qwen" },
        "gemma4:31b-cloud": { id: "gemma4:31b-cloud", name: "Gemma 4 31B", family: "gemma" },
      },
    };

    existingConfig.plugin = existingConfig.plugin || [];
    existingConfig.plugin = existingConfig.plugin.filter(
      (p) => !Array.isArray(p) && !p?.includes("ollama-router")
    );
    existingConfig.plugin.push("opencode-ollama-router");

    await writeJson(CONFIG_PATH, existingConfig);
    print("✓ Registered plugin in opencode.json\n");
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
    print("   Run in interactive terminal for menu.\n");
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
