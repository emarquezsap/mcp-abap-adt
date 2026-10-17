import { McpError, ErrorCode } from '../lib/utils';
import { makeAdtRequest, return_error, return_response, getBaseUrl } from '../lib/utils';

// Plain DDIC names, including namespaces like /NS/TAB
const NAME_RE = /^[A-Z0-9_/]+$/;
// Column names (also allow ~ for CDS/join aliases such as T~FIELD)
const FIELD_RE = /^[A-Z0-9_/~]+$/;
// One ORDER BY item: FIELD [ASCENDING|DESCENDING]
const ORDER_ITEM_RE = /^[A-Z0-9_/~]+(\s+(ASCENDING|DESCENDING))?$/;

function invalid(message: string): never {
    throw new McpError(ErrorCode.InvalidParams, message);
}

function buildFieldList(fields: unknown): string {
    if (fields === undefined || fields === null || fields === '') return '*';
    const raw = Array.isArray(fields) ? fields : String(fields).split(',');
    const cols = raw.map((f) => String(f).trim().toUpperCase()).filter(Boolean);
    if (cols.length === 0) return '*';
    for (const col of cols) {
        if (!FIELD_RE.test(col)) invalid(`Invalid field name: ${col}`);
    }
    return cols.join(', ');
}

function buildWhere(where: unknown): string {
    if (where === undefined || where === null) return '';
    const clause = String(where).trim();
    if (!clause) return '';
    // Keep the statement single and comment-free: the ADT data preview only runs
    // SELECT statements, but we still refuse anything that could end or alter it.
    if (/[;"\r\n]/.test(clause)) {
        invalid('The WHERE clause must be a single line without ";" or \'"\' characters');
    }
    if (/^\s*WHERE\b/i.test(clause)) {
        invalid('Pass only the condition, without the WHERE keyword');
    }
    return ` WHERE ${clause}`;
}

function buildOrderBy(orderBy: unknown): string {
    if (orderBy === undefined || orderBy === null) return '';
    const raw = String(orderBy).trim();
    if (!raw) return '';
    const items = raw.split(',').map((i) => i.trim().toUpperCase().replace(/\s+/g, ' '));
    for (const item of items) {
        if (!ORDER_ITEM_RE.test(item)) invalid(`Invalid ORDER BY item: ${item}`);
    }
    return ` ORDER BY ${items.join(', ')}`;
}

export function buildTableQuery(args: any): string {
    const tableName = String(args.table_name).toUpperCase();
    // Guard against anything but a plain table/view name (namespaces like /NS/TAB are allowed)
    if (!NAME_RE.test(tableName)) {
        invalid(`Invalid table name: ${args.table_name}`);
    }
    return `SELECT ${buildFieldList(args.fields)} FROM ${tableName}${buildWhere(args.where)}${buildOrderBy(args.order_by)}`;
}

export async function handleGetTableContents(args: any) {
    try {
        if (!args?.table_name) {
            throw new McpError(ErrorCode.InvalidParams, 'Table name is required');
        }
        const query = buildTableQuery(args);
        const maxRows = args.max_rows || 100;
        const url = `${await getBaseUrl()}/sap/bc/adt/datapreview/freestyle`;
        const response = await makeAdtRequest(
            url,
            'POST',
            30000,
            query,
            { rowNumber: maxRows },
            { 'Content-Type': 'text/plain', 'Accept': 'application/xml, text/plain, */*' }
        );
        return return_response(response, args);
    } catch (error) {
        return return_error(error);
    }
}
