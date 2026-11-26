import { getConfig } from '../config';
import * as utilsModule from './utils';
import { rfcErrorMessage } from './rfc';
import { handleGetProgram } from '../handlers/handleGetProgram';

const calls: any[] = [];
let alive = true;
let nextResponse: any;

jest.mock(
  'node-rfc',
  () => ({
    Client: jest.fn().mockImplementation((params: any) => ({
      params,
      get alive() {
        return alive;
      },
      open: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      call: jest.fn(async (fm: string, args: any, opts: any) => {
        calls.push({ fm, args, opts, params });
        return { RESPONSE: nextResponse };
      }),
    })),
  }),
  { virtual: true },
);

const ENV = { ...process.env };
function rfcEnv(extra: Record<string, string> = {}) {
  process.env = {
    ...ENV,
    SAP_CONNECTION: 'rfc',
    SAP_ROUTER: '/H/router.example.com/S/3299',
    SAP_ASHOST: '10.0.0.5',
    SAP_SYSNR: '00',
    SAP_CLIENT: '100',
    SAP_USERNAME: 'RO_USER',
    SAP_PASSWORD: 'S3cret!',
    SAP_LANGUAGE: 'es',
    ...extra,
  };
}

afterEach(async () => {
  utilsModule.cleanup();
  process.env = { ...ENV };
  calls.length = 0;
  alive = true;
});

describe('RFC configuration', () => {
  it('builds node-rfc parameters without SAP_URL', () => {
    rfcEnv({ SAP_RFC_SNC_MODE: '1' });
    const c = getConfig();
    expect(c.connection).toBe('rfc');
    expect(c.rfc).toEqual({
      user: 'RO_USER',
      client: '100',
      ashost: '10.0.0.5',
      sysnr: '00',
      saprouter: '/H/router.example.com/S/3299',
      snc_mode: '1',
      lang: 'ES',
    });
    expect(JSON.stringify(c.rfc)).not.toContain('S3cret');
  });

  it('supports message server logon and validates input', () => {
    rfcEnv({ SAP_ASHOST: '', SAP_MSHOST: 'ms.example.com', SAP_SYSID: 'OEQ', SAP_GROUP: 'PUBLIC' });
    expect(getConfig().rfc).toMatchObject({ mshost: 'ms.example.com', sysid: 'OEQ', group: 'PUBLIC' });
    rfcEnv({ SAP_SYSNR: '0' });
    expect(() => getConfig()).toThrow('SAP_SYSNR');
    rfcEnv({ SAP_ROUTER: 'router.example.com' });
    expect(() => getConfig()).toThrow('SAP_ROUTER');
    rfcEnv({ SAP_ASHOST: '' });
    expect(() => getConfig()).toThrow('SAP_ASHOST');
  });
});

describe('ADT over RFC', () => {
  it('wraps the ADT request into SADT_REST_RFC_ENDPOINT', async () => {
    rfcEnv();
    nextResponse = {
      STATUS_LINE: { STATUS_CODE: '200', REASON_PHRASE: 'OK' },
      HEADER_FIELDS: [{ NAME: 'Content-Type', VALUE: 'application/xml' }],
      MESSAGE_BODY: Buffer.from('<ok/>'),
    };
    const utils = utilsModule;
    const base = await utils.getBaseUrl();
    const r: any = await utils.makeAdtRequest(
      `${base}/sap/bc/adt/datapreview/freestyle`,
      'POST',
      30000,
      'SELECT * FROM T000',
      { rowNumber: 5 },
      { 'Content-Type': 'text/plain', Accept: 'application/xml, */*' },
    );
    expect(r.status).toBe(200);
    expect(r.data).toBe('<ok/>');
    expect(r.headers['content-type']).toBe('application/xml');
    const { fm, args, params } = calls[0];
    expect(fm).toBe('SADT_REST_RFC_ENDPOINT');
    expect(args.REQUEST.REQUEST_LINE).toEqual({
      METHOD: 'POST',
      URI: '/sap/bc/adt/datapreview/freestyle?rowNumber=5',
      VERSION: 'HTTP/1.1',
    });
    expect(args.REQUEST.HEADER_FIELDS).toEqual([
      { NAME: 'Content-Type', VALUE: 'text/plain' },
      { NAME: 'Accept', VALUE: 'application/xml, */*' },
    ]);
    expect(args.REQUEST.MESSAGE_BODY.toString()).toBe('SELECT * FROM T000');
    expect(params.passwd).toBe('S3cret!');
    expect(calls).toHaveLength(1); // no CSRF round trip over RFC
  });

  it('adds the default Accept header like axios does over HTTP', async () => {
    rfcEnv();
    nextResponse = { STATUS_LINE: { STATUS_CODE: '200' }, HEADER_FIELDS: [], MESSAGE_BODY: Buffer.from('REPORT x.') };
    const base = await utilsModule.getBaseUrl();
    await utilsModule.makeAdtRequest(`${base}/sap/bc/adt/programs/programs/x/source/main`, 'GET', 30000);
    expect(calls[0].args.REQUEST.HEADER_FIELDS).toEqual([
      { NAME: 'Accept', VALUE: 'application/json, text/plain, */*' },
    ]);
  });

  it('turns ADT error status into the usual readable error', async () => {
    rfcEnv();
    nextResponse = {
      STATUS_LINE: { STATUS_CODE: '404', REASON_PHRASE: 'Not Found' },
      HEADER_FIELDS: [],
      MESSAGE_BODY: Buffer.from(
        '<?xml version="1.0"?><exc:exception xmlns:exc="x"><localizedMessage lang="ES">Programa ZX no existe</localizedMessage></exc:exception>',
      ),
    };
    const r: any = await handleGetProgram({ program_name: 'ZX' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('HTTP 404');
    expect(r.content[0].text).toContain('Programa ZX no existe');
  });

  it('reports router errors without the password', async () => {
    rfcEnv();
    const msg = rfcErrorMessage(
      { message: 'route permission denied (x to 10.0.0.5, 3300) S3cret!', key: 'RFC_COMMUNICATION_FAILURE' },
      'S3cret!',
    );
    expect(msg).toBe(
      'SAP RFC connection failed: RFC_COMMUNICATION_FAILURE: route permission denied (x to 10.0.0.5, 3300) ***',
    );
  });
});
