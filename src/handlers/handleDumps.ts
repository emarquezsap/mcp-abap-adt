import { McpError, ErrorCode, makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { parseXml, asArray, attrs, child, text, htmlToText, jsonLines } from '../lib/xml';

const VALUE_RE = /^[A-Za-z0-9_/*\-.$ ]{1,60}$/;
const DUMP_PREFIX = '/sap/bc/adt/runtime/dump/';

function invalid(message: string): never {
    throw new McpError(ErrorCode.InvalidParams, message);
}

function filterValue(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const v = String(value).trim();
    if (!VALUE_RE.test(v)) invalid(`Invalid ${label}: ${v}`);
    return v;
}

function toDate(value: unknown, label: string): string | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const v = String(value).trim().replace(/-/g, '');
    if (!/^\d{8}$/.test(v)) invalid(`${label} must be YYYYMMDD or YYYY-MM-DD`);
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/** Feed query in ADT syntax, e.g. and ( equals ( user , DEVELOPER ) ) */
export function buildDumpQuery(args: any): string | undefined {
    const parts: string[] = [];
    const add = (op: string, attr: string, value?: string) => {
        if (value) parts.push(`${op} ( ${attr} , ${value.toUpperCase()} )`);
    };
    add('equals', 'user', filterValue(args?.user, 'user'));
    add('equals', 'runtimeError', filterValue(args?.runtime_error, 'runtime_error'));
    add('contains', 'objectName', filterValue(args?.program, 'program'));
    add('equals', 'exception', filterValue(args?.exception, 'exception'));
    add('equals', 'package', filterValue(args?.package, 'package'));
    return parts.length ? `and ( ${parts.join(' , ')} )` : undefined;
}

/** Key/value rows of the header table inside the HTML summary of a dump entry. */
export function summaryHeader(html: string): Record<string, string> {
    const header: Record<string, string> = {};
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(html))) {
        const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => htmlToText(c[1]));
        if (cells.length >= 2 && cells[0] && cells[0].length < 60 && !(cells[0] in header)) {
            header[cells[0].replace(/:$/, '')] = cells.slice(1).join(' ').trim();
        }
    }
    return header;
}

export function parseDumpFeed(xml: string, includeDetails = false) {
    const feed = child(parseXml(xml), 'feed');
    return asArray(feed?.entry).map((e: any) => {
        const links = asArray(e.link).map(attrs);
        const self = links.find((l) => l.rel === 'self') || links.find((l) => (l.href || '').includes(DUMP_PREFIX));
        const categories: Record<string, string> = {};
        for (const c of asArray(e.category).map(attrs)) {
            if (c.label && c.term) categories[c.label] = c.term;
        }
        const summaryHtml = text(e.summary);
        const header = summaryHeader(summaryHtml);
        const item: Record<string, any> = {
            id: self?.href ? self.href.replace(DUMP_PREFIX, '') : text(e.id),
            datetime: text(e.published) || text(e.updated),
            user: text(child(e, 'author', 'name')),
            title: text(e.title),
            categories,
            header,
        };
        if (includeDetails) item.summary = htmlToText(summaryHtml).slice(0, 6000);
        return item;
    });
}

export async function handleListDumps(args: any) {
    try {
        const query = buildDumpQuery(args);
        const from = toDate(args?.from_date, 'from_date');
        const to = toDate(args?.to_date, 'to_date');
        const max = Math.min(Math.max(Number(args?.max_results) || 20, 1), 200);
        const url = `${await getBaseUrl()}/sap/bc/adt/runtime/dumps`;
        const response = await makeAdtRequest(
            url,
            'GET',
            30000,
            undefined,
            query ? { $query: query } : undefined,
            { Accept: 'application/atom+xml;type=feed' },
        );
        let dumps = parseDumpFeed(String(response.data), !!args?.include_details);
        if (from) dumps = dumps.filter((d) => d.datetime.slice(0, 10) >= from);
        if (to) dumps = dumps.filter((d) => d.datetime.slice(0, 10) <= to);
        dumps.sort((a, b) => (a.datetime < b.datetime ? 1 : -1));
        const total = dumps.length;
        return return_text_response(
            jsonLines({ query: query || '(none)', matched: total, returned: Math.min(total, max) }, 'dumps', dumps.slice(0, max)),
            args,
        );
    } catch (error) {
        return return_error(error);
    }
}

export function checkDumpId(value: unknown): string {
    let id = String(value ?? '').trim();
    if (id.startsWith(DUMP_PREFIX)) id = id.slice(DUMP_PREFIX.length);
    if (!/^[A-Za-z0-9%._\-~]{1,400}$/.test(id)) invalid('dump_id must be an id returned by ListDumps');
    return id;
}

export async function handleGetDump(args: any) {
    try {
        const id = checkDumpId(args?.dump_id);
        const url = `${await getBaseUrl()}${DUMP_PREFIX}${id}`;
        const response = await makeAdtRequest(url, 'GET', 30000, undefined, undefined, {
            Accept: 'text/plain, text/html, application/xml;q=0.5, */*;q=0.1',
        });
        let body = String(response.data);
        if (/<\s*(html|body|div|table|p)\b/i.test(body)) body = htmlToText(body);
        return return_text_response(body, args);
    } catch (error) {
        return return_error(error);
    }
}
