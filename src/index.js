#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenRouter } from "@openrouter/sdk";
import * as errors from "@openrouter/sdk/models/errors";
import { z } from "zod";

import { getTimeoutMs, getAllowedModels, validateAskModelRequest, validateStartupEnv } from "./config.js";

const MAX_FILE_SIZE = 150 * 1024; // 150KB
const MAX_FILES = 10;

// Pure-function startup validation centralized in src/config.js so the
// missing-env paths are unit-testable without re-importing the module.
//
const startupErr = validateStartupEnv(process.env);
if (startupErr) {
  console.error(startupErr);
  process.exit(1);
}

const apiKey = process.env.OPENROUTER_API_KEY;
const allowedModels = getAllowedModels();

const defaultSystemPrompt = process.env.OPENROUTER_SYSTEM_PROMPT || "";

const openRouter = new OpenRouter({
  apiKey,
});

const server = new McpServer({
  name: "openrouter-mcp",
  version: "2.0.1",
});

// Structured-log helper for fallback events Emits one
// machine-parseable JSON line per event on stderr — stdio MCP protocol
// owns stdout, so log lines must NEVER go there.
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
// per-request `timeoutMs` from config. Separated from callWithFallbacks

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

// Pure-ish handler for the `ask_model` tool, extracted from the inline
// `server.tool(...)` callback so it's testable without an MCP runtime harness.
//
//
// Dependencies are injectable via the second arg's `deps` block so tests
// can pass mocks for `stat`, `readFile`, `callWithFallbacks`. Defaults
// resolve to the live module-level imports for production calls.
//
// Returns the same `{content, isError?}` shape as the original handler.
export async function askModelHandler(
  { model, message, system_prompt, append_files, fallback_models },
  {
    allowedModels: allowed,
    defaultSystemPrompt: defaultSys = "",
    maxFiles = MAX_FILES,
    maxFileSize = MAX_FILE_SIZE,
    deps: {
      stat: statFn = stat,
      readFile: readFileFn = readFile,
      callWithFallbacks: callFn = callWithFallbacks,
    } = {},
  }
) {
  const validationError = validateAskModelRequest(
    { model, append_files, fallback_models },
    allowed
  );
  if (validationError) {
    return {
      content: [{ type: "text", text: validationError }],
      isError: true,
    };
  }

  try {
    let fullMessage = message;

    const filesToProcess = append_files.filter(f => f !== "");
    if (filesToProcess.length) {
      if (filesToProcess.length > maxFiles) {
        throw new Error(`Too many files: ${filesToProcess.length} exceeds maximum of ${maxFiles}`);
      }
      for (const filePath of filesToProcess) {
        try {
          const fileStat = await statFn(filePath);
          if (fileStat.size > maxFileSize) {
            throw new Error(`File exceeds maximum size of 150KB (${Math.round(fileStat.size / 1024)}KB)`);
          }
          const buffer = await readFileFn(filePath);
          if (buffer.includes(0)) {
            throw new Error(`File appears to be binary`);
          }
          const content = buffer.toString("utf-8");
          fullMessage += `\n\n===== ${filePath} =====\n${content}`;
        } catch (err) {
          throw new Error(`Failed to read file "${filePath}": ${err.message}`);
        }
      }
    }

    const messages = [];
    const systemContent = system_prompt || defaultSys;
    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }
    messages.push({ role: "user", content: fullMessage });

    const completion = await callFn(model, fallback_models, { messages });
    const responseContent = completion.choices[0]?.message?.content || "No response received";

    return {
      content: [{ type: "text", text: responseContent }],
    };
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error calling OpenRouter: ${error.message}` }],
      isError: true,
    };
  }
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
  async (args) => askModelHandler(args, {
    allowedModels,
    defaultSystemPrompt,
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);
