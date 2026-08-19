/**
 * @fileoverview Server-Sent Events connection with automatic reconnection.
 *
 * Owns the transport concerns only — opening the connection, registering
 * listeners, backing off and retrying when it drops, and shutting down
 * cleanly. What the events *mean* is the caller's business: handlers receive
 * the raw payload string and decide how to parse and apply it.
 *
 * That split is the point. The reconnect schedule is the kind of logic that
 * is easy to get subtly wrong and impossible to exercise while it is tangled
 * up with two hundred lines of signal updates.
 *
 * @module app/services/sse-client.service
 */

import {Injectable} from '@angular/core';

/** Longest gap between reconnection attempts. */
const MAX_RECONNECT_DELAY_MS: number = 30000;

/** Gap before the first reconnection attempt; doubles from here. */
const BASE_RECONNECT_DELAY_MS: number = 1000;

/** Handlers keyed by SSE event name, receiving the raw payload. */
export type SseHandlers = Readonly<Record<string, (data: string) => void>>;

/**
 * A reconnecting Server-Sent Events connection.
 */
@Injectable({providedIn: 'root'})
export class SseClient {
  /** The live connection, or null when disconnected. */
  private eventSource: EventSource | null = null;

  /** Consecutive failed attempts, driving the backoff. */
  private reconnectAttempts: number = 0;

  /** Pending reconnection timer. */
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** The URL to (re)connect to, retained across retries. */
  private url: string | null = null;

  /** The handlers to reattach on every reconnection. */
  private handlers: SseHandlers = {};

  /**
   * Opens a connection and attaches handlers, replacing any existing one.
   *
   * Handlers are reattached automatically on each reconnection, so callers
   * register once.
   *
   * @param url - The fully-formed events URL, including any auth token
   * @param handlers - Handlers keyed by event name
   */
  public connect(url: string, handlers: SseHandlers): void {
    this.disconnect();
    this.url = url;
    this.handlers = handlers;
    this.open();
  }

  /**
   * Closes the connection and cancels any pending reconnection.
   *
   * Safe to call when not connected.
   */
  public disconnect(): void {
    if (this.reconnectTimeoutId !== null) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
  }

  /** Whether a connection is currently open. */
  public isConnected(): boolean {
    return this.eventSource !== null;
  }

  /**
   * The delay before the nth reconnection attempt.
   *
   * Doubles per attempt and then holds, so a server that stays down is
   * retried steadily rather than never.
   *
   * @param attempt - Count of consecutive failures so far
   * @returns Delay in milliseconds
   */
  public static backoffDelay(attempt: number): number {
    return Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt), MAX_RECONNECT_DELAY_MS);
  }

  /** Opens the connection and wires up its listeners. */
  private open(): void {
    if (!this.url) return;

    this.eventSource = new EventSource(this.url);

    this.eventSource.onopen = (): void => {
      console.log('SSE connection established');
      this.reconnectAttempts = 0;
    };

    this.eventSource.onerror = (): void => {
      console.error('SSE connection error');
      this.eventSource?.close();
      this.eventSource = null;
      this.scheduleReconnect();
    };

    for (const [event, handler] of Object.entries(this.handlers)) {
      this.eventSource.addEventListener(event, (e: MessageEvent): void => {
        handler(e.data as string);
      });
    }
  }

  /** Queues the next reconnection attempt on the backoff schedule. */
  private scheduleReconnect(): void {
    const delay: number = SseClient.backoffDelay(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimeoutId = setTimeout((): void => {
      this.reconnectTimeoutId = null;
      this.open();
    }, delay);
  }
}
