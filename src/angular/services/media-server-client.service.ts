/**
 * @fileoverview Authenticated HTTP transport to the local media server.
 *
 * Owns where the server is and how to prove to it who is asking: the base
 * URL, the session token, and the fetch helpers that attach the token. It
 * knows nothing about what the endpoints mean — that is {@link PlayerApi}'s
 * business — so the authentication rules live in exactly one place.
 *
 * @module app/services/media-server-client.service
 */

import {Injectable, signal} from '@angular/core';

/**
 * The connection to the media server: its address, its session token, and
 * requests that carry the token.
 */
@Injectable({providedIn: 'root'})
export class MediaServerClient {
  /** Base URL of the media server (e.g., "http://127.0.0.1:54545") */
  public readonly serverUrl: ReturnType<typeof signal<string>> = signal<string>('');

  /**
   * Session token the media server requires on every API request, obtained
   * over IPC at startup.
   *
   * Always populated before {@link serverUrl}, so anything reacting to the
   * server URL becoming available already has a usable token.
   */
  private readonly serverToken: ReturnType<typeof signal<string>> = signal<string>('');

  /**
   * Records where the server is listening and the token it expects.
   *
   * The token is published first so that consumers reacting to serverUrl can
   * immediately build authorized URLs.
   *
   * @param port - Port the media server is listening on
   * @param token - Session token minted by the server
   */
  public configure(port: number, token: string): void {
    this.serverToken.set(token);
    this.serverUrl.set(`http://127.0.0.1:${port}`);
  }

  /**
   * Appends the session token to a media server URL as a query parameter.
   *
   * Use this for URLs consumed by things that cannot send headers — media
   * element `src` attributes and `EventSource`. Prefer {@link authFetch} for
   * anything issued via `fetch`.
   *
   * @param url - A fully-qualified media server URL
   * @returns The URL carrying the session token
   */
  public appendAuth(url: string): string {
    const token: string = this.serverToken();
    if (!token) return url;

    const separator: string = url.includes('?') ? '&' : '?';
    return `${url}${separator}token=${encodeURIComponent(token)}`;
  }

  /**
   * Issues a fetch against the media server with the session token attached.
   *
   * A drop-in replacement for `fetch` at any call site targeting the local
   * server; the token travels in a header rather than the URL.
   *
   * @param url - A fully-qualified media server URL
   * @param init - Standard fetch options
   * @returns The fetch response
   */
  public authFetch(url: string, init?: Readonly<RequestInit>): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        ...(init?.headers as Record<string, string> | undefined),
        'X-Onix-Token': this.serverToken(),
      },
    });
  }

  /**
   * Makes a GET request to the media server.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path (e.g., '/player/state')
   * @returns Promise resolving to the parsed JSON response
   * @throws Error if the request fails
   */
  public async get<T>(endpoint: string): Promise<T> {
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Makes a POST request to the media server.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path
   * @param body - Optional request body (will be JSON stringified)
   * @returns Promise resolving to the parsed JSON response
   * @throws Error if the request fails
   */
  public async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * Makes a DELETE request to the media server.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path
   * @returns Promise resolving to the parsed JSON response
   * @throws Error if the request fails
   */
  public async delete<T>(endpoint: string): Promise<T> {
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response.json();
  }

  /**
   * POSTs JSON and, on a non-2xx response, throws an Error carrying the server's
   * `{ error }` message (yt-dlp failures are surfaced this way). Unlike the
   * generic {@link post} helper, this preserves the human-readable reason.
   *
   * @typeParam T - Expected response type
   * @param endpoint - API endpoint path
   * @param body - Request body (will be JSON stringified)
   * @returns Promise resolving to the parsed JSON response
   * @throws Error with the server's message if the request fails
   */
  public async postExpectingMessage<T>(endpoint: string, body: unknown): Promise<T> {
    const response: Response = await this.authFetch(`${this.serverUrl()}${endpoint}`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const data: unknown = await response.json().catch((): null => null);
    if (!response.ok) {
      const message: string = (data as {error?: string} | null)?.error ?? `HTTP ${response.status}`;
      throw new Error(message);
    }
    return data as T;
  }
}
