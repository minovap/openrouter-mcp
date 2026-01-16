#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { OpenRouter } from "@openrouter/sdk";
import { z } from "zod";

const apiKey = process.env.OPENROUTER_API_KEY;
const modelExamples = process.env.OPENROUTER_MODEL_EXAMPLES || "'openai/gpt-5.2' 'google/gemini-3-pro-preview' 'openai/gpt-5.2-codex'";

if (!apiKey) {
  console.error("OPENROUTER_API_KEY environment variable is required");
  process.exit(1);
}

const openRouter = new OpenRouter({
  apiKey,
});

const server = new McpServer({
  name: "openrouter-mcp",
  version: "1.0.0",
});

server.tool(
  "send_message",
  "Send a message to an AI model via OpenRouter and receive a response",
  {
    model: z.string().describe(
      `The model to use. Examples: ${modelExamples}`
    ),
    message: z.string().describe("The message to send to the AI model"),
    system_prompt: z.string().optional().describe("Optional system prompt to set the AI's behavior"),
    temperature: z.number().min(0).max(2).optional().describe("Sampling temperature (0-2). Lower values are more focused, higher values are more creative."),
    max_tokens: z.number().positive().optional().describe("Maximum number of tokens to generate in the response"),
    top_p: z.number().min(0).max(1).optional().describe("Nucleus sampling parameter (0-1). Alternative to temperature."),
  },
  async ({ model, message, system_prompt, temperature, max_tokens, top_p }) => {
    try {
      const messages = [];

      if (system_prompt) {
        messages.push({
          role: "system",
          content: system_prompt,
        });
      }

      messages.push({
        role: "user",
        content: message,
      });

      const requestParams = {
        model,
        messages,
      };

      if (temperature !== undefined) requestParams.temperature = temperature;
      if (max_tokens !== undefined) requestParams.max_tokens = max_tokens;
      if (top_p !== undefined) requestParams.top_p = top_p;

      const completion = await openRouter.chat.send(requestParams);

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
