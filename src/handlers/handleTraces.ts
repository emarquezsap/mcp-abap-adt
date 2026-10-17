import { McpError, ErrorCode, makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { getConfig } from '../config';
import { parseXml, asArray, attrs, child, text, simplify, jsonLines } from '../lib/xml';

const TRACE_PREFIX = '/sap/bc/adt/runtime/traces/abaptraces/';

function invalid(message: string): never {
    throw new McpError(ErrorCode.InvalidParams, message);
}

async function get(path: string, params?: any, accept = 'application/xml, application/atom+xml, */*') {
    const r = await makeAdtRequest(`${await getBaseUrl()}${path}`, 'GET', 30000, undefined, params, { Accept: accept });
    return String(r.data);
}

export function parseTraceList(xml: string) {
    const feed = child(parseXml(xml), 'feed');
    return asArray(feed?.entry).map((e: any) => {
        const ext = simplify(e.extendedData) || {};
        return {
            id: text(e.id).replace(TRACE_PREFIX, ''),
            title: text(e.title),
            published: text(e.published),
            author: text(child(e, 'author', 'name')),
            ...(typeof ext === 'object' ? ext : { extendedData: ext }),
        };
    });
}

export async function handleListTraces(args: any) {
    try {
        let user = args?.user ? String(args.user).toUpperCase() : getConfig().username.toUpperCase();
        if (!/^[A-Z0-9_.\-@]{1,40}$/.test(user)) invalid('Invalid user');
        const traces = parseTraceList(await get('/sap/bc/adt/runtime/traces/abaptraces', { user }));
        return return_text_response(jsonLines({ user, traces: traces.length }, 'items', traces), args);
    } catch (error) {
        return return_error(error);
    }
}

const VIEWS: Record<string, { path: string; accept?: string; list: string[] }> = {
    hitlist: { path: 'hitlist', list: ['hitlist', 'entry'] },
    dbaccess: { path: 'dbAccesses', list: ['dbAccesses', 'dbAccess'] },
    statements: {
        path: 'statements',
        accept: 'application/vnd.sap.adt.runtime.traces.abaptraces.aggcalltree+xml, application/xml',
        list: ['statements', 'statement'],
    },
};

export function checkTraceId(value: unknown): string {
    let id = String(value ?? '').trim();
    if (id.startsWith(TRACE_PREFIX)) id = id.slice(TRACE_PREFIX.length);
    if (!/^[A-Za-z0-9%._\-~]{1,200}$/.test(id)) invalid('trace_id must be an id returned by ListTraces');
    return id;
}

export async function handleGetTraceDetails(args: any) {
    try {
        const id = checkTraceId(args?.trace_id);
        const viewName = String(args?.view || 'hitlist').toLowerCase();
        const view = VIEWS[viewName];
        if (!view) invalid(`view must be one of ${Object.keys(VIEWS).join(', ')}`);
        const xml = await get(`${TRACE_PREFIX}${id}/${view.path}`, { withSystemEvents: !!args?.with_system_events }, view.accept);
        const root = child(parseXml(xml), view.list[0]);
        const items = asArray(root?.[view.list[1]]).map(simplify);
        const header: Record<string, any> = { trace: id, view: viewName, ...attrs(root) };
        for (const k of Object.keys(header)) if (k.startsWith('xmlns')) delete header[k];
        if (viewName === 'dbaccess' && root?.tables) header.tables = asArray(child(root, 'tables', 'table')).map(attrs);
        const max = Math.min(Math.max(Number(args?.max_results) || 200, 1), 5000);
        header.items = items.length;
        return return_text_response(jsonLines(header, 'entries', items.slice(0, max)), args);
    } catch (error) {
        return return_error(error);
    }
}
