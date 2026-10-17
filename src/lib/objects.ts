import { McpError, ErrorCode } from "./utils";

export const OBJECT_TYPES = [
  "PROG",
  "INCL",
  "CLAS",
  "INTF",
  "FUGR",
  "FUNC",
  "TABL",
  "STRU",
  "VIEW",
  "DTEL",
  "DOMA",
  "TTYP",
  "DDLS",
  "BDEF",
  "SRVD",
  "MSAG",
  "TRAN",
] as const;

export const SOURCE_TYPES = ["PROG", "INCL", "CLAS", "INTF", "FUNC", "DDLS", "BDEF", "SRVD"] as const;

export const CLASS_INCLUDES = [
  "main",
  "definitions",
  "implementations",
  "macros",
  "testclasses",
] as const;

const NAME_RE = /^[A-Z0-9_/]{1,40}$/;

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

export function checkName(value: unknown, label: string): string {
  const name = String(value ?? "").trim().toUpperCase();
  if (!NAME_RE.test(name)) invalid(`Invalid ${label}: ${value ?? ""}`);
  return name;
}

// ADT uses lower-case names and lower-case escapes (/NS/X -> %2fns%2fx)
const enc = (name: string) =>
  encodeURIComponent(name.toLowerCase()).replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());

/** ADT URI (path) of a repository object. */
export function objectUri(args: any): string {
  const type = String(args?.object_type ?? "").trim().toUpperCase();
  const name = checkName(args?.object_name, "object_name");
  switch (type) {
    case "PROG":
      return `/sap/bc/adt/programs/programs/${enc(name)}`;
    case "INCL":
      return `/sap/bc/adt/programs/includes/${enc(name)}`;
    case "CLAS":
      return `/sap/bc/adt/oo/classes/${enc(name)}`;
    case "INTF":
      return `/sap/bc/adt/oo/interfaces/${enc(name)}`;
    case "FUGR":
      return `/sap/bc/adt/functions/groups/${enc(name)}`;
    case "FUNC": {
      const group = checkName(args?.function_group, "function_group (required for FUNC)");
      return `/sap/bc/adt/functions/groups/${enc(group)}/fmodules/${enc(name)}`;
    }
    case "TABL":
      return `/sap/bc/adt/ddic/tables/${enc(name)}`;
    case "STRU":
      return `/sap/bc/adt/ddic/structures/${enc(name)}`;
    case "VIEW":
      return `/sap/bc/adt/ddic/views/${enc(name)}`;
    case "DTEL":
      return `/sap/bc/adt/ddic/dataelements/${enc(name)}`;
    case "DOMA":
      return `/sap/bc/adt/ddic/domains/${enc(name)}`;
    case "TTYP":
      return `/sap/bc/adt/ddic/tabletypes/${enc(name)}`;
    case "DDLS":
      return `/sap/bc/adt/ddic/ddl/sources/${enc(name)}`;
    case "BDEF":
      return `/sap/bc/adt/bo/behaviordefinitions/${enc(name)}`;
    case "SRVD":
      return `/sap/bc/adt/ddic/srvd/sources/${enc(name)}`;
    case "MSAG":
      return `/sap/bc/adt/messageclass/${enc(name)}`;
    case "TRAN":
      return `/sap/bc/adt/vit/wb/object_type/trant/object_name/${encodeURIComponent(name)}`;
    default:
      invalid(`object_type must be one of ${OBJECT_TYPES.join(", ")}`);
  }
}

/** URI of the active source of a source-based object (class include optional). */
export function sourceUri(args: any): string {
  const type = String(args?.object_type ?? "").trim().toUpperCase();
  if (!(SOURCE_TYPES as readonly string[]).includes(type)) {
    invalid(`object_type must be one of ${SOURCE_TYPES.join(", ")} for source versions`);
  }
  const base = objectUri(args);
  if (type === "CLAS") {
    const include = String(args?.include ?? "main").toLowerCase();
    if (!(CLASS_INCLUDES as readonly string[]).includes(include)) {
      invalid(`include must be one of ${CLASS_INCLUDES.join(", ")}`);
    }
    return `${base}/includes/${include}`;
  }
  return `${base}/source/main`;
}

/** Accept only ADT paths of version contents, never arbitrary URLs. */
export function checkVersionUri(value: unknown): string {
  const uri = String(value ?? "").trim();
  if (
    !/^\/sap\/bc\/adt\/[A-Za-z0-9_%/.\-~]+\/versions\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/content$/.test(uri) ||
    uri.includes("..")
  ) {
    invalid("version_uri must be a version content URI returned by GetVersionHistory");
  }
  return uri;
}
