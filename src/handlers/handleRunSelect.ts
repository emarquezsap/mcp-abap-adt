import { return_error, return_response, return_text_response } from '../lib/utils';
import {
    normalizeSelect,
    assertTablesAllowed,
    runFreestyle,
    compactOrRaw,
} from '../lib/sql';

export async function handleRunSelect(args: any) {
    try {
        const query = normalizeSelect(args?.query);
        assertTablesAllowed(query);
        const response = await runFreestyle(query, args.max_rows || 100);
        if (args.format === 'xml') return return_response(response, args);
        return return_text_response(compactOrRaw(response.data), args);
    } catch (error) {
        return return_error(error);
    }
}
