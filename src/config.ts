export interface SapConfig {
  url: string;
  username: string;
  password: string;
  client: string;
  caFile?: string;
  language?: string;
  rejectUnauthorized?: boolean;
  /** "http" (default, SAP_URL) or "rfc" (ADT over RFC, e.g. through a SAProuter) */
  connection: "http" | "rfc";
  /** node-rfc connection parameters when connection is "rfc" (password not included) */
  rfc?: Record<string, string>;
}

/** Placeholder origin used internally to build ADT paths in RFC mode. */
export const RFC_ORIGIN = "https://adt-over-rfc.invalid";

function getRfcConfig(): SapConfig {
  const env = process.env;
  const {
    SAP_USERNAME: username,
    SAP_PASSWORD: password,
    SAP_CLIENT: client,
  } = env;
  if (!username || !password || !client) {
    throw new Error(
      "Missing required environment variables: SAP_USERNAME, SAP_PASSWORD, SAP_CLIENT",
    );
  }
  if (!/^\d{3}$/.test(client))
    throw new Error("SAP_CLIENT must have three digits");
  const rfc: Record<string, string> = { user: username, client };
  if (env.SAP_ASHOST) {
    if (!env.SAP_SYSNR || !/^\d{2}$/.test(env.SAP_SYSNR))
      throw new Error("SAP_SYSNR must be the two-digit instance number");
    rfc.ashost = env.SAP_ASHOST;
    rfc.sysnr = env.SAP_SYSNR;
  } else if (env.SAP_MSHOST) {
    if (!env.SAP_SYSID || !env.SAP_GROUP)
      throw new Error("SAP_MSHOST needs SAP_SYSID and SAP_GROUP");
    rfc.mshost = env.SAP_MSHOST;
    rfc.sysid = env.SAP_SYSID;
    rfc.group = env.SAP_GROUP;
    if (env.SAP_MSSERV) rfc.msserv = env.SAP_MSSERV;
  } else {
    throw new Error(
      "SAP_CONNECTION=rfc needs SAP_ASHOST + SAP_SYSNR, or SAP_MSHOST + SAP_SYSID + SAP_GROUP",
    );
  }
  if (env.SAP_ROUTER) {
    if (
      !/^(\/H\/[^/\s]+(\/S\/[\w]+)?(\/[WP]\/[^/\s]+)?)+$/.test(env.SAP_ROUTER)
    )
      throw new Error(
        "SAP_ROUTER must be a SAProuter string like /H/router.host/S/3299",
      );
    rfc.saprouter = env.SAP_ROUTER;
  }
  // Extra node-rfc parameters, e.g. SAP_RFC_SNC_MODE=1, SAP_RFC_SNC_PARTNERNAME=p:CN=...
  for (const [key, value] of Object.entries(env)) {
    const m = /^SAP_RFC_([A-Z0-9_]+)$/.exec(key);
    if (m && value && !/PASS/i.test(m[1])) rfc[m[1].toLowerCase()] = value;
  }
  const language = env.SAP_LANGUAGE;
  if (language && !/^[A-Za-z]{2}$/.test(language))
    throw new Error("SAP_LANGUAGE must be a two-letter language code");
  if (language) rfc.lang = language.toUpperCase();
  return {
    connection: "rfc",
    rfc,
    language: language?.toUpperCase(),
    url: RFC_ORIGIN,
    username,
    password,
    client,
  };
}

export function getConfig(): SapConfig {
  const mode = (process.env.SAP_CONNECTION || "http").toLowerCase();
  if (mode === "rfc") return getRfcConfig();
  if (mode !== "http")
    throw new Error("SAP_CONNECTION must be http (default) or rfc");
  const {
    SAP_URL: url,
    SAP_USERNAME: username,
    SAP_PASSWORD: password,
    SAP_CLIENT: client,
  } = process.env;
  if (!url || !username || !password || !client) {
    throw new Error(
      "Missing required environment variables: SAP_URL, SAP_USERNAME, SAP_PASSWORD, SAP_CLIENT",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("SAP_URL must be an absolute HTTP(S) URL");
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["", "/"].includes(parsed.pathname)
  ) {
    throw new Error(
      "SAP_URL must contain only an HTTP(S) origin, without credentials, path, query or fragment",
    );
  }
  const tls = process.env.TLS_REJECT_UNAUTHORIZED ?? "1";
  if (!["0", "1"].includes(tls))
    throw new Error("TLS_REJECT_UNAUTHORIZED must be 1 (default) or 0");
  const language = process.env.SAP_LANGUAGE;
  if (language && !/^[A-Za-z]{2}$/.test(language))
    throw new Error("SAP_LANGUAGE must be a two-letter language code");
  return {
    connection: "http",
    language: language?.toUpperCase(),
    url: parsed.origin,
    username,
    password,
    client,
    caFile: process.env.SAP_CA_FILE || undefined,
    rejectUnauthorized: tls !== "0",
  };
}
