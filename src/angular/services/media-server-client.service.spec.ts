/**
 * @fileoverview Tests for MediaServerClient.
 *
 * The session token is what stops any web page the user visits from driving
 * the local media server, so where it is attached — and that it is never
 * attached to a URL when a header will do — is what these pin.
 *
 * @module app/services/media-server-client.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {MediaServerClient} from './media-server-client.service';

// ============================================================================
// Helpers
// ============================================================================

type FetchStub = ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

const TOKEN: string = 'session token/with+specials';
const SERVER: string = 'http://127.0.0.1:4321';

/** Builds a JSON response as the media server would send it. */
function jsonResponse(body: unknown, status: number = 200, statusText: string = 'OK'): Response {
  return new Response(JSON.stringify(body), {status, statusText, headers: {'Content-Type': 'application/json'}});
}

/** Replaces the global fetch with a fake that answers with the given response. */
function stubFetch(respond: () => Response): FetchStub {
  const fetchStub: FetchStub = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
    .mockImplementation(async (): Promise<Response> => respond());
  vi.stubGlobal('fetch', fetchStub);
  return fetchStub;
}

/** Reads the options of the only request the fetch fake received. */
function onlyRequest(fetchStub: FetchStub): {url: string; init: RequestInit} {
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [url, init]: [url: string, init?: RequestInit] = fetchStub.mock.calls[0];
  return {url, init: init ?? {}};
}

// ============================================================================
// Tests
// ============================================================================

describe('MediaServerClient', (): void => {
  let client: MediaServerClient;

  beforeEach((): void => {
    TestBed.configureTestingModule({});
    client = TestBed.inject(MediaServerClient);
  });

  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  describe('before it is configured', (): void => {
    it('has no server URL', (): void => {
      expect(client.serverUrl()).toBe('');
    });

    it('leaves a URL untouched rather than appending an empty token', (): void => {
      expect(client.appendAuth(`${SERVER}/events`)).toBe(`${SERVER}/events`);
    });
  });

  describe('configure', (): void => {
    it('publishes the loopback URL for the port', (): void => {
      client.configure(4321, TOKEN);

      expect(client.serverUrl()).toBe(SERVER);
    });
  });

  describe('appendAuth', (): void => {
    beforeEach((): void => {
      client.configure(4321, TOKEN);
    });

    it('adds the encoded token as the first query parameter', (): void => {
      expect(client.appendAuth(`${SERVER}/events`)).toBe(`${SERVER}/events?token=session%20token%2Fwith%2Bspecials`);
    });

    it('adds the token after existing query parameters', (): void => {
      expect(client.appendAuth(`${SERVER}/media/stream?path=a`)).toBe(`${SERVER}/media/stream?path=a&token=session%20token%2Fwith%2Bspecials`);
    });
  });

  describe('authFetch', (): void => {
    beforeEach((): void => {
      client.configure(4321, TOKEN);
    });

    it('sends the token in a header and keeps it out of the URL', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({}));

      await client.authFetch(`${SERVER}/player/state`);

      const {url, init}: {url: string; init: RequestInit} = onlyRequest(fetchStub);
      expect(url).toBe(`${SERVER}/player/state`);
      expect(init.headers).toEqual({'X-Onix-Token': TOKEN});
    });

    it('keeps the caller\'s options and headers', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({}));

      await client.authFetch(`${SERVER}/settings`, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: '{}'});

      const {init}: {init: RequestInit} = onlyRequest(fetchStub);
      expect(init.method).toBe('PUT');
      expect(init.body).toBe('{}');
      expect(init.headers).toEqual({'Content-Type': 'application/json', 'X-Onix-Token': TOKEN});
    });

    it('does not let a caller substitute its own token', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({}));

      await client.authFetch(`${SERVER}/settings`, {headers: {'X-Onix-Token': 'forged'}});

      expect(onlyRequest(fetchStub).init.headers).toEqual({'X-Onix-Token': TOKEN});
    });
  });

  describe('get', (): void => {
    beforeEach((): void => {
      client.configure(4321, TOKEN);
    });

    it('requests the endpoint on the server and returns the parsed body', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({state: 'idle'}));

      const result: {state: string} = await client.get<{state: string}>('/player/state');

      expect(result).toEqual({state: 'idle'});
      expect(onlyRequest(fetchStub).url).toBe(`${SERVER}/player/state`);
    });

    it('rejects with the status when the server refuses', async (): Promise<void> => {
      stubFetch((): Response => jsonResponse({error: 'nope'}, 404, 'Not Found'));

      await expect(client.get('/missing')).rejects.toThrow('HTTP 404: Not Found');
    });
  });

  describe('post', (): void => {
    beforeEach((): void => {
      client.configure(4321, TOKEN);
    });

    it('sends the body as JSON', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({success: true}));

      await client.post('/player/seek', {time: 12});

      const {url, init}: {url: string; init: RequestInit} = onlyRequest(fetchStub);
      expect(url).toBe(`${SERVER}/player/seek`);
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{"time":12}');
      expect(init.headers).toEqual({'Content-Type': 'application/json', 'X-Onix-Token': TOKEN});
    });

    it('sends no body when none is given', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({}));

      await client.post('/player/play');

      expect(onlyRequest(fetchStub).init.body).toBeUndefined();
    });

    it('rejects with the status when the server refuses', async (): Promise<void> => {
      stubFetch((): Response => jsonResponse({}, 500, 'Internal Server Error'));

      await expect(client.post('/player/play')).rejects.toThrow('HTTP 500: Internal Server Error');
    });
  });

  describe('delete', (): void => {
    beforeEach((): void => {
      client.configure(4321, TOKEN);
    });

    it('issues a DELETE and returns the parsed body', async (): Promise<void> => {
      const fetchStub: FetchStub = stubFetch((): Response => jsonResponse({success: true}));

      const result: {success: boolean} = await client.delete<{success: boolean}>('/playlist/clear');

      expect(result).toEqual({success: true});
      expect(onlyRequest(fetchStub).init.method).toBe('DELETE');
    });

    it('rejects with the status when the server refuses', async (): Promise<void> => {
      stubFetch((): Response => jsonResponse({}, 404, 'Not Found'));

      await expect(client.delete('/playlist/remove/x')).rejects.toThrow('HTTP 404: Not Found');
    });
  });

  describe('postExpectingMessage', (): void => {
    beforeEach((): void => {
      client.configure(4321, TOKEN);
    });

    it('returns the parsed body on success', async (): Promise<void> => {
      stubFetch((): Response => jsonResponse({jobId: 'j1'}));

      await expect(client.postExpectingMessage<{jobId: string}>('/media/url/download', {url: 'u'})).resolves.toEqual({jobId: 'j1'});
    });

    it('rejects with the server\'s own explanation', async (): Promise<void> => {
      stubFetch((): Response => jsonResponse({error: 'Unsupported URL'}, 400, 'Bad Request'));

      await expect(client.postExpectingMessage('/media/url/info', {url: 'u'})).rejects.toThrow('Unsupported URL');
    });

    it('falls back to the status code when the failure carries no explanation', async (): Promise<void> => {
      stubFetch((): Response => new Response('<html>bad gateway</html>', {status: 502, statusText: 'Bad Gateway'}));

      await expect(client.postExpectingMessage('/media/url/info', {url: 'u'})).rejects.toThrow('HTTP 502');
    });
  });
});
