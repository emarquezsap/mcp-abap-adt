import * as utils from '../lib/utils';
import { buildTableQuery, handleGetTableContents } from './handleGetTableContents';

describe('GetTableContents query building', () => {
  afterEach(() => jest.restoreAllMocks());

  it('keeps the original behaviour without filters', () => {
    expect(buildTableQuery({ table_name: 't000' })).toBe('SELECT * FROM T000');
  });

  it('builds fields, where and order by', () => {
    expect(
      buildTableQuery({
        table_name: 'bkpf',
        fields: ['bukrs', 'belnr', 'gjahr'],
        where: "BUKRS = '1000' AND GJAHR = '2026'",
        order_by: 'belnr descending',
      })
    ).toBe("SELECT BUKRS, BELNR, GJAHR FROM BKPF WHERE BUKRS = '1000' AND GJAHR = '2026' ORDER BY BELNR DESCENDING");
  });

  it('accepts comma separated fields as a string', () => {
    expect(buildTableQuery({ table_name: 'mara', fields: 'matnr, mtart' })).toBe('SELECT MATNR, MTART FROM MARA');
  });

  it.each([
    ["BUKRS = '1000'; DELETE FROM BKPF", 'single line'],
    ['BUKRS = "x"', 'single line'],
    ["BUKRS = '1000'\nOR 1 = 1", 'single line'],
    ["WHERE BUKRS = '1000'", 'without the WHERE keyword'],
  ])('rejects unsafe where %p', (where, msg) => {
    expect(() => buildTableQuery({ table_name: 'bkpf', where })).toThrow(msg);
  });

  it('rejects invalid field and order by names', () => {
    expect(() => buildTableQuery({ table_name: 'bkpf', fields: ['BUKRS; X'] })).toThrow('Invalid field name');
    expect(() => buildTableQuery({ table_name: 'bkpf', order_by: 'BELNR; DROP' })).toThrow('Invalid ORDER BY item');
  });

  it('sends the filtered query to the freestyle data preview', async () => {
    jest.spyOn(utils, 'getBaseUrl').mockResolvedValue('https://sap.example');
    const request = jest.spyOn(utils, 'makeAdtRequest').mockResolvedValue({ data: '<rows/>' } as any);
    const result: any = await handleGetTableContents({ table_name: 't001', where: "BUKRS = '1000'", max_rows: 5 });
    expect(result.isError).toBe(false);
    expect(request.mock.calls[0][0]).toBe('https://sap.example/sap/bc/adt/datapreview/freestyle');
    expect(request.mock.calls[0][3]).toBe("SELECT * FROM T001 WHERE BUKRS = '1000'");
    expect(request.mock.calls[0][4]).toEqual({ rowNumber: 5 });
  });
});
