/**
 * @fileoverview Tests for SseClient.
 *
 * The reconnect schedule is the part worth pinning: it was previously buried
 * among two hundred lines of signal updates, where a wrong exponent or a
 * missing cap would have gone unnoticed until a server outage.
 *
 * @module app/services/sse-client.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {SseClient} from './sse-client.service';

// ============================================================================
// Helpers
// ============================================================================

/** A fake EventSource whose lifecycle the tests drive. */
class FakeEventSource {
  public static instances: FakeEventSource[] = [];
  public static get last(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1];
  }

  public onopen: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public closed: boolean = false;
  public readonly listeners: Map<string, (e: {data: string}) => void> = new Map();

  public constructor(public readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  public addEventListener(type: string, handler: (e: {data: string}) => void): void {
    this.listeners.set(type, handler);
  }

  public close(): void {
    this.closed = true;
  }

  /** Delivers an event to the registered handler. */
  public emit(type: string, data: string): void {
    this.listeners.get(type)?.({data});
  }
}

// ============================================================================
// Tests
// ============================================================================

describe('SseClient', (): void => {
  let client: SseClient;

  beforeEach((): void => {
    FakeEventSource.instances = [];
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    vi.useFakeTimers();

    TestBed.configureTestingModule({providers: [SseClient]});
    client = TestBed.inject(SseClient);
  });

  afterEach((): void => {
    client.disconnect();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Backoff schedule
  // ==========================================================================

  describe('backoffDelay', (): void => {
    it('starts at one second', (): void => {
      expect(SseClient.backoffDelay(0)).toBe(1000);
    });

    it('doubles per attempt', (): void => {
      expect(SseClient.backoffDelay(1)).toBe(2000);
      expect(SseClient.backoffDelay(2)).toBe(4000);
      expect(SseClient.backoffDelay(3)).toBe(8000);
    });

    it('caps at thirty seconds', (): void => {
      expect(SseClient.backoffDelay(10)).toBe(30000);
      expect(SseClient.backoffDelay(100)).toBe(30000);
    });

    it('never returns a delay of zero, so retries cannot spin', (): void => {
      for (let attempt: number = 0; attempt < 20; attempt++) {
        expect(SseClient.backoffDelay(attempt)).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // Connecting
  // ==========================================================================

  describe('connect', (): void => {
    it('opens a connection to the given URL', (): void => {
      client.connect('http://host/events?token=abc', {});

      expect(FakeEventSource.last.url).toBe('http://host/events?token=abc');
      expect(client.isConnected()).toBe(true);
    });

    it('registers every handler', (): void => {
      client.connect('http://host/events', {'playback:state': vi.fn(), 'playlist:updated': vi.fn()});

      expect([...FakeEventSource.last.listeners.keys()]).toEqual(['playback:state', 'playlist:updated']);
    });

    it('delivers the raw payload to the handler', (): void => {
      const handler = vi.fn();
      client.connect('http://host/events', {'playback:state': handler});

      FakeEventSource.last.emit('playback:state', '{"playing":true}');

      expect(handler).toHaveBeenCalledWith('{"playing":true}');
    });

    it('replaces an existing connection', (): void => {
      client.connect('http://host/one', {});
      const first: FakeEventSource = FakeEventSource.last;

      client.connect('http://host/two', {});

      expect(first.closed).toBe(true);
      expect(FakeEventSource.last.url).toBe('http://host/two');
    });
  });

  // ==========================================================================
  // Reconnection
  // ==========================================================================

  describe('reconnection', (): void => {
    beforeEach((): void => {
      client.connect('http://host/events', {'playback:state': vi.fn()});
    });

    it('reports itself disconnected after an error', (): void => {
      FakeEventSource.last.onerror?.();

      expect(client.isConnected()).toBe(false);
    });

    it('reconnects after the first backoff delay', (): void => {
      FakeEventSource.last.onerror?.();

      vi.advanceTimersByTime(1000);

      expect(FakeEventSource.instances).toHaveLength(2);
      expect(client.isConnected()).toBe(true);
    });

    it('does not reconnect before the delay elapses', (): void => {
      FakeEventSource.last.onerror?.();

      vi.advanceTimersByTime(999);

      expect(FakeEventSource.instances).toHaveLength(1);
    });

    it('backs off further on each successive failure', (): void => {
      FakeEventSource.last.onerror?.();
      vi.advanceTimersByTime(1000);

      FakeEventSource.last.onerror?.();
      vi.advanceTimersByTime(1999);
      expect(FakeEventSource.instances).toHaveLength(2);

      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(3);
    });

    it('reattaches handlers to the new connection', (): void => {
      const handler = vi.fn();
      client.connect('http://host/events', {'playback:state': handler});

      FakeEventSource.last.onerror?.();
      vi.advanceTimersByTime(1000);
      FakeEventSource.last.emit('playback:state', 'payload');

      expect(handler).toHaveBeenCalledWith('payload');
    });

    it('resets the backoff once a connection opens', (): void => {
      FakeEventSource.last.onerror?.();
      vi.advanceTimersByTime(1000);

      // A successful open should put the schedule back to the start.
      FakeEventSource.last.onopen?.();
      FakeEventSource.last.onerror?.();
      vi.advanceTimersByTime(1000);

      expect(FakeEventSource.instances).toHaveLength(3);
    });
  });

  // ==========================================================================
  // Disconnecting
  // ==========================================================================

  describe('disconnect', (): void => {
    it('closes the connection', (): void => {
      client.connect('http://host/events', {});

      client.disconnect();

      expect(FakeEventSource.instances[0].closed).toBe(true);
      expect(client.isConnected()).toBe(false);
    });

    it('cancels a pending reconnection', (): void => {
      client.connect('http://host/events', {});
      FakeEventSource.last.onerror?.();

      client.disconnect();
      vi.advanceTimersByTime(60000);

      expect(FakeEventSource.instances).toHaveLength(1);
    });

    it('is safe to call without connecting', (): void => {
      expect((): void => client.disconnect()).not.toThrow();
    });

    it('is safe to call twice', (): void => {
      client.connect('http://host/events', {});
      client.disconnect();

      expect((): void => client.disconnect()).not.toThrow();
    });
  });
});
