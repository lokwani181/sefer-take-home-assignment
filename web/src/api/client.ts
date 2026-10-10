import type { ApiError, BrokerInputs, HealthResponse, PipelineResult } from '@app/shared';

/** Response of GET /api/health (tool name → version, plus the required tools that are missing). */
export type HealthStatus = HealthResponse;

export type ApiMode = 'http' | 'mock';

/** Everything the UI needs from the backend. Both the real HTTP adapter and the demo mock implement it. */
export interface ApiClient {
  readonly mode: ApiMode;
  health(): Promise<HealthStatus>;
  createShipment(files: File[], brokerInputs?: BrokerInputs): Promise<PipelineResult>;
  regenerate(shipmentId: string, brokerInputs: BrokerInputs): Promise<PipelineResult>;
  /** URL of a rendered OCR page image, when the backend serves them. */
  pageImageUrl?(shipmentId: string, docId: string, page: number): string;
}

/** Multipart field name for uploaded documents (multer `upload.array('files')`). */
export const UPLOAD_FIELD = 'files';
export const MAX_FILES = 10;

/**
 * Error thrown by every client method. Carries the server's ApiError body so the UI can show
 * `error`, `detail` and, most importantly, `hint` (e.g. "brew install tesseract").
 */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError;

  constructor(status: number, body: ApiError) {
    super(body.error);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

/** Normalizes anything thrown by a client call into an ApiError for display. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiRequestError) return err.body;
  if (err instanceof Error) return { error: 'Unexpected error', detail: err.message };
  return { error: 'Unexpected error', detail: String(err) };
}

function isApiError(value: unknown): value is ApiError {
  return typeof value === 'object' && value !== null && typeof (value as ApiError).error === 'string';
}

const UNREACHABLE_HINT =
  'Start the API server (npm run dev from the repo root, port 3001), or open the app with ?mock=1 to explore sample data.';

const GATEWAY_STATUSES = new Set([502, 503, 504]);

async function readError(res: Response): Promise<ApiRequestError> {
  const text = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  if (isApiError(parsed)) return new ApiRequestError(res.status, parsed);
  if (GATEWAY_STATUSES.has(res.status)) {
    // The dev proxy (or a load balancer) answered because the API process is not running.
    return new ApiRequestError(res.status, {
      error: 'Cannot reach the API server',
      detail: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''} from the proxy`,
      hint: UNREACHABLE_HINT,
    });
  }
  return new ApiRequestError(res.status, {
    error: `Request failed (HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''})`,
    detail: text ? text.slice(0, 400) : undefined,
  });
}

/**
 * fetch adapter for the Express API. Network failures and non-2xx responses become
 * ApiRequestError so callers only handle one error type.
 */
export function createHttpClient(baseUrl = '', fetchImpl: typeof fetch = (...args) => fetch(...args)): ApiClient {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, init);
    } catch (err) {
      throw new ApiRequestError(0, {
        error: 'Cannot reach the server',
        detail: err instanceof Error ? err.message : String(err),
        hint: UNREACHABLE_HINT,
      });
    }
    if (!res.ok) throw await readError(res);
    try {
      return (await res.json()) as T;
    } catch {
      throw new ApiRequestError(res.status, {
        error: 'The server returned an unreadable response',
        hint: 'Check that /api is proxied to the API server and not served by another app.',
      });
    }
  }

  return {
    mode: 'http',
    health: () => request<HealthStatus>('/api/health'),
    createShipment(files, brokerInputs) {
      const form = new FormData();
      for (const file of files) form.append(UPLOAD_FIELD, file, file.name);
      if (brokerInputs) form.append('brokerInputs', JSON.stringify(brokerInputs));
      return request<PipelineResult>('/api/shipments', { method: 'POST', body: form });
    },
    regenerate(shipmentId, brokerInputs) {
      return request<PipelineResult>(`/api/shipments/${encodeURIComponent(shipmentId)}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brokerInputs }),
      });
    },
    pageImageUrl(shipmentId, docId, page) {
      return `${baseUrl}/api/shipments/${encodeURIComponent(shipmentId)}/documents/${encodeURIComponent(docId)}/pages/${page}/image`;
    },
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Offline demo adapter: returns the hand-built sample result after a short delay and applies a
 * few decision / broker-input effects on regenerate, so the whole UI flow works without a server.
 * The sample data is loaded lazily so it stays out of the main bundle.
 */
export function createMockClient(options: { delayMs?: number; regenerateDelayMs?: number } = {}): ApiClient {
  const delayMs = options.delayMs ?? 1500;
  const regenerateDelayMs = options.regenerateDelayMs ?? 500;
  const load = async () => {
    const [{ mockResult }, { applyMockInputs }] = await Promise.all([import('./mock-result'), import('./mock-effects')]);
    return { mockResult, applyMockInputs };
  };

  return {
    mode: 'mock',
    async health() {
      return {
        ok: true,
        tools: { tesseract: '5.5.1 (mock)', pdftotext: '25.x (mock)', pdftoppm: '25.x (mock)', xmllint: 'xmllint-wasm (mock)' },
        missing: [],
      };
    },
    async createShipment(files, brokerInputs) {
      if (files.length === 0) {
        throw new ApiRequestError(400, { error: 'No files uploaded', hint: 'Add at least one PDF or image.' });
      }
      const { mockResult, applyMockInputs } = await load();
      await sleep(delayMs);
      return applyMockInputs(mockResult, brokerInputs ?? mockResult.brokerInputs);
    },
    async regenerate(_shipmentId, brokerInputs) {
      const { mockResult, applyMockInputs } = await load();
      await sleep(regenerateDelayMs);
      return applyMockInputs(mockResult, brokerInputs);
    },
  };
}

/** Mock when the URL has ?mock=1 (or ?mock=true) or VITE_API_MODE=mock; otherwise the real API. */
export function resolveApiMode(search: string, envMode: string | undefined): ApiMode {
  const flag = new URLSearchParams(search).get('mock');
  if (flag === '1' || flag === 'true') return 'mock';
  return envMode === 'mock' ? 'mock' : 'http';
}

/** The client the app uses by default, chosen from the URL and build-time env. */
export function createDefaultClient(): ApiClient {
  const search = typeof window === 'undefined' ? '' : window.location.search;
  return resolveApiMode(search, import.meta.env.VITE_API_MODE) === 'mock' ? createMockClient() : createHttpClient();
}
