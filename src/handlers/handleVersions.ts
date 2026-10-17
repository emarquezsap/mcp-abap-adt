import { McpError, ErrorCode, makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { sourceUri, checkVersionUri } from '../lib/objects';
import { parseXml, asArray, attrs, child, text, jsonLines } from '../lib/xml';
import { unifiedDiff } from '../lib/diff';

export function parseVersionFeed(xml: string) {
    const feed = child(parseXml(xml), 'feed');
    return asArray(feed?.entry).map((e: any, index: number) => {
        const links = asArray(e.link).map(attrs);
        const transport =
            links.find((l) => (l.type || '').includes('transportrequests'))?.name || links.find((l) => l.name)?.name || '';
        return {
            index,
            date: text(e.updated),
            author: text(child(e, 'author', 'name')),
            transport,
            title: text(e.title),
            uri: attrs(e.content).src || '',
        };
    });
}

async function getText(path: string) {
    const response = await makeAdtRequest(`${await getBaseUrl()}${path}`, 'GET', 30000, undefined, undefined, {
        Accept: 'text/plain',
    });
    return String(response.data);
}

async function versions(args: any) {
    const src = sourceUri(args);
    const response = await makeAdtRequest(`${await getBaseUrl()}${src}/versions`, 'GET', 30000, undefined, undefined, {
        Accept: 'application/atom+xml;type=feed',
    });
    return { src, list: parseVersionFeed(String(response.data)) };
}

export async function handleGetVersionHistory(args: any) {
    try {
        const { src, list } = await versions(args);
        return return_text_response(jsonLines({ source: src, versions: list.length }, 'history', list), args);
    } catch (error) {
        return return_error(error);
    }
}

export async function handleGetVersionSource(args: any) {
    try {
        const uri = checkVersionUri(args?.version_uri);
        return return_text_response(await getText(uri), args);
    } catch (error) {
        return return_error(error);
    }
}

/**
 * Diff two versions. Defaults: from = latest version in the history (or the
 * previous one when compare_to_active is false), to = current active source.
 */
export async function handleCompareVersions(args: any) {
    try {
        const { src, list } = await versions(args);
        let fromUri = args?.from_version_uri ? checkVersionUri(args.from_version_uri) : undefined;
        const toUri = args?.to_version_uri ? checkVersionUri(args.to_version_uri) : undefined;
        if (!fromUri) {
            // newest entry first in the ADT feed; when diffing two stored versions use the one after "to"
            const idx = toUri ? list.findIndex((v) => v.uri === toUri) + 1 : 0;
            fromUri = list[idx]?.uri;
            if (!fromUri) {
                throw new McpError(ErrorCode.InvalidParams, 'No earlier version found to compare with');
            }
        }
        const [oldText, newText] = await Promise.all([getText(fromUri), getText(toUri || src)]);
        const label = (u: string) => list.find((v) => v.uri === u) ?? { date: '', author: '', transport: '' };
        const lf = label(fromUri);
        const oldLabel = `${fromUri} (${lf.date} ${lf.author} ${lf.transport})`.trim();
        const newLabel = toUri ? `${toUri} (${label(toUri).date} ${label(toUri).author} ${label(toUri).transport})` : `${src} (active)`;
        const result = unifiedDiff(oldText, newText, oldLabel, newLabel, Number(args?.context_lines ?? 3));
        if (!result) {
            return return_text_response('The versions differ too much for an inline diff; use GetVersionSource with paging instead.', args);
        }
        const head = `Added lines: ${result.added}, removed lines: ${result.removed}`;
        return return_text_response(result.diff ? `${head}\n${result.diff}` : `${head}\nNo differences.`, args);
    } catch (error) {
        return return_error(error);
    }
}
