/**
 * Decode + parse a base64 service-account JSON, escaping literal control
 * characters inside string values (the private_key contains real newlines that
 * a raw JSON.parse rejects).
 *
 * Lives in its own module with no config import so the MCP server can use it
 * without pulling in src/config.ts, whose required() checks would crash the
 * whole server when bot-only env vars are absent.
 */
export function parseServiceAccountJson(base64Value: string): Record<string, unknown> {
  const raw = Buffer.from(base64Value, 'base64').toString('utf-8');
  const cleaned = raw.replace(/"((?:[^"\\]|\\.)*)"/gs, (_, inner) =>
    `"${inner.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`,
  );
  return JSON.parse(cleaned);
}
