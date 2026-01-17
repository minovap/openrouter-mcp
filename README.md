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
        "OPENROUTER_SYSTEM_PROMPT": "You are helping an AI coding assistant. Be direct and provide code examples when relevant."
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

### Limits

- Max 10 files per request
- Max 150KB per file
- Text files only (no binary)
- 2 minute timeout per request

## License

MIT
