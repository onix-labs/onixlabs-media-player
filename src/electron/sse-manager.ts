/**
 * @fileoverview Server-Sent Events (SSE) connection manager.
 *
 * Manages SSE client connections for real-time state updates from the
 * media server to the renderer. Provides broadcast capability and
 * automatic heartbeat pings to keep connections alive.
 *
 * @module electron/sse-manager
 */

import type { ServerResponse } from 'http';
import type { SSEEventType } from './media-types.js';

// ============================================================================
// SSE Manager
// ============================================================================

/**
 * Manages Server-Sent Events connections for real-time state updates.
 *
 * SSE provides a unidirectional channel from server to client that's
 * perfect for broadcasting state changes. Unlike WebSockets, SSE:
 * - Works over standard HTTP (no upgrade needed)
 * - Automatically reconnects on disconnect
 * - Is simpler to implement for broadcast scenarios
 *
 * The manager maintains a set of connected clients and broadcasts
 * events to all of them simultaneously.
 */
export class SSEManager {
  /** Set of active SSE client connections */
  private readonly clients: Set<ServerResponse> = new Set<ServerResponse>();

  /** Interval for sending heartbeat pings */
  private heartbeatInterval: NodeJS.Timeout | null = null;

  /**
   * Starts the SSE manager and begins heartbeat pings.
   * Heartbeats keep connections alive through proxies and firewalls.
   */
  public start(): void {
    // Send heartbeat every 30 seconds to keep connections alive
    this.heartbeatInterval = setInterval((): void => {
      this.broadcast('heartbeat', { timestamp: Date.now() });
    }, 30000);
  }

  /**
   * Stops the SSE manager and closes all client connections.
   * Called during server shutdown.
   */
  public stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
  }

  /**
   * Adds a new SSE client connection.
   * Automatically removes the client when the connection closes.
   *
   * @param res - The HTTP response object to use for SSE
   */
  public addClient(res: Readonly<ServerResponse>): void {
    this.clients.add(res as ServerResponse);
    res.on('close', (): void => { this.clients.delete(res as ServerResponse); });
  }

  /**
   * Broadcasts an event to all connected SSE clients.
   *
   * @param event - The event type (e.g., 'playback:state')
   * @param data - The event data (will be JSON serialized)
   */
  public broadcast(event: SSEEventType, data: Readonly<unknown>): void {
    const message: string = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      client.write(message);
    }
  }
}
