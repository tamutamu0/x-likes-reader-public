import type { components } from './generated';
type Schemas = components['schemas'];

export class APIError extends Error {
  constructor(public readonly status: number, public readonly problem: Schemas['Error']['error'] | null, public readonly item?: Schemas['Item']) {
    super(problem?.message ?? 'API request failed');
  }
}
// Browser-compatible client. Hosting must serve UI and API on the same origin;
// no permissive CORS and no persistent tokens in localStorage are required.
export class ReaderClient {
  private readonly url: URL;
  constructor(baseURL: string, private readonly options: {
    localDevelopment?: boolean;
    token?: () => string | undefined;
    fetch?: typeof fetch;
  } = {}) {
    this.url = new URL(baseURL);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname);
    if (this.url.username || this.url.password || this.url.search || this.url.hash || !['', '/'].includes(this.url.pathname) ||
      (this.url.protocol !== 'https:' && !(options.localDevelopment && local && this.url.protocol === 'http:')) ||
      (options.localDevelopment && !local)) throw new Error('Invalid API origin');
  }
  private async request<T>(path: string, body?: Schemas['PatchRequest']): Promise<T> {
    const headers = new Headers({ Accept: 'application/json' });
    if (this.options.localDevelopment) headers.set('X-Margin-Request', '1');
    const token = this.options.token?.();
    if (token) headers.set('Authorization', 'Bearer ' + token);
    if (body) headers.set('Content-Type', 'application/json');
    const init: RequestInit & { credentials: 'same-origin'; cache: 'no-store' } = {
      method: body ? 'PATCH' : 'GET', headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
    };
    const response = await (this.options.fetch ?? fetch)(new URL(path, this.url), init);
    const data = await response.json() as T & Partial<Schemas['Conflict']>;
    if (!response.ok) throw new APIError(response.status, data.error ?? null, data.item);
    return data;
  }
  items(cursor?: string, limit = 50): Promise<Schemas['ItemPage']> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return this.request('v1/items?' + params);
  }
  item(id: string): Promise<Schemas['Item']> { this.validate(id); return this.request('v1/items/' + id); }
  patch(id: string, expectedRevision: number, changes: Schemas['UserPatch']): Promise<Schemas['Item']> {
    this.validate(id); return this.request('v1/items/' + id, { expectedRevision, changes });
  }
  changes(after = 0, limit = 50): Promise<Schemas['ChangePage']> {
    return this.request('v1/changes?' + new URLSearchParams({ after: String(after), limit: String(limit) }));
  }
  private validate(id: string) { if (!/^x:[0-9]{1,25}$/.test(id)) throw new Error('Invalid item ID'); }
}
