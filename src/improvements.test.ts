import fs from 'fs';
import os from 'os';
import path from 'path';
import * as utils from './lib/utils';
import {
  parseDataPreview,
  compactOrRaw,
  extractTables,
  isTableDenied,
  getTableDenylist,
  assertTablesAllowed,
  normalizeSelect,
  languageCondition,
} from './lib/sql';
import { handleGetTableContents } from './handlers/handleGetTableContents';
import { handleRunSelect } from './handlers/handleRunSelect';
import { buildDumpQuery, parseDumpFeed, summaryHeader, checkDumpId, handleListDumps } from './handlers/handleDumps';
import { parseUsageReferences, handleGetWhereUsed } from './handlers/handleWhereUsed';
import { parseVersionFeed } from './handlers/handleVersions';
import { parseWorklist } from './handlers/handleAtc';
import { checkTraceId } from './handlers/handleTraces';
import { objectUri, sourceUri, checkVersionUri } from './lib/objects';
import { unifiedDiff } from './lib/diff';
import { auditFile, sanitizeArgs, buildAuditEntry, writeAudit } from './lib/audit';

const PREVIEW = `<?xml version="1.0" encoding="utf-8"?><dataPreview:tableData xmlns:dataPreview="http://www.sap.com/adt/dataPreview"><dataPreview:totalRows>4</dataPreview:totalRows><dataPreview:isHanaAnalyticalView>false</dataPreview:isHanaAnalyticalView><dataPreview:executedQueryString>SELECT MANDT, MTEXT FROM T000   INTO     TABLE @DATA(LT_RESULT)   UP TO 2  ROWS   .</dataPreview:executedQueryString><dataPreview:queryExecutionTime>0.188</dataPreview:queryExecutionTime><dataPreview:columns><dataPreview:metadata dataPreview:name="MANDT" dataPreview:type="C" dataPreview:description="MANDT" dataPreview:keyAttribute="false"/><dataPreview:dataSet><dataPreview:data>000</dataPreview:data><dataPreview:data>050</dataPreview:data></dataPreview:dataSet></dataPreview:columns><dataPreview:columns><dataPreview:metadata dataPreview:name="MTEXT" dataPreview:type="C" dataPreview:description="Client name"/><dataPreview:dataSet><dataPreview:data>SAP AG &amp; Co</dataPreview:data><dataPreview:data></dataPreview:data></dataPreview:dataSet></dataPreview:columns></dataPreview:tableData>`;

function mockSap(data: string) {
  jest.spyOn(utils, 'getBaseUrl').mockResolvedValue('https://sap.example');
  return jest.spyOn(utils, 'makeAdtRequest').mockResolvedValue({ data } as any);
}

afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.SAP_TABLE_DENYLIST;
});

describe('1. compact table output', () => {
  it('parses the data preview into rows', () => {
    const r = parseDataPreview(PREVIEW);
    expect(r.totalRows).toBe(4);
    expect(r.returnedRows).toBe(2);
    expect(r.columns).toEqual([
      { name: 'MANDT', type: 'C' },
      { name: 'MTEXT', type: 'C', description: 'Client name' },
    ]);
    expect(r.rows).toEqual([
      { MANDT: '000', MTEXT: 'SAP AG & Co' },
      { MANDT: '050', MTEXT: '' },
    ]);
    expect(r.executedQuery).toBe('SELECT MANDT, MTEXT FROM T000 INTO TABLE @DATA(LT_RESULT) UP TO 2 ROWS .');
  });

  it('prints one row per line as valid JSON and keeps unknown bodies raw', () => {
    const out = compactOrRaw(PREVIEW);
    expect(JSON.parse(out).rows).toHaveLength(2);
    expect(out.split('\n').filter((l) => l.startsWith('{"MANDT"'))).toHaveLength(2);
    expect(compactOrRaw('<other/>')).toBe('<other/>');
  });

  it('GetTableContents returns JSON by default and XML on request', async () => {
    mockSap(PREVIEW);
    const json: any = await handleGetTableContents({ table_name: 'T000' });
    expect(JSON.parse(json.content[0].text).rows[0].MANDT).toBe('000');
    const xml: any = await handleGetTableContents({ table_name: 'T000', format: 'xml' });
    expect(xml.content[0].text).toBe(PREVIEW);
  });
});

