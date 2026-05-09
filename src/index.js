#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenRouter } from "@openrouter/sdk";
import * as errors from "@openrouter/sdk/models/errors";
import { z } from "zod";

import { getTimeoutMs, getAllowedModels, getInvalidFallbackEntries } from "./config.js";

const MAX_FILE_SIZE = 150 * 1024; // 150KB
const MAX_FILES = 10;

const apiKey = process.env.OPENROUTER_API_KEY;

if (!apiKey) {
  console.error("OPENROUTER_API_KEY environment variable is required");
  process.exit(1);
}

if (!process.env.OPENROUTER_ALLOWED_MODELS) {
  console.error("OPENROUTER_ALLOWED_MODELS environment variable is required (comma-separated list of model IDs)");
  process.exit(1);
}

// Centralized allowlist parsing — see getAllowedModels in src/config.js.
const allowedModels = getAllowedModels();

// Guard against truthy-but-empty env values (e.g., OPENROUTER_ALLOWED_MODELS=","
// or whitespace-only). The unset check above only catches missing env;
// without this check, an empty allowlist Set would let the primary check
// reject every model while the fallback check silently no-ops, producing
// an inconsistent "everything broken but partially silent" failure mode.
if (allowedModels.size === 0) {
  console.error("OPENROUTER_ALLOWED_MODELS contains no valid model IDs after parsing (e.g., env was ',' or whitespace-only)");
  process.exit(1);
}

const defaultSystemPrompt = process.env.OPENROUTER_SYSTEM_PROMPT || "";

const openRouter = new OpenRouter({
  apiKey,
});

const server = new McpServer({
  name: "openrouter-mcp",
  version: "2.0.1",
});

