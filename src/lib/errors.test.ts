import { AxiosError } from 'axios';
import { extractAdtErrorMessage, return_error } from './utils';

const adtException = (msg: string) => `<?xml version="1.0" encoding="utf-8"?>
<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">
  <namespace id="com.sap.adt"/>
  <type id="ExceptionDataPreview"/>
  <message lang="EN">${msg}</message>
  <localizedMessage lang="ES">${msg}</localizedMessage>
</exc:exception>`;

function errorWith(status: number, data: unknown) {
  return new AxiosError('x', 'ERR_BAD_RESPONSE', undefined, undefined, { status, data } as any);
}

describe('ADT error messages', () => {
  it('extracts the ADT exception message and type', () => {
    expect(extractAdtErrorMessage(adtException('Unknown column name &quot;DATE_TO&quot;'))).toBe(
      'Unknown column name "DATE_TO" [ExceptionDataPreview]'
    );
  });

  it('surfaces the SAP message and a hint in the tool error', () => {
    const text = return_error(errorWith(400, adtException('Unknown column name DATE_TO'))).content[0].text;
    expect(text).toContain('HTTP 400');
    expect(text).toContain('Unknown column name DATE_TO');
    expect(text).toContain('check names, syntax');
  });

  it('never returns non-ADT bodies such as login pages', () => {
    const text = return_error(errorWith(401, '<html><body>secret-login-page</body></html>')).content[0].text;
    expect(text).not.toContain('secret-login-page');
    expect(text).toContain('authentication failed');
  });

  it('handles buffers and caps the length', () => {
    const long = 'A'.repeat(2000);
    const msg = extractAdtErrorMessage(Buffer.from(adtException(long)))!;
    expect(msg.length).toBeLessThan(600);
  });
});