describe('4. RunSelect validation', () => {
  it.each([
    'SELECT vbeln, COUNT(*) AS n FROM vbap GROUP BY vbeln',
    "SELECT a~bukrs, b~butxt FROM bkpf AS a INNER JOIN t001 AS b ON b~bukrs = a~bukrs WHERE a~gjahr = '2026'",
    "select * from t000 where mtext = 'A.B; C'.",
    "SELECT matnr FROM mara WHERE matnr IN ( SELECT matnr FROM marc WHERE werks = '1000' )",
  ])('accepts %p', (q) => {
    expect(() => normalizeSelect(q)).not.toThrow();
  });

  it('removes newlines and a trailing period', () => {
    expect(normalizeSelect("SELECT *\nFROM t000\nWHERE mandt = '100'.")).toBe("SELECT * FROM t000 WHERE mandt = '100'");
  });

  it.each([
    ['DELETE FROM ztab', 'Only SELECT'],
    ["SELECT * FROM t000. DELETE FROM ztab", 'single SELECT'],
    ['SELECT * FROM t000; SELECT * FROM t001', 'single SELECT'],
    ['SELECT * FROM t000 " comment', 'Comments'],
    ['* comment\nSELECT * FROM t000', 'comment lines'],
    ['SELECT * FROM t000 INTO TABLE @DATA(x)', 'INTO'],
    ['SELECT * FROM t000 UP TO 5 ROWS', 'UP TO'],
    ['', 'required'],
  ])('rejects %p', (q, msg) => {
    expect(() => normalizeSelect(q)).toThrow(msg);
  });

  it('sends the query and returns compact rows', async () => {
    const request = mockSap(PREVIEW);
    const result: any = await handleRunSelect({ query: 'SELECT mandt, mtext FROM t000', max_rows: 2 });
    expect(result.isError).toBe(false);
    expect(request.mock.calls[0][3]).toBe('SELECT mandt, mtext FROM t000');
    expect(request.mock.calls[0][4]).toEqual({ rowNumber: 2 });
  });
});

describe('7. table denylist', () => {
  it('finds every table after FROM / JOIN, ignoring literals', () => {
    expect(
      extractTables("SELECT * FROM bkpf AS a JOIN /abc/t1 AS b ON a~x = b~x WHERE y IN ( SELECT y FROM usr02 ) AND z = 'FROM rfcdes'"),
    ).toEqual(['BKPF', '/ABC/T1', 'USR02']);
  });

  it('blocks credential tables by default', () => {
    expect(isTableDenied('usr02')).toBe(true);
    expect(isTableDenied('RFCDES')).toBe(true);
    expect(isTableDenied('MARA')).toBe(false);
  });

  it('supports wildcards and the "-" switch', () => {
    process.env.SAP_TABLE_DENYLIST = 'PA0*, ZHR_SALARY';
    expect(getTableDenylist()).toEqual(['PA0*', 'ZHR_SALARY']);
    expect(isTableDenied('PA0008')).toBe(true);
    expect(isTableDenied('USR02')).toBe(false);
    process.env.SAP_TABLE_DENYLIST = '-';
    expect(getTableDenylist()).toEqual([]);
  });

  it('applies to GetTableContents, subqueries and RunSelect without calling SAP', async () => {
    const request = mockSap(PREVIEW);
    const a: any = await handleGetTableContents({ table_name: 'usr02' });
    const b: any = await handleGetTableContents({ table_name: 'usr01', where: 'BNAME IN ( SELECT BNAME FROM USR02 )' });
    const c: any = await handleRunSelect({ query: 'SELECT * FROM t000 CROSS JOIN rfcdes' });
    for (const r of [a, b, c]) {
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/denylist/);
    }
    expect(request).not.toHaveBeenCalled();
    expect(() => assertTablesAllowed('SELECT * FROM mara')).not.toThrow();
  });
});

describe('8. languages', () => {
  it('maps SAP keys and ISO codes', () => {
    expect(languageCondition('SPRSL', 's')).toBe("SPRSL = 'S'");
    expect(languageCondition('SPRSL', 'es')).toBe("SPRSL IN ( SELECT SPRAS FROM T002 WHERE LAISO = 'ES' )");
    expect(languageCondition('SPRSL', undefined)).toBe('');
    expect(() => languageCondition('SPRSL', "E' OR '1")).toThrow('language');
  });
});

