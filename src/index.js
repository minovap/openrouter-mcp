#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenRouter } from "@openrouter/sdk";
import { z } from "zod";

const MAX_FILE_SIZE = 150 * 1024; // 150KB
const MAX_FILES = 10;

const apiKey = process.env.OPENROUTER_API_KEY;
const allowedModelsEnv = process.env.OPENROUTER_ALLOWED_MODELS;

if (!apiKey) {
  console.error("OPENROUTER_API_KEY environment variable is required");
  process.exit(1);
}

if (!allowedModelsEnv) {
  console.error("OPENROUTER_ALLOWED_MODELS environment variable is required (comma-separated list of model IDs)");
  process.exit(1);
}

const allowedModels = allowedModelsEnv.split(",").map(m => m.trim()).filter(Boolean);
const defaultSystemPrompt = process.env.OPENROUTER_SYSTEM_PROMPT || "";

const openRouter = new OpenRouter({
  apiKey,
});

const API_TIMEOUT = 120000; // 2 minutes

const server = new McpServer({
  name: "openrouter-mcp",
  version: "2.0.0",
});

server.tool(
  "ask_model",
  "Consult another AI model for help with coding tasks. Use this to get a second opinion, ask for explanations, or request assistance with complex problems.",
  {
    model: z.string().describe(
      `The model to consult. Allowed models: ${allowedModels.join(", ")}`
    ),
    message: z.string().describe("Your question or request for the model"),
    system_prompt: z.string().optional().describe("Override the default system prompt"),
    append_files: z.array(z.string()).optional().describe("File paths to read and include as context"),
  },
  async ({ model, message, system_prompt, append_files }) => {
    if (!allowedModels.includes(model)) {
      return {
        content: [
          {
            type: "text",
            text: `Model "${model}" is not allowed. Allowed models: ${allowedModels.join(", ")}`,
          },
        ],
        isError: true,
      };
    }

    try {
      let fullMessage = message;

      if (append_files?.length) {
        if (append_files.length > MAX_FILES) {
          throw new Error(`Too many files: ${append_files.length} exceeds maximum of ${MAX_FILES}`);
        }
        for (const filePath of append_files) {
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
        model,
        messages,
      };

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Request timed out")), API_TIMEOUT)
      );

      const completion = await Promise.race([
        openRouter.chat.send(requestParams),
        timeoutPromise,
      ]);

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