// Structured-log helper for fallback events. Emits one machine-parseable
// JSON line per event on stderr — stdio MCP protocol owns stdout, so log
// lines must NEVER go there.
export function logFallback(event, fields) {
  console.error(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

// Classify SDK-thrown errors as transient (eligible for fallback retry) or
// terminal (fail-fast). Typed transients come from `@openrouter/sdk/models/errors`;
// untyped 5xx (e.g. Cloudflare 522) surface via `OpenRouterDefaultError` and
// are retried only when `statusCode >= 500` — never on untyped 4xx, since
// those are programmer errors (wrong model id, malformed request, bad auth)
// that need to be surfaced to the caller, not silently masked by fallback.
export function isTransientSdkError(err) {
  if (err instanceof errors.RequestTimeoutError) return true;            // client-side timeoutMs fired
  if (err instanceof errors.RequestAbortedError) return true;            // client-side abort
  if (err instanceof errors.ConnectionError) return true;                // network failure
  if (err instanceof errors.RequestTimeoutResponseError) return true;    // 408
  if (err instanceof errors.TooManyRequestsResponseError) return true;   // 429
  if (err instanceof errors.InternalServerResponseError) return true;    // 500
  if (err instanceof errors.BadGatewayResponseError) return true;        // 502
  if (err instanceof errors.ServiceUnavailableResponseError) return true; // 503
  if (err instanceof errors.EdgeNetworkTimeoutResponseError) return true; // 524 (Cloudflare)
  if (err instanceof errors.ProviderOverloadedResponseError) return true; // 529 (OpenRouter "model overloaded")
  if (
    err instanceof errors.OpenRouterDefaultError &&
    typeof err.statusCode === "number" &&
    err.statusCode >= 500
  ) {
    return true;
  }
  return false;
}

// Single SDK call. Injects `model` into the request and applies the
// per-request `timeoutMs` from config.
export async function callOnce(model, requestParams) {
  return await openRouter.chat.send(
    { ...requestParams, model },
    { timeoutMs: getTimeoutMs() }
  );
}

// Walk [primary, ...fallbacks] in order, returning on first success.
// Retry only when the thrown error is a transient SDK error (per
// isTransientSdkError) AND there is at least one fallback remaining.
// Programmer errors fail-fast. Last-attempt errors propagate up.
export async function callWithFallbacks(primary, fallbacks, requestParams) {
  const chain = [primary, ...(fallbacks ?? [])];
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      return await callOnce(model, requestParams);
    } catch (err) {
      lastErr = err;
      if (isTransientSdkError(err) && i < chain.length - 1) {
        const reason = err?.constructor?.name ?? "unknown";
        const statusCode = err?.statusCode;
        logFallback("fallback", {
          from: model,
          to: chain[i + 1],
          reason,
          ...(statusCode !== undefined && { statusCode }),
          message: String(err),
        });
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("all fallbacks exhausted");
}

server.tool(
  "ask_model",
  "Consult another AI model for help with coding tasks. Use this to get a second opinion, ask for explanations, or request assistance with complex problems.",
  {
    model: z.string().describe(
      `The model to consult. Allowed models: ${[...allowedModels].join(", ")}`
    ),
    message: z.string().describe("Your question or request for the model"),
    system_prompt: z.string().optional().describe("Override the default system prompt"),
    append_files: z.array(z.string()).describe("File paths to read and include as context. Pass [\"\"] if no files are relevant."),
    fallback_models: z.array(z.string().min(1)).max(5).optional().describe("Optional fallback model IDs (in order, max 5) to retry on primary failure (timeout, 429, 5xx). Each must be a non-empty string in OPENROUTER_ALLOWED_MODELS. Empty/unset = no fallback (current behavior)."),
  },
  async ({ model, message, system_prompt, append_files, fallback_models }) => {
    if (!append_files || append_files.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `Files relevant to the context must be appended using file paths. If no files are relevant, pass [""] instead.`,
          },
        ],
        isError: true,
      };
    }

    if (!allowedModels.has(model)) {
      return {
        content: [
          {
            type: "text",
            text: `Model "${model}" is not allowed. Allowed models: ${[...allowedModels].join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    // Validate fallback_models entries against the allowlist BEFORE any retry
    // attempt. Reject early with an explicit list of bad ids rather than
    // discovering each one mid-fallback (where it would surface as a 404
    // NotFoundResponseError that fails-fast per the retry-scope policy
    // but with a less actionable error message).
    //
    // Logic centralized in getInvalidFallbackEntries (src/config.js); the
    // helper handles empty/missing inputs defensively and is unit-tested in
    // config.test.js without needing the MCP server harness.
    const invalidFallbacks = getInvalidFallbackEntries(fallback_models, allowedModels);
    if (invalidFallbacks.length > 0) {
      return {
        content: [
          {
            type: "text",
            text: `fallback_models contains entries not in OPENROUTER_ALLOWED_MODELS: ${invalidFallbacks.join(", ")}. Allowed models: ${[...allowedModels].join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      let fullMessage = message;

      const filesToProcess = append_files.filter(f => f !== "");
      if (filesToProcess.length) {
        if (filesToProcess.length > MAX_FILES) {
          throw new Error(`Too many files: ${filesToProcess.length} exceeds maximum of ${MAX_FILES}`);
        }
        for (const filePath of filesToProcess) {
          try {
            const fileStat = await stat(filePath);
            if (fileStat.size > MAX_FILE_SIZE) {
              throw new Error(`File exceeds maximum size of 150KB (${Math.round(fileStat.size / 1024)}KB)`);
            }
            const buffer = await readFile(filePath);
            if (buffer.includes(0)) {
              throw new Error(`File appears to be binary`);
            }
            const content = buffer.toString("utf-8");
            fullMessage += `\n\n===== ${filePath} =====\n`;
            fullMessage += content;
          } catch (err) {
            throw new Error(`Failed to read file "${filePath}": ${err.message}`);
          }
        }
      }

      const messages = [];

      const systemContent = system_prompt || defaultSystemPrompt;
      if (systemContent) {
        messages.push({
          role: "system",
          content: systemContent,
        });
      }

      messages.push({
        role: "user",
        content: fullMessage,
      });

      const requestParams = {
        messages,
      };

      const completion = await callWithFallbacks(model, fallback_models, requestParams);

      const responseContent = completion.choices[0]?.message?.content || "No response received";

      return {
        content: [
          {
            type: "text",
            text: responseContent,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error calling OpenRouter: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
