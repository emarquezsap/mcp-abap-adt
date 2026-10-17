import { makeAdtRequest, return_error, return_text_response, getBaseUrl, McpError, ErrorCode } from '../lib/utils';
import { objectUri } from '../lib/objects';
import { parseXml, asArray, attrs, child, text, jsonLines } from '../lib/xml';

const VARIANT_RE = /^[A-Z0-9_/]{1,30}$/;

export function parseWorklist(xml: string) {
    const root = child(parseXml(xml), 'worklist');
    const findings: Record<string, any>[] = [];
    for (const o of asArray(child(root, 'objects', 'object'))) {
        const oa = attrs(o);
        for (const f of asArray(child(o, 'findings', 'finding'))) {
            const fa = attrs(f);
            const line = /start=(\d+)/.exec(fa.location || '')?.[1];
            findings.push({
                object: oa.name,
                type: oa.type,
                package: oa.packageName,
                priority: Number(fa.priority) || fa.priority,
                check: fa.checkTitle,
                message: fa.messageTitle,
                line: line ? Number(line) : undefined,
                exempted: fa.exemptionApproval || undefined,
                location: fa.location,
            });
        }
    }
    findings.sort((a, b) => (a.priority as number) - (b.priority as number));
    return { worklistId: attrs(root).id, findings };
}

async function req(path: string, method: string, accept: string, body?: string, params?: any) {
    const headers: Record<string, string> = { Accept: accept };
    if (body) headers['Content-Type'] = 'application/xml';
    const r = await makeAdtRequest(`${await getBaseUrl()}${path}`, method, 30000, body, params, headers);
    return String(r.data);
}

/**
 * Runs an ATC check (does not change any object; SAP stores the run result
 * as a worklist like Eclipse does).
 */
export async function handleRunAtcCheck(args: any) {
    try {
        const uri = objectUri(args);
        let variant = args?.check_variant ? String(args.check_variant).toUpperCase() : '';
        if (variant && !VARIANT_RE.test(variant)) throw new McpError(ErrorCode.InvalidParams, 'Invalid check_variant');
        if (!variant) {
            const custom = parseXml(
                await req('/sap/bc/adt/atc/customizing', 'GET', 'application/xml, application/vnd.sap.atc.customizing-v1+xml'),
            );
            const props = asArray(child(custom, 'customizing', 'properties', 'property')).map(attrs);
            variant = props.find((p) => p.name === 'systemCheckVariant')?.value || 'DEFAULT';
        }
        const worklistId = (await req('/sap/bc/adt/atc/worklists', 'POST', 'text/plain', undefined, { checkVariant: variant })).trim();
        const max = Math.min(Math.max(Number(args?.max_findings) || 100, 1), 1000);
        const runBody = `<?xml version="1.0" encoding="UTF-8"?>
<atc:run maximumVerdicts="${max}" xmlns:atc="http://www.sap.com/adt/atc">
  <objectSets xmlns:adtcore="http://www.sap.com/adt/core">
    <objectSet kind="inclusive">
      <adtcore:objectReferences>
        <adtcore:objectReference adtcore:uri="${uri}"/>
      </adtcore:objectReferences>
    </objectSet>
  </objectSets>
</atc:run>`;
        const run = parseXml(await req('/sap/bc/adt/atc/runs', 'POST', 'application/xml', runBody, { worklistId }));
        const infos = asArray(child(run, 'worklistRun', 'infos', 'info')).map((i: any) => ({
            type: text(i.type),
            description: text(i.description),
        }));
        const worklist = parseWorklist(
            await req(`/sap/bc/adt/atc/worklists/${encodeURIComponent(worklistId)}`, 'GET', 'application/atc.worklist.v1+xml', undefined, {
                includeExemptedFindings: !!args?.include_exempted,
            }),
        );
        const counts = [1, 2, 3, 4].map((p) => worklist.findings.filter((f) => f.priority === p).length);
        return return_text_response(
            jsonLines(
                {
                    object: uri,
                    checkVariant: variant,
                    worklistId,
                    infos: infos.length ? infos : undefined,
                    priority1: counts[0],
                    priority2: counts[1],
                    priority3: counts[2],
                    findings: worklist.findings.length,
                },
                'items',
                worklist.findings,
            ),
            args,
        );
    } catch (error) {
        return return_error(error);
    }
}
