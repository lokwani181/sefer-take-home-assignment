import { describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '@app/shared';
import { ApiRequestError, UPLOAD_FIELD, createHttpClient, createMockClient, resolveApiMode, toApiError } from './client';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('resolveApiMode', () => {
  it('uses the mock for ?mock=1 / ?mock=true or VITE_API_MODE=mock', () => {
    expect(resolveApiMode('?mock=1', undefined)).toBe('mock');
    expect(resolveApiMode('?foo=2&mock=true', undefined)).toBe('mock');
    expect(resolveApiMode('', 'mock')).toBe('mock');
    expect(resolveApiMode('', undefined)).toBe('http');
    expect(resolveApiMode('?mock=0', 'http')).toBe('http');
  });
});

describe('createHttpClient', () => {
  it('posts files and broker inputs as multipart form data', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, { shipmentId: 's1' }));
    const client = createHttpClient('', fetchMock as unknown as typeof fetch);
    const files = [new File(['%PDF-1.4'], 'invoice.pdf', { type: 'application/pdf' }), new File(['x'], 'bl.png', { type: 'image/png' })];
    const result = await client.createShipment(files, { importerTaxId: '93-1234567' });

    expect(result).toEqual({ shipmentId: 's1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/shipments');
    expect(init?.method).toBe('POST');
    const body = init?.body as FormData;
    expect(body.getAll(UPLOAD_FIELD).map((f) => (f as File).name)).toEqual(['invoice.pdf', 'bl.png']);
    expect(JSON.parse(body.get('brokerInputs') as string)).toEqual({ importerTaxId: '93-1234567' });
  });

  it('posts regenerate requests as JSON with decisions inside brokerInputs', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(200, {} as PipelineResult));
    const client = createHttpClient('', fetchMock as unknown as typeof fetch);
    await client.regenerate('abc/1', { bondType: '08', decisions: { grossWeight: 'packing_list' } });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/shipments/abc%2F1/regenerate');
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
    expect(JSON.parse(init?.body as string)).toEqual({ brokerInputs: { bondType: '08', decisions: { grossWeight: 'packing_list' } } });
  });

  it('surfaces the ApiError body, including the hint', async () => {
    const body = { error: 'OCR unavailable', detail: 'tesseract not found on PATH', hint: 'brew install tesseract' };
    const client = createHttpClient('', (async () => json(503, body)) as unknown as typeof fetch);
    const err = await client.createShipment([new File(['x'], 'a.pdf')]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect((err as ApiRequestError).status).toBe(503);
    expect(toApiError(err)).toEqual(body);
  });

  it('wraps non-JSON errors and network failures', async () => {
    const htmlError = createHttpClient('', (async () => new Response('<html>Oops</html>', { status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch);
    expect(toApiError(await htmlError.health().catch((e: unknown) => e))).toMatchObject({
      error: 'Request failed (HTTP 500 Internal Server Error)',
      detail: '<html>Oops</html>',
    });

    const proxyDown = createHttpClient('', (async () => new Response('', { status: 502, statusText: 'Bad Gateway' })) as unknown as typeof fetch);
    const gateway = toApiError(await proxyDown.health().catch((e: unknown) => e));
    expect(gateway.error).toBe('Cannot reach the API server');
    expect(gateway.hint).toMatch(/port 3001/);

    const offline = createHttpClient('', (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch);
    const err = toApiError(await offline.health().catch((e: unknown) => e));
    expect(err.error).toBe('Cannot reach the server');
    expect(err.hint).toMatch(/mock=1/);
  });

  it('builds page image URLs', () => {
    expect(createHttpClient().pageImageUrl?.('s 1', 'doc', 2)).toBe('/api/shipments/s%201/documents/doc/pages/2/image');
  });
});

describe('createMockClient', () => {
  it('returns the sample result and applies regenerate inputs', async () => {
    const client = createMockClient({ delayMs: 0, regenerateDelayMs: 0 });
    expect((await client.health()).ok).toBe(true);
    const result = await client.createShipment([new File(['x'], 'a.pdf')]);
    expect(result.entryModel.invoices[0].lineItems).toHaveLength(5);
    const next = await client.regenerate(result.shipmentId, { importerTaxId: '93-1234567' });
    expect(next.issues.some((i) => i.code === 'MISSING_IMPORTER_ID')).toBe(false);
    await expect(client.createShipment([])).rejects.toBeInstanceOf(ApiRequestError);
  });
});