describe('3. dumps', () => {
  const FEED = `<?xml version="1.0"?><atom:feed xmlns:atom="http://www.w3.org/2005/Atom"><atom:entry>
  <atom:author><atom:name>E_USER</atom:name></atom:author>
  <atom:category term="CONVT_NO_NUMBER" label="ABAP runtime error"/>
  <atom:category term="ZPROGRAM" label="Terminated ABAP program"/>
  <atom:id>x1</atom:id>
  <atom:link href="/sap/bc/adt/runtime/dump/20261015%20E_USER%2001" rel="self" type="text/plain"/>
  <atom:published>2026-10-15T10:00:00Z</atom:published>
  <atom:summary type="html">&lt;table&gt;&lt;tr&gt;&lt;td&gt;Short Text&lt;/td&gt;&lt;td&gt;Unable to interpret "A" as a number.&lt;/td&gt;&lt;/tr&gt;&lt;tr&gt;&lt;td&gt;Exception&lt;/td&gt;&lt;td&gt;CX_SY_CONVERSION_NO_NUMBER&lt;/td&gt;&lt;/tr&gt;&lt;/table&gt;&lt;h3&gt;What happened?&lt;/h3&gt;&lt;p&gt;Error in the ABAP application program.&lt;/p&gt;</atom:summary>
  <atom:title>Runtime error CONVT_NO_NUMBER</atom:title></atom:entry>
  <atom:entry><atom:author><atom:name>OTHER</atom:name></atom:author><atom:link href="/sap/bc/adt/runtime/dump/old" rel="self"/><atom:published>2026-09-01T10:00:00Z</atom:published><atom:title>old</atom:title></atom:entry></atom:feed>`;

  it('builds the feed query from filters', () => {
    expect(buildDumpQuery({})).toBeUndefined();
    expect(buildDumpQuery({ user: 'e_user', runtime_error: 'convt_no_number', program: 'zprog' })).toBe(
      'and ( equals ( user , E_USER ) , equals ( runtimeError , CONVT_NO_NUMBER ) , contains ( objectName , ZPROG ) )',
    );
    expect(() => buildDumpQuery({ user: 'X ) , or ( y' })).toThrow('Invalid user');
  });

  it('summarizes entries', () => {
    const [d] = parseDumpFeed(FEED, true);
    expect(d.id).toBe('20261015%20E_USER%2001');
    expect(d.user).toBe('E_USER');
    expect(d.categories).toEqual({ 'ABAP runtime error': 'CONVT_NO_NUMBER', 'Terminated ABAP program': 'ZPROGRAM' });
    expect(d.header).toEqual({ 'Short Text': 'Unable to interpret "A" as a number.', Exception: 'CX_SY_CONVERSION_NO_NUMBER' });
    expect(d.summary).toContain('What happened?');
    expect(summaryHeader('<p>no table</p>')).toEqual({});
  });

  it('filters by date, sends $query and limits results', async () => {
    const request = mockSap(FEED);
    const r: any = await handleListDumps({ user: 'E_USER', from_date: '2026-10-01', max_results: 5 });
    const body = JSON.parse(r.content[0].text);
    expect(body.matched).toBe(1);
    expect(body.dumps[0].id).toBe('20261015%20E_USER%2001');
    expect(request.mock.calls[0][4]).toEqual({ $query: 'and ( equals ( user , E_USER ) )' });
  });

  it('validates dump and trace ids', () => {
    expect(checkDumpId('/sap/bc/adt/runtime/dump/abc%20d')).toBe('abc%20d');
    expect(() => checkDumpId('../../x')).toThrow('dump_id');
    expect(() => checkDumpId('a?b=c')).toThrow('dump_id');
    expect(checkTraceId('/sap/bc/adt/runtime/traces/abaptraces/AB12')).toBe('AB12');
    expect(() => checkTraceId('x/../../y')).toThrow('trace_id');
  });
});

