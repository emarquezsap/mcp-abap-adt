import { McpError, ErrorCode, makeAdtRequest, getBaseUrl } from "./utils";
import { parseXml, asArray, attrs, text, child, jsonLines } from "./xml";

/**
 * Tables that are never read through this server unless SAP_TABLE_DENYLIST
 * overrides the list. They hold password hashes, RFC credentials, secure
 * store entries or PSEs.
 */
export const DEFAULT_TABLE_DENYLIST = [
  "USR02",
  "USH02",
  "USH02_ARC_TMP",
  "USRPWDHISTORY",
  "RFCDES",
  "RSECTAB",
  "RSECACTB",
  "SSF_PSE_D",
];

function invalid(message: string): never {
  throw new McpError(ErrorCode.InvalidParams, message);
}

/**
 * SAP_TABLE_DENYLIST: comma separated names with * wildcards
 * (e.g. "USR02,ZHR_*,PA0008"). When set it replaces the defaults;
 * "-" disables the denylist.
 */
export function getTableDenylist(env = process.env): string[] {
  const raw = env.SAP_TABLE_DENYLIST;
  if (raw === undefined || raw.trim() === "") return DEFAULT_TABLE_DENYLIST;
  if (raw.trim() === "-") return [];
  return raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
}

function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

export function isTableDenied(table: string, denylist = getTableDenylist()): boolean {
  const name = table.toUpperCase();
  return denylist.some((p) => wildcardToRegExp(p).test(name));
}

/** Remove '...' and `...` literals so keywords inside them are not inspected. */
export function stripLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/`(?:[^`]|``)*`/g, "``");
}

/** Every data source named after FROM or JOIN (including subqueries). */
export function extractTables(sql: string): string[] {
  const clean = stripLiterals(sql).toUpperCase();
  const found = new Set<string>();
  const re = /\b(?:FROM|JOIN)\s+([A-Z0-9_/]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) found.add(m[1]);
  return [...found];
}

export function assertTablesAllowed(sql: string) {
  const denylist = getTableDenylist();
  const blocked = extractTables(sql).filter((t) => isTableDenied(t, denylist));
  if (blocked.length) {
    invalid(
      `Access to ${blocked.join(", ")} is blocked by the table denylist (SAP_TABLE_DENYLIST)`,
    );
  }
}

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|MODIFY|COMMIT|ROLLBACK|EXEC|CALL|INTO|APPENDING|UP\s+TO|OPEN\s+CURSOR|FETCH)\b/;

/**
 * Validate a free ABAP SQL SELECT for the ADT data preview: one statement,
 * no comments, no INTO/UP TO (the preview adds them), SELECT/WITH only.
 */
export function normalizeSelect(sql: unknown): string {
  if (typeof sql !== "string" || !sql.trim()) invalid("query is required");
  let q = sql.trim();
  if (/^\*|\n\s*\*/.test(q)) invalid("ABAP comment lines (*) are not allowed");
  if (/["]/.test(stripLiterals(q))) invalid('Comments (") are not allowed');
  q = q.replace(/[\r\n\t]+/g, " ").replace(/\.\s*$/, "").trim();
  const bare = stripLiterals(q).toUpperCase();
  // "." ends an ABAP statement and ";" is never valid: both would allow a second statement
  if (/[;.]/.test(bare)) invalid("Only a single SELECT statement is allowed");
  if (!/^(SELECT|WITH)\b/.test(bare)) invalid("Only SELECT statements are allowed");
  const forbidden = bare.match(FORBIDDEN);
  if (forbidden) invalid(`Keyword not allowed in a read-only query: ${forbidden[1]}`);
  if (q.length > 8000) invalid("query is too long (max 8000 characters)");
  return q;
}

export interface QueryResult {
  totalRows: number;
  returnedRows: number;
  executedQuery: string;
  executionTime?: string;
  columns: { name: string; type: string; description?: string }[];
  rows: Record<string, string>[];
}

export function parseDataPreview(xml: string): QueryResult {
  const doc = parseXml(xml);
  const root = child(doc, "tableData");
  if (!root) throw new Error("Unexpected data preview response");
  const cols = asArray(root.columns);
  const columns = cols.map((c) => {
    const a = attrs(c.metadata);
    const col: { name: string; type: string; description?: string } = {
      name: a.name || "",
      type: a.type || "",
    };
    if (a.description && a.description !== a.name) col.description = a.description;
    return col;
  });
  const values = cols.map((c) => asArray(child(c, "dataSet", "data")).map(text));
  const count = values.reduce((m, v) => Math.max(m, v.length), 0);
  const rows: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const row: Record<string, string> = {};
    columns.forEach((c, j) => (row[c.name] = values[j][i] ?? ""));
    rows.push(row);
  }
  return {
    totalRows: Number(text(root.totalRows)) || count,
    returnedRows: count,
    executedQuery: text(root.executedQueryString).replace(/\s+/g, " ").trim(),
    executionTime: text(root.queryExecutionTime) || undefined,
    columns,
    rows,
  };
}

/**
 * Compact JSON for data preview responses; any other body (unexpected
 * formats) is returned unchanged so nothing is lost.
 */
export function compactOrRaw(data: unknown): string {
  const raw = String(data);
  if (!/<(\w+:)?tableData[\s>]/.test(raw)) return raw;
  try {
    return formatQueryResult(parseDataPreview(raw));
  } catch {
    return raw;
  }
}

export function formatQueryResult(result: QueryResult): string {
  const { rows, ...header } = result;
  return jsonLines(header, "rows", rows);
}

/** Run a SELECT through /sap/bc/adt/datapreview/freestyle and return the raw response. */
export async function runFreestyle(query: string, maxRows: number) {
  const url = `${await getBaseUrl()}/sap/bc/adt/datapreview/freestyle`;
  return makeAdtRequest(
    url,
    "POST",
    30000,
    query,
    { rowNumber: maxRows },
    { "Content-Type": "text/plain", Accept: "application/xml, text/plain, */*" },
  );
}

/** Run a SELECT and parse the result rows. */
export async function selectRows(query: string, maxRows = 1000): Promise<QueryResult> {
  assertTablesAllowed(query);
  const response = await runFreestyle(query, maxRows);
  return parseDataPreview(String(response.data));
}

/** Quote an ABAP SQL literal. */
export function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Condition for a language field given a 1-char SAP key or a 2-letter ISO code. */
export function languageCondition(field: string, language?: string): string {
  if (!language) return "";
  const l = language.trim().toUpperCase();
  if (/^[A-Z0-9]$/.test(l)) return `${field} = ${literal(l)}`;
  if (/^[A-Z]{2}$/.test(l))
    return `${field} IN ( SELECT SPRAS FROM T002 WHERE LAISO = ${literal(l)} )`;
  invalid("language must be a 1-character SAP key (S) or ISO code (ES)");
}
