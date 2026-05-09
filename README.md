# openrouter-mcp

MCP server for consulting AI models via OpenRouter. Designed for AI assistants like Claude Code to ask other models for help.

## Installation

```bash
npm install -g openrouter-mcp
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | Yes | Your OpenRouter API key |
| `OPENROUTER_ALLOWED_MODELS` | Yes | Comma-separated list of allowed model IDs |
| `OPENROUTER_SYSTEM_PROMPT` | No | Default system prompt for all requests |
| `OPENROUTER_TIMEOUT_MS` | No | Per-request timeout in milliseconds. Default: `120000` (2 min, upstream-compatible). Range: `1000`–`OPENROUTER_MAX_TIMEOUT_MS`. Slow reasoning models (DeepSeek-V4, large prompts) may need 200000+. |
| `OPENROUTER_MAX_TIMEOUT_MS` | No | Hard cap for `OPENROUTER_TIMEOUT_MS`. Default: `600000` (10 min). Operators can lower this to enforce a stricter ceiling. |

### Example MCP Config

```json
{
  "mcpServers": {
    "openrouter": {
      "command": "npx",
      "args": ["-y", "openrouter-mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-...",
        "OPENROUTER_ALLOWED_MODELS": "anthropic/claude-3.5-sonnet,openai/gpt-4o,google/gemini-2.0-flash-001",
        "OPENROUTER_SYSTEM_PROMPT": "You are helping an AI coding assistant. Be direct and provide code examples when relevant.",
        "OPENROUTER_TIMEOUT_MS": "300000"
      }
    }
  }
}
```

## Tool: `ask_model`

Consult another AI model for help with coding tasks.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Model ID from the allowed list |
| `message` | string | Yes | Your question or request |
| `system_prompt` | string | No | Override the default system prompt |
| `append_files` | string[] | No | File paths to read and include as context |
| `fallback_models` | string[] | No | Optional fallback model IDs (in order, max 5) to retry on transient primary failure (timeout, 429, 5xx). Each must be in `OPENROUTER_ALLOWED_MODELS`. Empty/unset = legacy mode (no fallback). |

### Fallback retry behavior

When `fallback_models` is provided, the server walks `[primary, ...fallback_models]` in order and returns the first successful response. Retry fires only on **transient** errors:

- Client-side: `RequestTimeoutError`, `RequestAbortedError`, `ConnectionError`
- HTTP transient: 408, 429, 500, 502, 503, 524 (Cloudflare timeout), 529 (provider overloaded)
- Untyped 5xx via `OpenRouterDefaultError` with `statusCode >= 500` (covers 504, 522, etc.)

**Programmer errors fail-fast** — the chain does not retry on `TypeError`, `NotFoundResponseError` (404), or untyped 4xx responses, since those indicate a wrong model id, malformed request, or auth failure that masking would hide.

Each fallback hop emits a structured JSON line on stderr: `{"event":"fallback","ts":"...","from":"...","to":"...","reason":"...","statusCode":...,"message":"..."}`.

### Limits

- Max 10 files per request
- Max 150KB per file
- Text files only (no binary)
- Per-request timeout: see `OPENROUTER_TIMEOUT_MS` (default 2 min)

## Testing

```bash
npm install
npm test                  # Jest under --experimental-vm-modules
npm run test:coverage     # with coverage report
npm run audit:prod        # production-deps security audit
```

Tests cover the env-var parsers, the fallback chain semantics (transient vs terminal classification, structured logging), and basic test infrastructure.

## License

MIT
