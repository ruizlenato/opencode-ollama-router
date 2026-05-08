# opencode-ollama-router

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)
[![GitHub](https://img.shields.io/badge/GitHub-ruizlenato/opencode--ollama--router-blue)](https://github.com/ruizlenato/opencode-ollama-router)

Smart API key router for OpenCode's Ollama Cloud integration. Automatically rotates through multiple API keys with intelligent failover, subscription error detection, automatic quota management, and dynamic model capability discovery.

## Features

- **Multiple API Keys** - Add unlimited API keys from different Ollama Cloud accounts
- **Automatic Failover** - Automatically rotates to next key when current one fails (401, 403, 429)
- **Subscription Error Detection** - Detects "model requires a subscription" errors and skips those keys
- **Auto Recovery** - Re-enables failed keys after configurable time (default: 5 hours)
- **Random Key Rotation** - Rotates keys in random order to distribute load evenly
- **Model Capability Discovery** - Automatically fetches model capabilities (vision, tool call, reasoning) and context window sizes from the Ollama API
- **Context Usage Tracking** - Supplies context window sizes so OpenCode can display used context percentage
- **Comprehensive Logging** - Logs all requests with status codes
- **Toast Notifications** - Visual feedback when keys rotate or fail

## Installation

### From NPM (recommended)

```bash
npm install -g opencode-ollama-router
opencode-ollama-router-setup
```

### From GitHub

```bash
git clone https://github.com/ruizlenato/opencode-ollama-router.git
cd opencode-ollama-router
npm install -g .
opencode-ollama-router-setup
```

## Configuration

1. Configure API keys in `~/.config/opencode/ollama-router.json`:

```json
{
  "providerId": "ollama-router",
  "maxRetries": 1,
  "failWindowMs": 18000000,
  "keys": [
    "your-ollama-api-key-1",
    "your-ollama-api-key-2",
    "your-ollama-api-key-3"
  ]
}
```

Or run the setup script:

```bash
opencode-ollama-router-setup
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

## How It Works

### Key rotation

1. Plugin intercepts all `fetch` calls to the configured provider
2. Selects a key from your list (randomized order by default, or sequential if `shuffle` is disabled)
3. Adds `Authorization: Bearer <key>` header
4. On error (401, 403, 429), retries the same key up to `maxRetries` times
5. After exhausting retries, moves to the next key
6. Subscription errors (e.g., "model requires subscription") are detected and skipped immediately
7. Failed keys recover after `failWindowMs` expires

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
3. Each request logs status code and first 300 chars of response body

## License

GPL-3.0 License
