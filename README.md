# opencode-ollama-router

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)
[![GitHub](https://img.shields.io/badge/GitHub-ruizlenato/opencode--ollama--router-blue)](https://github.com/ruizlenato/opencode-ollama-router)

Smart API key router for OpenCode's Ollama Cloud integration. Automatically rotates through multiple API keys with intelligent failover, subscription error detection, automatic quota management, and dynamic model capability discovery.

## Features

- **Multiple API Keys** - Add unlimited API keys from different Ollama Cloud accounts
- **Automatic Failover** - Automatically rotates to next key when current one fails (401, 403, 429)
- **Subscription Error Detection** - Detects "model requires a subscription" errors and skips those keys
- **Auto Recovery** - Re-enables failed keys after configurable time (default: 5 hours)
- **Instant Reset** - Reset rate-limited keys immediately without restarting OpenCode
- **Hot Reload** - All config changes (keys, options, models) take effect on the next request — no restart needed
- **Streaming Fix** - SSE responses pass through live; no buffering stall during long reasoning
- **Random Key Rotation** - Rotates keys in random order to distribute load evenly
- **Model Capability Discovery** - Automatically fetches model capabilities (vision, tool call, reasoning) and context window sizes from the Ollama API
- **Context Usage Tracking** - Supplies context window sizes so OpenCode can display used context percentage
- **Comprehensive Logging** - Logs all requests with status codes
- **Toast Notifications** - Visual feedback when keys rotate or fail

## Installation

### For LLMs / Automated Setup

If you are an LLM agent installing this plugin on a server, follow these steps:

1. **Copy the zip** to the target server (e.g., via `scp`):
   ```bash
   scp opencode-ollama-router-1.2.0.zip user@server:/tmp/
   ```

2. **Unzip and install globally**:
   ```bash
   cd /tmp
   unzip opencode-ollama-router-1.2.0.zip -d opencode-ollama-router
   cd opencode-ollama-router
   npm install -g .
   ```

3. **Run the setup wizard** to add API keys and configure the provider:
   ```bash
   opencode-ollama-router-setup
   ```
   The setup wizard will:
   - Prompt for API keys (one per line, empty line to finish)
   - Write keys to `~/.config/opencode/ollama-router.json`
   - Register the provider in `~/.config/opencode/opencode.json`
   - Fetch available models and their capabilities from the Ollama API
   - Write model definitions into `~/.config/opencode/opencode.json`

4. **Restart OpenCode** (first time only, to load the plugin):
   ```bash
   opencode
   ```

   After the initial restart, **all config changes take effect immediately** — adding/removing keys, changing options, resetting failed keys — no further restarts needed.

5. **Verify** by checking OpenCode logs for `service=ollama-router` entries:
   ```bash
   grep ollama-router ~/.local/share/opencode/log/opencode.log | tail -5
   ```

### Alternative: From NPM

```bash
npm install -g opencode-ollama-router
opencode-ollama-router-setup
```

### Alternative: From GitHub

```bash
git clone https://github.com/ruizlenato/opencode-ollama-router.git
cd opencode-ollama-router
npm install -g .
opencode-ollama-router-setup
```

## Configuration

### Config file: `~/.config/opencode/ollama-router.json`

```json
{
  "providerId": "ollama-router",
  "maxRetries": 1,
  "failWindowMs": 18000000,
  "shuffle": true,
  "keys": [
    "your-ollama-api-key-1",
    "your-ollama-api-key-2",
    "your-ollama-api-key-3"
  ]
}
```

Or run the interactive setup:
```bash
opencode-ollama-router-setup
```

### OpenCode provider config: `~/.config/opencode/opencode.json`

The setup script adds this provider entry automatically:

```json
{
  "provider": {
    "ollama-router": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://ollama.com/v1"
      }
    }
  }
}
```

### Available Models

Models are **fetched dynamically** from the [Ollama API](https://ollama.com/api/tags) when the setup script runs. Capabilities (vision, tool call, reasoning) and context window sizes are fetched from the `/api/show` endpoint for each model. No hardcoded model list — you always get the latest available models with accurate metadata.

After adding your API keys, use **option 5 (Refresh models)** in the setup menu to re-sync the latest model list and capabilities into `opencode.json`.

## How Model Capabilities Work

The plugin uses a **two-layer approach** to supply model metadata to OpenCode:

### 1. Static config (setup script → `opencode.json`)

When you run the setup script or refresh models, it:
- Fetches the model list from `/api/tags`
- For each model, calls `/api/show` to get capabilities and context length
- Maps Ollama capabilities to OpenCode fields:

| Ollama capability | OpenCode field |
|---|---|
| `vision` | `attachment: true`, `modalities.input` includes `"image"` |
| `tools` | `tool_call: true` |
| `thinking` | `reasoning: true`, `interleaved: { field: "reasoning_content" }` |
| `<arch>.context_length` | `limit.context` (enables context usage % display) |

### 2. Dynamic provider hook (runtime)

The plugin registers a `provider` hook that fetches capabilities from the Ollama API at runtime, results cached for 5 minutes. This ensures capabilities stay current even if models change after setup.

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keys` | string[] | `[]` | Array of API keys to rotate through |
| `providerId` | string | `"ollama-router"` | Provider ID to intercept |
| `maxRetries` | number | `1` | How many times to retry the same key before moving to the next |
| `failWindowMs` | number | `18000000` | Time in ms before retrying a failed key (5 hours) |
| `shuffle` | boolean | `true` | Randomize key order on each request. Set to `false` to use keys in array order |

## Environment Variables

Keys can also be set via environment variables:

```bash
OLLAMA_API_KEY="your-first-key"
OLLAMA_API_KEY_1="your-second-key"
OLLAMA_API_KEY_2="your-third-key"
```

Environment keys are merged with keys from the config file.

## Hot Reload (No Restart Needed)

As of v1.2.0, **all configuration changes take effect immediately** on the next API request — no need to restart OpenCode:

- Adding or removing API keys via setup script or config file
- Changing `maxRetries`, `failWindowMs`, or `shuffle`
- Resetting failed/rate-limited keys (setup menu option 6)
- Refreshing model capabilities (setup menu option 5)

The plugin re-reads `ollama-router.json` and `opencode.json` from disk before every request, so any external edit to those files is picked up automatically.

## Setup Script Menu

```
opencode-ollama-router-setup

1. Add new API keys
2. List current keys
3. Remove a key
4. Configure options (fail window, max retries, key order)
5. Refresh models from Ollama API
6. Reset failed keys (clear rate-limit blocks without restart)
7. Exit
```

Option 6 shows each rate-limited key with how long it's been blocked and how much cooldown remains, then clears all failed-key state on confirmation.

## How It Works

### Key rotation

1. Plugin intercepts all `fetch` calls to the configured provider
2. Selects a key from your list (randomized order by default, or sequential if `shuffle` is disabled)
3. Adds `Authorization: Bearer <key>` header
4. On error (401, 403, 429), retries the same key up to `maxRetries` times
5. After exhausting retries, moves to the next key
6. Subscription errors (e.g., "model requires subscription") are detected and skipped immediately
7. Failed keys recover after `failWindowMs` expires, or can be reset instantly via option 6

### Streaming behavior

The plugin detects SSE (`text/event-stream`) responses and passes them through **live** to OpenCode — no buffering. This means:
- Tokens stream in real-time during generation
- Long reasoning/thinking phases don't stall or timeout
- Non-streaming responses (errors, JSON) are still buffered for key-rotation logic

### Toggling key order

By default, keys are shuffled randomly on each request for even load distribution. To use keys in their configured array order instead:

**Option A — Setup script:** Choose option 4 ("Configure options") and set random key rotation to `n`.

**Option B — Config file:** Set `shuffle` to `false` in `~/.config/opencode/ollama-router.json`:

```json
{
  "shuffle": false
}
```

When `shuffle` is disabled, keys are tried top-to-bottom in the order they appear in the `keys` array.

### Retry Behavior

- `maxRetries: 1` (default): Try a key once, if it fails, move to next key
- `maxRetries: 3`: Try the same key up to 3 times before moving to next key

This helps handle transient errors without unnecessary key rotation.

## Error Messages

When all keys fail, you'll get a detailed error:

```
[ollama-router] ALL KEYS EXHAUSTED!
Summary: 8 keys failed.
6 no model access, 2 rate-limited, 0 other errors.
Reason: keys have no model access (subscription required)

Details:
  1. key1 (10c44...) - 403
     subscription_error: ref=719aa922-7fc8-49e7-a0d2-ee013279f741
  2. key2 (b95a3...) - 403
     subscription_error: ref=29f87b56-b0ed-4b3e-b668-755148dcbdac
  ...
```

## File Locations

| Path | Purpose |
|------|---------|
| `~/.config/opencode/ollama-router.json` | Plugin config (keys, retry settings, failed-key state) |
| `~/.config/opencode/ollama-router.jsonc` | Same, with JSONC support (preferred if present) |
| `~/.local/share/opencode/auth.json` | OpenCode auth — plugin writes active key here |
| `~/.config/opencode/opencode.json` | OpenCode app config — setup script registers provider + models here |

The plugin reads config keys and env vars (`OLLAMA_API_KEY`, `OLLAMA_API_KEY_1`, …), deduplicates, and merges them. Env keys come after config keys.

## Debugging

To see detailed logs:
1. Check OpenCode's log panel for service `ollama-router`
2. Look for log levels: `info`, `warn`, `error`
3. Streaming responses log status only (no body buffering); error responses log first 300 chars

## License

GPL-3.0 License