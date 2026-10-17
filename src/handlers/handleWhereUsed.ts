import { makeAdtRequest, return_error, return_text_response, getBaseUrl } from '../lib/utils';
import { objectUri } from '../lib/objects';
import { parseXml, asArray, attrs, child, text, jsonLines } from '../lib/xml';

const BODY = `<?xml version="1.0" encoding="ASCII"?>
<usagereferences:usageReferenceRequest xmlns:usagereferences="http://www.sap.com/adt/ris/usageReferences">
  <usagereferences:affectedObjects/>
</usagereferences:usageReferenceRequest>`;

export function parseUsageReferences(xml: string) {
    const root = child(parseXml(xml), 'usageReferenceResult');
    const objects = asArray(child(root, 'referencedObjects', 'referencedObject')).map((r: any) => {
        const a = attrs(r);
        const adt = attrs(r.adtObject);
        return {
            uri: a.uri || '',
            parentUri: a.parentUri || '',
            usage: a.usageInformation || '',
            name: adt.name || '',
            type: adt.type || '',
            responsible: adt.responsible || '',
            package: attrs(child(r, 'adtObject', 'packageRef')).name || '',
            identifier: text(r.objectIdentifier),
        };
    });
    const byUri = new Map(objects.map((o) => [o.uri, o]));
    // Leaf entries carry usageInformation; parents are the containing objects.
    const usages = objects
        .filter((o) => o.usage || o.identifier)
        .map((o) => {
            const parent = byUri.get(o.parentUri);
            const line = /[#;]start=(\d+)/.exec(o.uri)?.[1];
            const u: Record<string, string> = {
                object: parent?.name || o.name,
                objectType: parent?.type || o.type,
                package: o.package || parent?.package || '',
                element: parent ? o.name : '',
                elementType: parent ? o.type : '',
                usage: o.usage,
            };
            if (line) u.line = line;
            u.uri = o.uri;
            return u;
        });
    const containers = objects.filter((o) => !o.usage && !o.identifier).length;
    return { usages, containers, total: objects.length };
}

export async function handleGetWhereUsed(args: any) {
    try {
        const uri = objectUri(args);
        const max = Math.min(Math.max(Number(args?.max_results) || 200, 1), 2000);
        const response = await makeAdtRequest(
            `${await getBaseUrl()}/sap/bc/adt/repository/informationsystem/usageReferences`,
            'POST',
            30000,
            BODY,
            { uri },
            { 'Content-Type': 'application/*', Accept: 'application/*' },
        );
        const { usages, containers } = parseUsageReferences(String(response.data));
        const self = String(args.object_name).toUpperCase();
        // the object's own components (e.g. method definitions of a class) are not "users"
        let filter = args?.include_self ? usages : usages.filter((u) => u.object.toUpperCase() !== self);
        if (args?.only_custom) filter = filter.filter((u) => /^[ZY]|^\/(?!SAP|1)/i.test(u.object));
        return return_text_response(
            jsonLines(
                { object: uri, usages: filter.length, containers, returned: Math.min(filter.length, max) },
                'results',
                filter.slice(0, max),
            ),
            args,
        );
    } catch (error) {
        return return_error(error);
    }
}
