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

/** Key/value rows of the first (header) table inside the HTML summary of a dump entry. */
export function summaryHeader(html: string): Record<string, string> {
    const header: Record<string, string> = {};
    const table = /<table[^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1] ?? '';
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let m: RegExpExecArray | null;
    while ((m = rowRe.exec(table))) {
        const cells = [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => htmlToText(c[1]));
        if (cells.length >= 2 && cells[0] && !(cells[0] in header)) {
            header[cells[0].replace(/:$/, '').trim()] = cells.slice(1).join(' ').trim();
        }
    }
    return header;
}

const SECTIONS: Record<string, string> = {
    WHATHAPPENED: 'whatHappened',
    ERROR: 'errorAnalysis',
    TERMINATION: 'whereTerminated',
    SOURCE: 'sourceExtract',
    STACK: 'activeCalls',
};

/** Text of the summary sections (split by their <h4 id=...> anchors). */
export function summarySections(html: string): Record<string, any> {
    const out: Record<string, any> = {};
    const parts = html.split(/<h4[^>]*id="([A-Z]+)"[^>]*>[\s\S]*?<\/h4>/i);
    for (let i = 1; i < parts.length; i += 2) {
        const key = SECTIONS[parts[i].toUpperCase()];
        if (!key) continue;
        const body = parts[i + 1] || '';
        if (key === 'activeCalls') {
            out[key] = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
                .map((r) => [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => htmlToText(c[1])))
                .filter((c) => c.length >= 5)
                .map((c) => `${c[0]} ${c[1]} ${c[3]}:${c[4]}`);
        } else if (key === 'sourceExtract') {
            const lines = [...body.matchAll(/<div[^>]*class="sourceline( highlight)?"[^>]*>([\s\S]*?)<\/div>/gi)].map(
                (d) => (d[1] ? '>> ' : '   ') + htmlToText(d[2]).replace(/\u00a0/g, ' '),
            );
            out[key] = lines.length ? lines.join('\n') : htmlToText(body);
        } else {
            out[key] = htmlToText(body);
        }
    }
    return out;
}

/** "adt://SID/sap/bc/adt/runtime/dump/<id>" or "/sap/bc/adt/runtime/dump/<id>" -> "<id>" */
export function dumpIdFromHref(href: string): string | undefined {
    const i = href.indexOf(DUMP_PREFIX);
    return i >= 0 ? href.slice(i + DUMP_PREFIX.length) : undefined;
}

export function parseDumpFeed(xml: string, includeDetails = false) {
    const feed = child(parseXml(xml), 'feed');
    return asArray(feed?.entry).map((e: any) => {
        const links = asArray(e.link).map(attrs);
        const self = links.find((l) => l.rel === 'self' && dumpIdFromHref(l.href || '')) || links.find((l) => dumpIdFromHref(l.href || ''));
        const categories: Record<string, string> = {};
        for (const c of asArray(e.category).map(attrs)) {
            if (c.label && c.term) categories[c.label] = c.term;
        }
        const summaryHtml = text(e.summary);
        const header = summaryHeader(summaryHtml);
        const item: Record<string, any> = {
            id: (self && dumpIdFromHref(self.href)) || text(e.id),
            datetime: text(e.published) || text(e.updated),
            user: text(child(e, 'author', 'name')),
            title: text(e.title),
            categories,
            header,
        };
        if (includeDetails) Object.assign(item, summarySections(summaryHtml));
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
    id = dumpIdFromHref(id) ?? id;
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
