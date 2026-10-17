import { McpError, ErrorCode, return_error, return_text_response } from '../lib/utils';
import { getConfig } from '../config';
import { selectRows, literal, languageCondition } from '../lib/sql';
import { checkName } from '../lib/objects';
import { jsonLines } from '../lib/xml';

function language(args: any): string | undefined {
    if (args?.language === '*') return undefined;
    if (args?.language) return String(args.language);
    try {
        return getConfig().language;
    } catch {
        return undefined;
    }
}

export async function handleGetMessageText(args: any) {
    try {
        const cls = checkName(args?.message_class, 'message_class');
        const where = [`ARBGB = ${literal(cls)}`];
        if (args?.message_number !== undefined && args.message_number !== '') {
            const nr = String(args.message_number).trim().padStart(3, '0');
            if (!/^\d{3}$/.test(nr)) throw new McpError(ErrorCode.InvalidParams, 'message_number must be 000-999');
            where.push(`MSGNR = ${literal(nr)}`);
        }
        const lang = languageCondition('SPRSL', language(args));
        if (lang) where.push(lang);
        const result = await selectRows(
            `SELECT SPRSL, ARBGB, MSGNR, TEXT FROM T100 WHERE ${where.join(' AND ')} ORDER BY MSGNR, SPRSL`,
            Number(args?.max_rows) || 1000,
        );
        const messages = result.rows.map((r) => ({ language: r.SPRSL, number: r.MSGNR, text: r.TEXT }));
        return return_text_response(
            jsonLines({ messageClass: cls, count: messages.length, hint: '&1..&4 / & are placeholders for MESSAGE ... WITH' }, 'messages', messages),
            args,
        );
    } catch (error) {
        return return_error(error);
    }
}

export async function handleGetDomainValues(args: any) {
    try {
        const domain = checkName(args?.domain_name, 'domain_name');
        const values = await selectRows(
            `SELECT VALPOS, DOMVALUE_L, DOMVALUE_H FROM DD07L WHERE DOMNAME = ${literal(domain)} AND AS4LOCAL = 'A' ORDER BY VALPOS`,
            5000,
        );
        const textWhere = [`DOMNAME = ${literal(domain)}`, `AS4LOCAL = 'A'`];
        const lang = languageCondition('DDLANGUAGE', language(args));
        if (lang) textWhere.push(lang);
        const texts = await selectRows(
            `SELECT VALPOS, DDLANGUAGE, DDTEXT FROM DD07T WHERE ${textWhere.join(' AND ')}`,
            10000,
        );
        const byPos = new Map<string, Record<string, string>>();
        for (const t of texts.rows) {
            const m = byPos.get(t.VALPOS) || {};
            m[t.DDLANGUAGE] = t.DDTEXT;
            byPos.set(t.VALPOS, m);
        }
        const list = values.rows.map((v) => {
            const item: Record<string, any> = { value: v.DOMVALUE_L };
            if (v.DOMVALUE_H) item.high = v.DOMVALUE_H;
            const t = byPos.get(v.VALPOS) || {};
            const langs = Object.keys(t);
            if (langs.length === 1) item.text = t[langs[0]];
            else if (langs.length > 1) item.texts = t;
            return item;
        });
        let valueTable = '';
        try {
            const d = await selectRows(`SELECT ENTITYTAB FROM DD01L WHERE DOMNAME = ${literal(domain)} AND AS4LOCAL = 'A'`, 1);
            valueTable = d.rows[0]?.ENTITYTAB || '';
        } catch {
            /* optional */
        }
        const header: Record<string, any> = { domain, fixedValues: list.length };
        if (valueTable) header.valueTable = valueTable;
        if (!list.length) header.note = valueTable ? `No fixed values; read the value table ${valueTable}` : 'No fixed values found';
        return return_text_response(jsonLines(header, 'values', list), args);
    } catch (error) {
        return return_error(error);
    }
}
