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

const DEFAULT_TIMEOUT_MS = 120_000;       // upstream-compatible default (preserves prior behavior)
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

// Centralized allowlist parser. Returns Set<string> of trimmed, non-empty
// model IDs from OPENROUTER_ALLOWED_MODELS. Empty/missing env yields an
// empty Set; runtime enforcement of "not empty" lives at module init in
// src/index.js, separate from the parser contract.
export function getAllowedModels() {
  const raw = process.env.OPENROUTER_ALLOWED_MODELS ?? '';
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
}

// Returns the subset of `fallback_models` that are NOT present in
// `allowedModels`. An empty array result means "all valid" (or there is
// nothing to check).
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
