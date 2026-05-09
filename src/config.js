// Configuration helpers for openrouter-mcp.
//
// Reads OPENROUTER_TIMEOUT_MS, OPENROUTER_MAX_TIMEOUT_MS, and OPENROUTER_ALLOWED_MODELS
// from process.env with bounded validation. Falls back to safe defaults on any
// invalid input (logged to stderr — stdio MCP protocol owns stdout).
//
// Hard-cap invariant: getTimeoutMs() never returns a value greater than
// getMaxTimeoutMs(). This holds even when an operator sets OPENROUTER_MAX_TIMEOUT_MS
// below DEFAULT_TIMEOUT_MS — the fallback default is clamped via safeDefault().
//
// Fallback vs. clamp policy: an explicit out-of-bounds OPENROUTER_TIMEOUT_MS
// (e.g., 500000 with cap 480000) falls back to safeDefault(max) rather than
// being clamped. Rationale: clamping would silently mask an operator typo or
// stale config value, hiding the misconfiguration. Falling back to a sane
// default + stderr diagnostic surfaces the issue. The fallback itself is
// still bounded by max (via safeDefault) to preserve the hard-cap invariant.
//
// Accepted numeric forms (any Number()-parseable integer in [MIN, MAX]):
// decimal (300000), integer scientific notation (3e5), hex (0x493e0),
// octal (0o1115640), binary, whitespace-padded. Decimals, Infinity, NaN, and
// non-integer scientific notation are rejected. Env vars are operator-
// controlled, so the broad numeric acceptance is intentional, not a hazard.

const DEFAULT_TIMEOUT_MS = 120_000;       // upstream-compatible default (preserves AC #4)
const MIN_TIMEOUT_MS = 1_000;             // 1s — anything lower is operator error
const DEFAULT_MAX_TIMEOUT_MS = 600_000;   // 10 min hard cap; override via OPENROUTER_MAX_TIMEOUT_MS

// Returns DEFAULT_TIMEOUT_MS clamped to the configured max so getTimeoutMs's
// fallback can never exceed the hard cap.
function safeDefault(max) {
  return Math.min(DEFAULT_TIMEOUT_MS, max);
}

export function getMaxTimeoutMs() {
  const raw = process.env.OPENROUTER_MAX_TIMEOUT_MS;
  if (!raw) return DEFAULT_MAX_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS) {
    console.error(
      `[openrouter-mcp] Invalid OPENROUTER_MAX_TIMEOUT_MS=${JSON.stringify(raw)}; ` +
      `using default ${DEFAULT_MAX_TIMEOUT_MS}ms (must be integer, min=${MIN_TIMEOUT_MS})`
    );
    return DEFAULT_MAX_TIMEOUT_MS;
  }
  return parsed;
}

export function getTimeoutMs() {
  const raw = process.env.OPENROUTER_TIMEOUT_MS;
  const max = getMaxTimeoutMs();
  if (!raw) return safeDefault(max);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < MIN_TIMEOUT_MS || parsed > max) {
    console.error(
      `[openrouter-mcp] Invalid OPENROUTER_TIMEOUT_MS=${JSON.stringify(raw)}; ` +
      `using default ${safeDefault(max)}ms (must be integer, min=${MIN_TIMEOUT_MS}, max=${max})`
    );
    return safeDefault(max);
  }
  return parsed;
}

// Centralized allowlist parser; isolated for testability.
// in-handler check at src/index.js to import this. T5 establishes the export.
export function getAllowedModels() {
  const raw = process.env.OPENROUTER_ALLOWED_MODELS ?? '';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// Returns the subset of `fallback_models` that are NOT present in
// `allowedModels`. An empty array result means "all valid" (or there is
// nothing to check). Extracted
// from the inline handler check  so the validation logic is testable in
// isolation, without spinning up the MCP server harness.
//
// Defensive on missing/empty inputs:
//   - allowedModels missing or size 0: returns [] (no rejections). The
//     production flow exits at module init when the allowlist is empty,
//     so this branch is reached only by direct unit-test calls.
//   - fallback_models missing or empty: returns [] (nothing to check).
export function getInvalidFallbackEntries(fallback_models, allowedModels) {
  if (!allowedModels || allowedModels.size === 0) return [];
  if (!fallback_models || fallback_models.length === 0) return [];
  return fallback_models.filter(m => !allowedModels.has(m));
}

// Pure-function validation of startup env. Returns null if env is valid,
// OR a user-facing error message string. Extracted from the inline
// `process.exit(1)` guards in src/index.js so the missing-env paths are
// unit-testable.
//
// Caller pattern (src/index.js):
//   const err = validateStartupEnv(process.env);
//   if (err) { console.error(err); process.exit(1); }
export function validateStartupEnv(env) {
  if (!env.OPENROUTER_API_KEY) {
    return "OPENROUTER_API_KEY environment variable is required";
  }
  if (!env.OPENROUTER_ALLOWED_MODELS) {
    return "OPENROUTER_ALLOWED_MODELS environment variable is required (comma-separated list of model IDs)";
  }
  // Empty-after-parse case: env was "," or whitespace-only.
  // Inline the parse (rather than calling getAllowedModels) so this fn
  // is purely a function of its single env arg, not of process.env.
  const parsed = new Set(env.OPENROUTER_ALLOWED_MODELS.split(',').map(s => s.trim()).filter(Boolean));
  if (parsed.size === 0) {
    return "OPENROUTER_ALLOWED_MODELS contains no valid model IDs after parsing (e.g., env was ',' or whitespace-only)";
  }
  return null;
}

// Pure-function validation of an ask_model request. Returns null if the
// request is valid, OR a user-facing error message string. Extracted from
// the live MCP `server.tool(...)` handler in src/index.js so that the
// NEW validation surface added by this fork is unit-testable without
// spinning up an MCP runtime harness.
//
// Caller pattern (src/index.js):
//   const err = validateAskModelRequest({ model, append_files, fallback_models }, allowedModels);
//   if (err) return { content: [{ type: "text", text: err }], isError: true };
//
// Validation order matches the original handler:
//   1. append_files presence (the upstream contract's required-non-empty)
//   2. primary model in allowlist
//   3. fallback_models entries in allowlist (NEW from this fork)
export function validateAskModelRequest({ model, append_files, fallback_models }, allowedModels) {
  if (!append_files || append_files.length === 0) {
    return `Files relevant to the context must be appended using file paths. If no files are relevant, pass [""] instead.`;
  }
  if (!allowedModels.has(model)) {
    return `Model "${model}" is not allowed. Allowed models: ${[...allowedModels].join(", ")}`;
  }
  const invalidFallbacks = getInvalidFallbackEntries(fallback_models, allowedModels);
  if (invalidFallbacks.length > 0) {
    return `fallback_models contains entries not in OPENROUTER_ALLOWED_MODELS: ${invalidFallbacks.join(", ")}. Allowed models: ${[...allowedModels].join(", ")}`;
  }
  return null;
}
