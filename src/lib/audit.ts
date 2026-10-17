import fs from "fs";
import path from "path";

/**
 * Local audit trail (JSON Lines). One line per tool call with timestamp,
 * connection (host/client/user), tool, arguments and outcome. Never
 * contains passwords or response data.
 *
 * SAP_AUDIT_LOG: file path (default <install>/logs/audit.jsonl), "off" disables.
 */
const SENSITIVE_KEY = /pass|secret|token|cookie|authorization/i;
const MAX_ARG_CHARS = 2000;

export function auditFile(env = process.env): string | undefined {
  const raw = env.SAP_AUDIT_LOG?.trim();
  if (raw && /^(off|0|false|none)$/i.test(raw)) return undefined;
  return raw || path.resolve(__dirname, "../../logs/audit.jsonl");
}

export function sanitizeArgs(args: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!args || typeof args !== "object") return out;
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(k)) {
      out[k] = "***";
    } else if (typeof v === "string" && v.length > MAX_ARG_CHARS) {
      out[k] = v.slice(0, MAX_ARG_CHARS) + "…";
    } else {
      out[k] = v;
    }
  }
  return out;
}

function connection(env = process.env) {
  let host = "";
  try {
    host = env.SAP_URL ? new URL(env.SAP_URL).host : "";
  } catch {
    host = "";
  }
  return { host, client: env.SAP_CLIENT || "", user: env.SAP_USERNAME || "" };
}

export function buildAuditEntry(
  tool: string,
  args: unknown,
  result: any,
  durationMs: number,
  env = process.env,
) {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    ...connection(env),
    tool,
    args: sanitizeArgs(args),
    ok: !(result && result.isError),
    ms: durationMs,
  };
  if (result?.isError) {
    const msg = result?.content?.[0]?.text;
    if (typeof msg === "string") entry.error = msg.slice(0, 300);
  }
  return entry;
}

export function writeAudit(
  tool: string,
  args: unknown,
  result: any,
  durationMs: number,
) {
  try {
    const file = auditFile();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      JSON.stringify(buildAuditEntry(tool, args, result, durationMs)) + "\n",
      { encoding: "utf8" },
    );
  } catch {
    // Auditing is best effort; never break a tool call or write to stdout.
  }
}
