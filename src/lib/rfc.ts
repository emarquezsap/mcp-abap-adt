import { AxiosError } from "axios";
import type { SapConfig } from "../config";

/**
 * ADT over RFC: every ADT REST request is wrapped into a call of the
 * standard function module SADT_REST_RFC_ENDPOINT (function group SADT_REST),
 * the same transport Eclipse ADT uses for RFC/SAProuter connections.
 * Requires the optional package node-rfc and the SAP NW RFC SDK.
 */

let client: any = null;
let queue: Promise<unknown> = Promise.resolve();

function loadNodeRfc(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node-rfc");
  } catch {
    throw new Error(
      "SAP RFC connection failed: SAP_CONNECTION=rfc needs the node-rfc package and the SAP NW RFC SDK (SAPNWRFC_HOME); run npm install in the server folder",
    );
  }
}

/** Router/logon errors are useful, but never echo the password. */
export function rfcErrorMessage(error: any, password?: string): string {
  let text = String(error?.message || error || "unknown error");
  if (error?.key && !text.includes(error.key)) text = `${error.key}: ${text}`;
  if (password) text = text.split(password).join("***");
  text = text.replace(/\s+/g, " ").trim().slice(0, 600);
  return `SAP RFC connection failed: ${text}`;
}

async function getClient(config: SapConfig) {
  if (client?.alive) return client;
  const { Client } = loadNodeRfc();
  const c = new Client({ ...config.rfc, passwd: config.password });
  try {
    await c.open();
  } catch (error) {
    throw new Error(rfcErrorMessage(error, config.password));
  }
  client = c;
  return c;
}

/** Path + query of the ADT request (the origin is a placeholder in RFC mode). */
export function buildRfcUri(url: string, params?: Record<string, unknown>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params || {})) {
    // client and language are fixed by the RFC logon
    if (k === "sap-client" || k === "sap-language" || v === undefined || v === null) continue;
    u.searchParams.set(k, String(v));
  }
  return u.pathname + u.search;
}

export function toBody(data: unknown): Buffer {
  if (data === undefined || data === null) return Buffer.alloc(0);
  if (Buffer.isBuffer(data)) return data;
  if (typeof data === "string") return Buffer.from(data, "utf8");
  return Buffer.from(JSON.stringify(data), "utf8");
}

export function fromRfcResponse(res: any) {
  const status = Number(res?.STATUS_LINE?.STATUS_CODE) || 500;
  const headers: Record<string, string> = {};
  for (const h of res?.HEADER_FIELDS || []) headers[String(h.NAME).toLowerCase()] = String(h.VALUE);
  const raw = res?.MESSAGE_BODY ? Buffer.from(res.MESSAGE_BODY) : Buffer.alloc(0);
  let data: unknown = raw.toString("utf8");
  if (/json/i.test(headers["content-type"] || "")) {
    try {
      data = JSON.parse(data as string);
    } catch {
      /* keep text */
    }
  }
  return { status, statusText: String(res?.STATUS_LINE?.REASON_PHRASE || ""), headers, data };
}

async function callOnce(config: SapConfig, request: any, timeoutMs: number) {
  const c = await getClient(config);
  try {
    const r = await c.call("SADT_REST_RFC_ENDPOINT", { REQUEST: request }, { timeout: Math.ceil(timeoutMs / 1000) });
    return r.RESPONSE;
  } catch (error: any) {
    if (!c.alive) client = null;
    throw error;
  }
}

export async function rfcAdtRequest(
  config: SapConfig,
  url: string,
  method: string,
  timeoutMs: number,
  data?: unknown,
  params?: Record<string, unknown>,
  headers?: Record<string, unknown>,
) {
  // Over HTTP axios always sends an Accept header; ADT rejects requests without one.
  const merged: Record<string, unknown> = { ...(headers || {}) };
  if (!Object.keys(merged).some((k) => k.toLowerCase() === "accept")) {
    merged.Accept = "application/json, text/plain, */*";
  }
  const request = {
    REQUEST_LINE: { METHOD: method.toUpperCase(), URI: buildRfcUri(url, params), VERSION: "HTTP/1.1" },
    HEADER_FIELDS: Object.entries(merged)
      .filter(([k, v]) => v !== undefined && v !== null && !/^(authorization|cookie|x-csrf-token|x-sap-client)$/i.test(k))
      .map(([NAME, VALUE]) => ({ NAME, VALUE: String(VALUE) })),
    MESSAGE_BODY: toBody(data),
  };
  // One RFC connection, one request at a time (like one stateful HTTP session).
  const run = async () => {
    let raw;
    try {
      raw = await callOnce(config, request, timeoutMs);
    } catch (first: any) {
      // A dropped connection (router/timeout) gets one fresh attempt.
      if (client) throw new Error(rfcErrorMessage(first, config.password));
      try {
        raw = await callOnce(config, request, timeoutMs);
      } catch (second) {
        throw new Error(rfcErrorMessage(second, config.password));
      }
    }
    const response = fromRfcResponse(raw);
    if (response.status >= 400) {
      throw new AxiosError(
        `Request failed with status code ${response.status}`,
        String(response.status),
        undefined,
        undefined,
        { ...response, config: { headers: {} } } as any,
      );
    }
    return response;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

export async function closeRfc() {
  const c = client;
  client = null;
  try {
    if (c?.alive) await c.close();
  } catch {
    /* ignore */
  }
}