describe('5. where used', () => {
  const XML = `<?xml version="1.0" encoding="utf-8"?><usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core"><usageReferences:referencedObjects>
  <usageReferences:referencedObject uri="/sap/bc/adt/oo/classes/zcl_a" parentUri="/sap/bc/adt/packages/zpk" isResult="false"><usageReferences:adtObject adtcore:name="ZCL_A" adtcore:type="CLAS/OC" adtcore:responsible="DEV"><adtcore:packageRef adtcore:name="ZPK"/></usageReferences:adtObject></usageReferences:referencedObject>
  <usageReferences:referencedObject uri="/sap/bc/adt/oo/classes/zcl_a/source/main#type=CLAS%2FOM;name=RUN;start=12" parentUri="/sap/bc/adt/oo/classes/zcl_a" usageInformation="gradeDirect,includeProductive"><usageReferences:adtObject adtcore:name="RUN" adtcore:type="CLAS/OM"><adtcore:packageRef adtcore:name="ZPK"/></usageReferences:adtObject><objectIdentifier>ABAPFullName;X</objectIdentifier></usageReferences:referencedObject>
  <usageReferences:referencedObject uri="/sap/bc/adt/programs/programs/rstd" parentUri="/sap/bc/adt/packages/s" usageInformation="gradeDirect"><usageReferences:adtObject adtcore:name="RSTD" adtcore:type="PROG/P"/></usageReferences:referencedObject>
  </usageReferences:referencedObjects></usageReferences:usageReferenceResult>`;

  it('returns usages with their containing object', () => {
    const r = parseUsageReferences(XML);
    expect(r.containers).toBe(1);
    expect(r.usages[0]).toMatchObject({ object: 'ZCL_A', objectType: 'CLAS/OC', element: 'RUN', package: 'ZPK', line: '12' });
    expect(r.usages[1]).toMatchObject({ object: 'RSTD', element: '' });
  });

  it('posts the object uri and can keep only customer objects', async () => {
    const request = mockSap(XML);
    const r: any = await handleGetWhereUsed({ object_type: 'TABL', object_name: 'ZTAB', only_custom: true });
    expect(request.mock.calls[0][4]).toEqual({ uri: '/sap/bc/adt/ddic/tables/ztab' });
    expect(JSON.parse(r.content[0].text).results.map((u: any) => u.object)).toEqual(['ZCL_A']);
  });
});

describe('6. versions', () => {
  it('builds object and source uris', () => {
    expect(objectUri({ object_type: 'clas', object_name: '/abc/cl_x' })).toBe('/sap/bc/adt/oo/classes/%2fabc%2fcl_x');
    expect(sourceUri({ object_type: 'CLAS', object_name: 'ZCL', include: 'testclasses' })).toBe(
      '/sap/bc/adt/oo/classes/zcl/includes/testclasses',
    );
    expect(sourceUri({ object_type: 'FUNC', object_name: 'Z_FM', function_group: 'ZFG' })).toBe(
      '/sap/bc/adt/functions/groups/zfg/fmodules/z_fm/source/main',
    );
    expect(() => objectUri({ object_type: 'FUNC', object_name: 'Z_FM' })).toThrow('function_group');
    expect(() => objectUri({ object_type: 'PROG', object_name: 'Z X' })).toThrow('object_name');
    expect(() => sourceUri({ object_type: 'TABL', object_name: 'T000' })).toThrow('object_type');
  });

  it('parses the versions feed', () => {
    const xml = `<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xmlns:adtcore="http://www.sap.com/adt/core"><atom:entry><atom:author><atom:name>DEV1</atom:name></atom:author><atom:content src="/sap/bc/adt/programs/programs/z1/source/main/versions/20261001120000/00002/content" type="text/plain"/><atom:link href="/sap/bc/adt/cts/transportrequests/DEVK900123" adtcore:name="DEVK900123" type="application/vnd.sap.adt.transportrequests.v1+xml"/><atom:title>Fix</atom:title><atom:updated>2026-10-01T12:00:00Z</atom:updated></atom:entry></atom:feed>`;
    expect(parseVersionFeed(xml)).toEqual([
      {
        index: 0,
        date: '2026-10-01T12:00:00Z',
        author: 'DEV1',
        transport: 'DEVK900123',
        title: 'Fix',
        uri: '/sap/bc/adt/programs/programs/z1/source/main/versions/20261001120000/00002/content',
      },
    ]);
  });

  it('accepts only version content uris', () => {
    const ok = '/sap/bc/adt/programs/programs/z1/source/main/versions/20261001120000/00002/content';
    expect(checkVersionUri(ok)).toBe(ok);
    for (const bad of ['https://evil/x', '/sap/bc/adt/../public/info/versions/1/2/content', '/sap/bc/adt/programs/programs/z1']) {
      expect(() => checkVersionUri(bad)).toThrow('version_uri');
    }
  });

  it('produces a unified diff', () => {
    const r = unifiedDiff('a\nb\nc\nd\ne', 'a\nb\nX\nd\ne\nf', 'old', 'new', 1)!;
    expect(r.added).toBe(2);
    expect(r.removed).toBe(1);
    expect(r.diff).toBe(['--- old', '+++ new', '@@ -2,4 +2,5 @@', ' b', '-c', '+X', ' d', ' e', '+f'].join('\n'));
    expect(unifiedDiff('same', 'same', 'o', 'n')!.diff).toBe('');
  });
});

