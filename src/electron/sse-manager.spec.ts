/**
 * @fileoverview Tests for SSEManager.
 *
 * Tests cover:
 * - Exact SSE wire framing produced by broadcast
 * - Client registration and automatic removal on close
 * - Heartbeat scheduling and teardown
 * - stop() ending every client and clearing the set
 *
 * @module electron/sse-manager.spec
 */

import type { ServerResponse } from 'http';
import { SSEManager } from './sse-manager.js';

// ============================================================================
// Helpers
// ============================================================================

/** A ServerResponse stub that records writes and exposes its 'close' handler. */
interface FakeClient extends ServerResponse {
  /** Everything written to this client, in order */
  readonly writes: string[];
  /** Fires the registered 'close' handler */
  close(): void;
}

/**
 * Creates a ServerResponse-shaped stub for use as an SSE client.
 *
 * @returns A fake client that records writes
 */
function createFakeClient(): FakeClient {
  const writes: string[] = [];
  let closeHandler: (() => void) | null = null;

  const client = {
    writes,
    write: vi.fn((chunk: string): boolean => {
      writes.push(chunk);
      return true;
    }),
    end: vi.fn(),
    on: vi.fn((event: string, handler: () => void): unknown => {
      if (event === 'close') closeHandler = handler;
      return client;
    }),
    close: (): void => closeHandler?.(),
  };

  return client as unknown as FakeClient;
}

// ============================================================================
// Tests
// ============================================================================

describe('SSEManager', (): void => {
  let manager: SSEManager;

  beforeEach((): void => {
    manager = new SSEManager();
  });

  afterEach((): void => {
    manager.stop();
    vi.useRealTimers();
  });

  // ==========================================================================
  // Broadcast Framing
  // ==========================================================================

  describe('broadcast', (): void => {
    it('writes the SSE framing exactly', (): void => {
      const client: FakeClient = createFakeClient();
      manager.addClient(client);

      manager.broadcast('playback:state', { playing: true });

      expect(client.writes).toEqual(['event: playback:state\ndata: {"playing":true}\n\n']);
    });

    it('writes to every connected client', (): void => {
      const first: FakeClient = createFakeClient();
      const second: FakeClient = createFakeClient();
      manager.addClient(first);
      manager.addClient(second);

      manager.broadcast('playlist:updated', { items: [] });

      expect(first.writes).toHaveLength(1);
      expect(second.writes).toHaveLength(1);
      expect(first.writes[0]).toBe(second.writes[0]);
    });

    it('serializes null data', (): void => {
      const client: FakeClient = createFakeClient();
      manager.addClient(client);

      manager.broadcast('playback:state', null);

      expect(client.writes[0]).toBe('event: playback:state\ndata: null\n\n');
    });

    it('terminates each message with a blank line', (): void => {
      const client: FakeClient = createFakeClient();
      manager.addClient(client);

      manager.broadcast('playback:state', { a: 1 });
      manager.broadcast('playback:state', { a: 2 });

      for (const write of client.writes) {
        expect(write.endsWith('\n\n')).toBe(true);
      }
    });

    it('does nothing when there are no clients', (): void => {
      expect((): void => manager.broadcast('playback:state', {})).not.toThrow();
    });
  });

  // ==========================================================================
  // Client Lifecycle
  // ==========================================================================

  describe('client lifecycle', (): void => {
    it('registers a close handler for each client', (): void => {
      const client: FakeClient = createFakeClient();

      manager.addClient(client);

      expect(client.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('stops writing to a client once it closes', (): void => {
      const client: FakeClient = createFakeClient();
      manager.addClient(client);

      client.close();
      manager.broadcast('playback:state', { playing: true });

      expect(client.writes).toHaveLength(0);
    });

    it('keeps broadcasting to the clients that remain', (): void => {
      const closing: FakeClient = createFakeClient();
      const staying: FakeClient = createFakeClient();
      manager.addClient(closing);
      manager.addClient(staying);

      closing.close();
      manager.broadcast('playback:state', { playing: true });

      expect(closing.writes).toHaveLength(0);
      expect(staying.writes).toHaveLength(1);
    });

    it('does not double-register the same client', (): void => {
      const client: FakeClient = createFakeClient();

      manager.addClient(client);
      manager.addClient(client);
      manager.broadcast('playback:state', {});

      expect(client.writes).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Heartbeat
  // ==========================================================================

  describe('heartbeat', (): void => {
    it('broadcasts a heartbeat every 30 seconds', (): void => {
      vi.useFakeTimers();
      const client: FakeClient = createFakeClient();
      manager.addClient(client);
      manager.start();

      vi.advanceTimersByTime(30000);
      expect(client.writes).toHaveLength(1);
      expect(client.writes[0]).toContain('event: heartbeat');

      vi.advanceTimersByTime(30000);
      expect(client.writes).toHaveLength(2);
    });

    it('includes a timestamp in the heartbeat payload', (): void => {
      vi.useFakeTimers();
      const client: FakeClient = createFakeClient();
      manager.addClient(client);
      manager.start();

      vi.advanceTimersByTime(30000);

      expect(client.writes[0]).toMatch(/data: \{"timestamp":\d+\}/);
    });

    it('does not fire before the interval elapses', (): void => {
      vi.useFakeTimers();
      const client: FakeClient = createFakeClient();
      manager.addClient(client);
      manager.start();

      vi.advanceTimersByTime(29999);

      expect(client.writes).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Shutdown
  // ==========================================================================

  describe('stop', (): void => {
    it('ends every connected client', (): void => {
      const first: FakeClient = createFakeClient();
      const second: FakeClient = createFakeClient();
      manager.addClient(first);
      manager.addClient(second);

      manager.stop();

      expect(first.end).toHaveBeenCalledOnce();
      expect(second.end).toHaveBeenCalledOnce();
    });

    it('clears the client set', (): void => {
      const client: FakeClient = createFakeClient();
      manager.addClient(client);

      manager.stop();
      manager.broadcast('playback:state', {});

      expect(client.writes).toHaveLength(0);
    });

    it('cancels the heartbeat', (): void => {
      vi.useFakeTimers();
      const client: FakeClient = createFakeClient();
      manager.addClient(client);
      manager.start();

      manager.stop();
      vi.advanceTimersByTime(120000);

      expect(client.writes).toHaveLength(0);
    });

    it('is safe to call without having started', (): void => {
      expect((): void => manager.stop()).not.toThrow();
    });

    it('is safe to call twice', (): void => {
      manager.start();

      manager.stop();

      expect((): void => manager.stop()).not.toThrow();
    });
  });
});
