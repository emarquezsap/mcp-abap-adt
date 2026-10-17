import { makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { getConfig } from '../config';
import { selectRows, literal } from '../lib/sql';
import { parseXml, asArray, child, text, simplify } from '../lib/xml';

const CLIENT_ROLES: Record<string, string> = {
    P: 'Production',
    T: 'Test',
    C: 'Customizing',
    D: 'Demo',
    E: 'Training/Education',
    S: 'SAP reference',
};

async function tryGet(path: string, accept: string) {
    try {
        const r = await makeAdtRequest(`${await getBaseUrl()}${path}`, 'GET', 15000, undefined, undefined, { Accept: accept });
        return String(r.data);
    } catch {
        return undefined;
    }
}

/** System ID as reported by the ADT feeds (the author of every feed is the SID). */
function sidFromFeeds(xml: string | undefined): string | undefined {
    if (!xml) return undefined;
    try {
        const feed = child(parseXml(xml), 'feed');
        const authors = asArray(feed?.entry).map((e: any) => text(child(e, 'author', 'name'))).filter(Boolean);
        return authors[0] || text(child(feed, 'author', 'name')) || undefined;
    } catch {
        return undefined;
    }
}

export async function handleGetSystemInfo(args: any) {
    try {
        const config = getConfig();
        const info: Record<string, any> = {
            host: new URL(config.url).host,
            client: config.client,
            user: config.username,
            language: config.language || '(user default)',
        };

        const sysinfo = await tryGet('/sap/bc/adt/system/information', 'application/json, application/xml, */*');
        if (sysinfo) {
            try {
                if (sysinfo.trim().startsWith('{')) {
                    info.systemInformation = JSON.parse(sysinfo);
                } else {
                    // Atom feed of id/title pairs -> { id: title }
                    const entries = asArray(child(parseXml(sysinfo), 'feed', 'entry'));
                    const map: Record<string, string> = {};
                    for (const e of entries) {
                        const id = text(e.id);
                        if (id && !id.startsWith('NotAuthorized')) map[id] = text(e.title);
                    }
                    info.systemInformation = Object.keys(map).length ? map : simplify(parseXml(sysinfo));
                }
            } catch {
                /* ignore unknown formats */
            }
        }
        const sid = sidFromFeeds(await tryGet('/sap/bc/adt/feeds', 'application/atom+xml;type=feed'));
        if (sid) info.systemId = sid;

        try {
            const t000 = await selectRows(
                `SELECT MANDT, MTEXT, ORT01, CCCATEGORY, CCCORACTIV, CCNOCLIIND FROM T000 WHERE MANDT = ${literal(config.client)}`,
                1,
            );
            const row = t000.rows[0];
            if (row) {
                info.clientText = row.MTEXT;
                info.clientCity = row.ORT01;
                info.clientRole = CLIENT_ROLES[row.CCCATEGORY] || row.CCCATEGORY;
                info.clientChangeSetting = row.CCCORACTIV;
                info.crossClientChangeSetting = row.CCNOCLIIND;
            }
        } catch (e: any) {
            info.clientInfoError = e?.message || String(e);
        }
        try {
            const cvers = await selectRows(
                "SELECT COMPONENT, RELEASE, EXTRELEASE, COMP_TYPE FROM CVERS WHERE COMPONENT IN ('SAP_BASIS','SAP_ABA','S4CORE','SAP_APPL','SAP_UI','S4FND')",
                20,
            );
            info.components = cvers.rows.map((r) => ({ component: r.COMPONENT, release: r.RELEASE, sp: r.EXTRELEASE }));
        } catch (e: any) {
            info.componentsError = e?.message || String(e);
        }
        return return_text_response(JSON.stringify(info, null, 1), args);
    } catch (error) {
        return return_error(error);
    }
}