describe('10. ATC', () => {
  it('flattens findings sorted by priority', () => {
    const xml = `<atcworklist:worklist xmlns:atcworklist="http://www.sap.com/adt/atc/worklist" atcworklist:id="W1"><atcworklist:objects><atcobject:object xmlns:atcobject="http://www.sap.com/adt/atc/object" adtcore:name="ZR" adtcore:type="PROG" adtcore:packageName="ZPK" xmlns:adtcore="http://www.sap.com/adt/core"><atcobject:findings>
    <atcfinding:finding xmlns:atcfinding="http://www.sap.com/adt/atc/finding" atcfinding:priority="3" atcfinding:checkTitle="Naming" atcfinding:messageTitle="Bad name" atcfinding:location="/sap/bc/adt/programs/programs/zr/source/main#start=5,0"/>
    <atcfinding:finding xmlns:atcfinding="http://www.sap.com/adt/atc/finding" atcfinding:priority="1" atcfinding:checkTitle="Security" atcfinding:messageTitle="SQL injection" atcfinding:location="/sap/bc/adt/programs/programs/zr/source/main#start=20,4"/>
    </atcobject:findings></atcobject:object></atcworklist:objects></atcworklist:worklist>`;
    const r = parseWorklist(xml);
    expect(r.worklistId).toBe('W1');
    expect(r.findings.map((f) => [f.priority, f.check, f.line])).toEqual([
      [1, 'Security', 20],
      [3, 'Naming', 5],
    ]);
  });
});

describe('9. audit log', () => {
  it('hides sensitive keys and long values', () => {
    expect(sanitizeArgs({ password: 'x', where: 'a'.repeat(3000), table_name: 'T000' })).toEqual({
      password: '***',
      where: 'a'.repeat(2000) + '…',
      table_name: 'T000',
    });
  });

  it('records connection, tool and outcome without secrets', () => {
    const env = { SAP_URL: 'https://sap.example:44300', SAP_CLIENT: '100', SAP_USERNAME: 'RO_USER', SAP_PASSWORD: 'secret' } as any;
    const e = buildAuditEntry('RunSelect', { query: 'SELECT 1' }, { isError: true, content: [{ text: 'boom' }] }, 12, env);
    expect(e).toMatchObject({ host: 'sap.example:44300', client: '100', user: 'RO_USER', tool: 'RunSelect', ok: false, ms: 12, error: 'boom' });
    expect(JSON.stringify(e)).not.toContain('secret');
  });

  it('writes JSON lines to SAP_AUDIT_LOG and can be disabled', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'audit-')), 'a.jsonl');
    process.env.SAP_AUDIT_LOG = file;
    writeAudit('GetTable', { table_name: 'T000' }, { isError: false }, 1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8').trim())).toMatchObject({ tool: 'GetTable', ok: true });
    process.env.SAP_AUDIT_LOG = 'off';
    expect(auditFile()).toBeUndefined();
    delete process.env.SAP_AUDIT_LOG;
    expect(auditFile()).toMatch(/logs[\\/]audit\.jsonl$/);
  });
});
