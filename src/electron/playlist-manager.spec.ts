/**
 * @fileoverview Tests for PlaylistManager.
 *
 * Tests cover:
 * - Index adjustment when removing items before, at, and after the selection
 * - next()/previous() at playlist boundaries with repeat on and off, in both
 *   sequential and shuffle modes
 * - Play history consumption by previous(), and its reset by setShuffle
 * - Shuffle order regeneration placing the current track first
 * - Duration updates broadcasting only past the 1s threshold
 * - The SSE event name and payload emitted by each operation
 *
 * Shuffle is made deterministic by stubbing Math.random, so the Fisher-Yates
 * result is a known permutation rather than something the assertions have to
 * work around.
 *
 * @module electron/playlist-manager.spec
 */

import type { PlaylistItem, PlaylistState } from './media-types.js';
import type { SSEManager } from './sse-manager.js';
import { PlaylistManager } from './playlist-manager.js';

// ============================================================================
// Helpers
// ============================================================================

/** A broadcast captured from the mock SSE manager. */
interface Broadcast {
  readonly event: string;
  readonly data: unknown;
}

/** An SSEManager stub that records every broadcast. */
interface MockSse {
  readonly sse: SSEManager;
  readonly sent: Broadcast[];
  /** Events of a given name, most recent last */
  of(event: string): Broadcast[];
  /** The most recent event of a given name */
  last(event: string): unknown;
  clear(): void;
}

/**
 * Creates an SSEManager stub that records broadcasts.
 *
 * @returns The stub plus helpers for inspecting what was sent
 */
function createMockSse(): MockSse {
  const sent: Broadcast[] = [];

  const sse = {
    broadcast: vi.fn((event: string, data: unknown): void => {
      sent.push({ event, data });
    }),
  } as unknown as SSEManager;

  return {
    sse,
    sent,
    of: (event: string): Broadcast[] => sent.filter((b: Broadcast): boolean => b.event === event),
    last: (event: string): unknown => {
      const matching: Broadcast[] = sent.filter((b: Broadcast): boolean => b.event === event);
      return matching[matching.length - 1]?.data;
    },
    clear: (): void => { sent.length = 0; },
  };
}

/**
 * Builds an item payload for addItems.
 *
 * @param title - Item title, also used to derive the file path
 * @param duration - Duration in seconds
 * @returns An item without an id
 */
function item(title: string, duration: number = 100): Omit<PlaylistItem, 'id'> {
  return {
    filePath: `/music/${title}.mp3`,
    title,
    duration,
    type: 'audio',
  };
}

/**
 * Builds n items named a, b, c, ...
 *
 * @param n - How many items to build
 * @returns Items without ids
 */
function items(n: number): Omit<PlaylistItem, 'id'>[] {
  return Array.from({ length: n }, (_: unknown, i: number): Omit<PlaylistItem, 'id'> =>
    item(String.fromCharCode('a'.charCodeAt(0) + i))
  );
}

/**
 * Pins Math.random to a fixed value so Fisher-Yates is deterministic.
 *
 * With random() === 0, every swap picks j = 0, which reverses nothing and
 * leaves the identity order — a known, assertable permutation.
 *
 * @param value - The value Math.random should return
 */
