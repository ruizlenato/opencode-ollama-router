# opencode-ollama-router

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](https://opensource.org/licenses/GPL-3.0)
[![GitHub](https://img.shields.io/badge/GitHub-ruizlenato/opencode--ollama--router-blue)](https://github.com/ruizlenato/opencode-ollama-router)

Smart API key router for OpenCode's Ollama Cloud integration. Automatically rotates through multiple API keys with intelligent failover, subscription error detection, and automatic quota management.

## Features

- **Multiple API Keys** - Add unlimited API keys from different Ollama Cloud accounts
- **Automatic Failover** - Automatically rotates to next key when current one fails (401, 403, 429)
- **Subscription Error Detection** - Detects "model requires a subscription" errors and skips those keys
- **Auto Recovery** - Re-enables failed keys after configurable time (default: 5 hours)
- **Random Key Rotation** - Rotates keys in random order to distribute load evenly
- **Comprehensive Logging** - Logs all requests with status codes
- **Toast Notifications** - Visual feedback when keys rotate or fail

## Installation (GitHub)

Clone and install:

```bash
git clone https://github.com/ruizlenato/opencode-ollama-router.git
cd opencode-ollama-router
npm install -g .
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

The plugin comes pre-configured with these models:

| Model ID | Name |
|----------|------|
| `minimax-m2.7` | MiniMax M2.7 |
| `qwen3-coder-next` | Qwen3 Coder Next |
| `gpt-oss:120b` | GPT OSS 120B |
| `mistral-large-3:675b` | Mistral Large 3 675B |
| `glm-4.7` | GLM 4.7 |
| `qwen3-next:80b` | Qwen3 Next 80B |
| `gemma4:31b` | Gemma 4 31B |
| `deepseek-v3.2` | DeepSeek V3.2 |
| `devstral-small-2:24b` | Devstral Small 2 24B |
| `gemini-3-flash-preview` | Gemini 3 Flash Preview |

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `keys` | string[] | `[]` | Array of API keys to rotate through |
| `providerId` | string | `"ollama-router"` | Provider ID to intercept |
| `maxRetries` | number | `1` | How many times to retry the same key before moving to the next |
| `failWindowMs` | number | `18000000` | Time in ms before retrying a failed key (5 hours) |

## Environment Variables

Keys can also be set via environment variables:

```bash
OLLAMA_API_KEY="your-first-key"
OLLAMA_API_KEY_1="your-second-key"
OLLAMA_API_KEY_2="your-third-key"
```

Environment keys are merged with keys from the config file.

## How It Works

1. Plugin intercepts all `fetch` calls to the configured provider
2. Selects a key from your list (randomized order for fair distribution)
3. Adds `Authorization: Bearer <key>` header
4. On error (401, 403, 429), retries the same key up to `maxRetries` times
5. After exhausting retries, moves to the next key
6. Subscription errors (e.g., "model requires subscription") are detected and skipped immediately
7. Failed keys recover after `failWindowMs` expires

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

## State Files

The plugin manages these files:

- `~/.config/opencode/ollama-router.json` - Configuration and key failure state

## Debugging

To see detailed logs:
1. Check OpenCode's log panel for service `ollama-router`
2. Look for log levels: `info`, `warn`, `error`
3. Each request logs status code and first 300 chars of response body

## License

GPL-3.0 License