function pinRandom(value: number): void {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

// ============================================================================
// Tests
// ============================================================================

describe('PlaylistManager', (): void => {
  let mock: MockSse;
  let manager: PlaylistManager;

  beforeEach((): void => {
    mock = createMockSse();
    manager = new PlaylistManager(mock.sse);
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Adding Items
  // ==========================================================================

  describe('addItems', (): void => {
    it('assigns an id to every added item', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));

      expect(added).toHaveLength(3);
      expect(added.every((i: PlaylistItem): boolean => typeof i.id === 'string' && i.id.length > 0)).toBe(true);
    });

    it('assigns unique ids', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(5));
      const ids: Set<string> = new Set(added.map((i: PlaylistItem): string => i.id));

      expect(ids.size).toBe(5);
    });

    it('auto-selects the first item when the playlist was empty', (): void => {
      manager.addItems(items(3));

      expect(manager.getState().currentIndex).toBe(0);
      expect(manager.getCurrentItem()?.title).toBe('a');
    });

    it('leaves the selection alone when appending to a non-empty playlist', (): void => {
      manager.addItems(items(2));
      manager.selectIndex(1);
      mock.clear();

      manager.addItems([item('c')]);

      expect(manager.getState().currentIndex).toBe(1);
    });

    it('appends to the end', (): void => {
      manager.addItems(items(2));
      manager.addItems([item('c')]);

      const titles: string[] = manager.getState().items.map((i: PlaylistItem): string => i.title);
      expect(titles).toEqual(['a', 'b', 'c']);
    });

    it('broadcasts the added items with their start index', (): void => {
      manager.addItems(items(2));
      mock.clear();

      manager.addItems([item('c')]);

      expect(mock.last('playlist:items:added')).toMatchObject({startIndex: 2, currentIndex: 0});
    });

    it('broadcasts a selection change only when the selection moved', (): void => {
      manager.addItems(items(2));
      expect(mock.of('playlist:selection')).toHaveLength(1);

      mock.clear();
      manager.addItems([item('c')]);
      expect(mock.of('playlist:selection')).toHaveLength(0);
    });

    it('handles being called with no items', (): void => {
      const added: PlaylistItem[] = manager.addItems([]);

      expect(added).toEqual([]);
      expect(manager.getState().currentIndex).toBe(-1);
    });
  });

  // ==========================================================================
  // Removal and Index Adjustment
  // ==========================================================================

  describe('removeItem', (): void => {
    it('returns false for an unknown id', (): void => {
      manager.addItems(items(2));

      expect(manager.removeItem('nope')).toBe(false);
    });

    it('decrements the current index when removing an earlier item', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));
      manager.selectIndex(2);

      manager.removeItem(added[0].id);

      expect(manager.getState().currentIndex).toBe(1);
      expect(manager.getCurrentItem()?.title).toBe('c');
    });

    it('leaves the current index alone when removing a later item', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));
      manager.selectIndex(0);

      manager.removeItem(added[2].id);

      expect(manager.getState().currentIndex).toBe(0);
      expect(manager.getCurrentItem()?.title).toBe('a');
    });

    it('keeps the index when removing the current item mid-list', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));
      manager.selectIndex(1);

      manager.removeItem(added[1].id);

      // The item that followed slides into the vacated index.
      expect(manager.getState().currentIndex).toBe(1);
      expect(manager.getCurrentItem()?.title).toBe('c');
    });

    it('clamps to the last item when removing the current last item', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));
      manager.selectIndex(2);

      manager.removeItem(added[2].id);

      expect(manager.getState().currentIndex).toBe(1);
      expect(manager.getCurrentItem()?.title).toBe('b');
    });

    it('resets the index to -1 when the last remaining item is removed', (): void => {
      const added: PlaylistItem[] = manager.addItems([item('a')]);

      manager.removeItem(added[0].id);

      expect(manager.getState().currentIndex).toBe(-1);
      expect(manager.getCurrentItem()).toBeNull();
    });

    it('broadcasts the removed id and index', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));
      manager.selectIndex(0);
      mock.clear();

      manager.removeItem(added[1].id);

      expect(mock.last('playlist:items:removed')).toMatchObject({id: added[1].id, removedIndex: 1});
    });

    it('does not broadcast a selection change when the selection is unaffected', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));
      manager.selectIndex(0);
      mock.clear();

      manager.removeItem(added[2].id);

      expect(mock.of('playlist:selection')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Selection
  // ==========================================================================

  describe('selection', (): void => {
    it('selects by id', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(3));

      const selected: PlaylistItem | null = manager.selectItem(added[2].id);

      expect(selected?.title).toBe('c');
      expect(manager.getState().currentIndex).toBe(2);
    });

    it('returns null for an unknown id', (): void => {
      manager.addItems(items(2));

      expect(manager.selectItem('nope')).toBeNull();
    });

    it('selects by index', (): void => {
      manager.addItems(items(3));

      expect(manager.selectIndex(1)?.title).toBe('b');
    });

    it('returns null for an out-of-range index', (): void => {
      manager.addItems(items(2));

      expect(manager.selectIndex(-1)).toBeNull();
      expect(manager.selectIndex(2)).toBeNull();
    });

    it('broadcasts the selection with the item', (): void => {
      manager.addItems(items(2));
      mock.clear();

      manager.selectIndex(1);

      expect(mock.last('playlist:selection')).toMatchObject({currentIndex: 1});
    });
  });

  // ==========================================================================
  // Sequential Navigation
  // ==========================================================================

  describe('next (sequential)', (): void => {
    it('returns null on an empty playlist', (): void => {
      expect(manager.next()).toBeNull();
    });

    it('advances one track', (): void => {
      manager.addItems(items(3));

      expect(manager.next()?.title).toBe('b');
    });

    it('returns null at the end without repeat', (): void => {
      manager.addItems(items(2));
      manager.selectIndex(1);

      expect(manager.next()).toBeNull();
      expect(manager.getState().currentIndex).toBe(1);
    });

    it('wraps to the start at the end with repeat', (): void => {
      manager.addItems(items(3));
      manager.selectIndex(2);
      manager.setRepeat(true);

      expect(manager.next()?.title).toBe('a');
      expect(manager.getState().currentIndex).toBe(0);
    });

    it('does not wrap mid-playlist with repeat', (): void => {
      manager.addItems(items(3));
      manager.setRepeat(true);

      expect(manager.next()?.title).toBe('b');
    });

    it('repeats a single-item playlist onto itself', (): void => {
      manager.addItems([item('a')]);
      manager.setRepeat(true);

      expect(manager.next()?.title).toBe('a');
    });
  });

  describe('previous (sequential)', (): void => {
    it('returns null on an empty playlist', (): void => {
      expect(manager.previous()).toBeNull();
    });

    it('returns null at the start without repeat or history', (): void => {
      manager.addItems(items(2));

      expect(manager.previous()).toBeNull();
    });

    it('wraps to the end at the start with repeat', (): void => {
      manager.addItems(items(3));
      manager.setRepeat(true);

      expect(manager.previous()?.title).toBe('c');
      expect(manager.getState().currentIndex).toBe(2);
    });

  });

  // ==========================================================================
  // Play History
  // ==========================================================================

  describe('play history', (): void => {
    it('previous() walks back through played tracks', (): void => {
      manager.addItems(items(4));
      manager.selectIndex(0);
      manager.selectIndex(2);
      manager.selectIndex(3);

      expect(manager.previous()?.title).toBe('c');
      expect(manager.previous()?.title).toBe('a');
    });

    it('falls back to sequential once history is exhausted', (): void => {
      manager.addItems(items(3));
      manager.selectIndex(2);

      // History is [2]; nothing to pop, so it steps back sequentially.
      expect(manager.previous()?.title).toBe('b');
    });

    it('is reset to the current track when shuffle is toggled', (): void => {
      pinRandom(0);
      manager.addItems(items(4));
      manager.selectIndex(0);
      manager.selectIndex(1);
      manager.selectIndex(2);

      manager.setShuffle(true);

      // History is now just [2] and the shuffle position is at the front, so
      // there is nothing to walk back to at all.
      expect(manager.previous()).toBeNull();
      expect(manager.getState().currentIndex).toBe(2);
    });

    it('does not select a history entry that is no longer a valid index', (): void => {
      const added: PlaylistItem[] = manager.addItems(items(4));
      manager.selectIndex(3);
      manager.selectIndex(0);
      // Shrink the playlist so the remembered index 3 no longer exists.
      manager.removeItem(added[3].id);
      manager.removeItem(added[2].id);

      // The stale index is discarded, and index 0 has nowhere earlier to go.
      expect(manager.previous()).toBeNull();
      expect(manager.getState().currentIndex).toBe(0);
    });
  });

  // ==========================================================================
  // Shuffle
  // ==========================================================================

  describe('shuffle', (): void => {
    it('is off by default', (): void => {
      expect(manager.getState().shuffleEnabled).toBe(false);
    });

    it('puts the current track first in the shuffle order', (): void => {
      pinRandom(0);
      manager.addItems(items(5));
      manager.selectIndex(3);

      manager.setShuffle(true);

      // The first next() must not return the track we are already on.
      expect(manager.getState().currentIndex).toBe(3);
      expect(manager.next()?.title).not.toBe('d');
    });

    it('visits every track exactly once before running out', (): void => {
      pinRandom(0);
      manager.addItems(items(4));
      manager.setShuffle(true);

      const visited: number[] = [manager.getState().currentIndex];
      for (let i: number = 0; i < 3; i++) {
        manager.next();
        visited.push(manager.getState().currentIndex);
      }

      expect(new Set(visited).size).toBe(4);
      expect(manager.next()).toBeNull();
    });

    it('regenerates the order and restarts when repeating', (): void => {
      pinRandom(0);
      manager.addItems(items(3));
      manager.setShuffle(true);
      manager.setRepeat(true);

      manager.next();
      manager.next();
      const wrapped: PlaylistItem | null = manager.next();

      expect(wrapped).not.toBeNull();
    });

    it('regenerates the order when items are added', (): void => {
      pinRandom(0);
      manager.addItems(items(2));
      manager.setShuffle(true);

      manager.addItems(items(3));

      // Every index must still be reachable after the order is rebuilt.
      const visited: Set<number> = new Set([manager.getState().currentIndex]);
      while (manager.next() !== null) {
        visited.add(manager.getState().currentIndex);
      }
      expect(visited.size).toBe(5);
    });

    it('wraps to the end of the shuffle order on previous with repeat', (): void => {
      pinRandom(0);
      manager.addItems(items(3));
      manager.setShuffle(true);
      manager.setRepeat(true);

      expect(manager.previous()).not.toBeNull();
    });

    it('does nothing when set to its current value', (): void => {
      manager.addItems(items(2));
      mock.clear();

      manager.setShuffle(false);

      expect(mock.of('playlist:mode')).toHaveLength(0);
    });

    it('broadcasts the mode change', (): void => {
      manager.addItems(items(2));
      mock.clear();

      manager.setShuffle(true);

      expect(mock.last('playlist:mode')).toEqual({shuffleEnabled: true, repeatEnabled: false});
    });

    it('handles being enabled on an empty playlist', (): void => {
      expect((): void => manager.setShuffle(true)).not.toThrow();
      expect(manager.getState().shuffleEnabled).toBe(true);
    });
  });

  // ==========================================================================
  // Repeat
  // ==========================================================================

  describe('repeat', (): void => {
    it('is off by default', (): void => {
      expect(manager.getState().repeatEnabled).toBe(false);
    });

    it('does nothing when set to its current value', (): void => {
      mock.clear();

      manager.setRepeat(false);

      expect(mock.of('playlist:mode')).toHaveLength(0);
    });

    it('broadcasts the mode change', (): void => {
      mock.clear();

      manager.setRepeat(true);

      expect(mock.last('playlist:mode')).toEqual({shuffleEnabled: false, repeatEnabled: true});
    });

    it('notifies the mode-change callback', (): void => {
      const onModeChange = vi.fn();
      const withCallback: PlaylistManager = new PlaylistManager(mock.sse, onModeChange);

      withCallback.setRepeat(true);

      expect(onModeChange).toHaveBeenCalledWith(false, true);
    });
  });

  // ==========================================================================
  // Clear
  // ==========================================================================

  describe('clear', (): void => {
    it('empties the playlist and resets the selection', (): void => {
      manager.addItems(items(3));
      manager.setSourceFilePath('/playlists/mine.opp');

      manager.clear();

      const state: PlaylistState = manager.getState();
      expect(state.items).toEqual([]);
      expect(state.currentIndex).toBe(-1);
      expect(manager.getSourceFilePath()).toBeNull();
    });

    it('broadcasts the cleared event', (): void => {
      manager.addItems(items(2));
      mock.clear();

      manager.clear();

      expect(mock.of('playlist:cleared')).toHaveLength(1);
    });

    it('clears play history so previous() has nothing to walk back to', (): void => {
      manager.addItems(items(3));
      manager.selectIndex(1);
      manager.selectIndex(2);

      manager.clear();
      manager.addItems(items(3));

      expect(manager.previous()).toBeNull();
    });
  });

  // ==========================================================================
  // Duration Updates
  // ==========================================================================

  describe('updateItemDurations', (): void => {
    it('updates every item with the matching path', (): void => {
      manager.addItems([item('a', 10), item('b', 10)]);
      manager.addItems([{...item('a', 10)}]);

      manager.updateItemDurations('/music/a.mp3', 200);

      const durations: number[] = manager.getState().items
        .filter((i: PlaylistItem): boolean => i.filePath === '/music/a.mp3')
        .map((i: PlaylistItem): number => i.duration);
      expect(durations).toEqual([200, 200]);
    });

    it('broadcasts when the duration changes by more than a second', (): void => {
      manager.addItems([item('a', 10)]);
      mock.clear();

      manager.updateItemDurations('/music/a.mp3', 200);

      expect(mock.last('playlist:items:duration')).toEqual({filePath: '/music/a.mp3', duration: 200});
    });

    it('does not broadcast for a sub-second refinement', (): void => {
      manager.addItems([item('a', 100)]);
      mock.clear();

      manager.updateItemDurations('/music/a.mp3', 100.5);

      expect(mock.of('playlist:items:duration')).toHaveLength(0);
    });

    it('does not broadcast for an exactly one-second delta', (): void => {
      manager.addItems([item('a', 100)]);
      mock.clear();

      manager.updateItemDurations('/music/a.mp3', 101);

      expect(mock.of('playlist:items:duration')).toHaveLength(0);
    });

    it('does not broadcast when no item matches the path', (): void => {
      manager.addItems([item('a', 100)]);
      mock.clear();

      manager.updateItemDurations('/music/other.mp3', 500);

      expect(mock.of('playlist:items:duration')).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Source File
  // ==========================================================================

  describe('source file path', (): void => {
    it('starts null', (): void => {
      expect(manager.getSourceFilePath()).toBeNull();
    });

    it('round-trips a path', (): void => {
      manager.setSourceFilePath('/playlists/mine.opp');

      expect(manager.getSourceFilePath()).toBe('/playlists/mine.opp');
    });

    it('can be cleared', (): void => {
      manager.setSourceFilePath('/playlists/mine.opp');

      manager.setSourceFilePath(null);

      expect(manager.getSourceFilePath()).toBeNull();
    });
  });
});
