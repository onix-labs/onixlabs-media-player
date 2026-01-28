/**
 * @fileoverview Playlist management with shuffle and repeat functionality.
 *
 * The PlaylistManager is the authoritative source for:
 * - The list of media items and their metadata
 * - Current track selection and navigation
 * - Shuffle/repeat mode state
 * - Navigation history (for "previous" functionality)
 *
 * Shuffle uses Fisher-Yates algorithm to generate a random order.
 * The current track is always placed first in the shuffle order
 * to avoid repeating it immediately when shuffle is enabled.
 *
 * @module electron/playlist-manager
 */

import type { PlaylistItem, PlaylistState } from './media-types.js';
import type { SSEManager } from './sse-manager.js';

// ============================================================================
// Playlist Manager
// ============================================================================

/**
 * Manages the media playlist with shuffle and repeat functionality.
 *
 * The playlist manager is the authoritative source for:
 * - The list of media items
 * - Current track selection
 * - Shuffle/repeat mode state
 * - Navigation history (for "previous" functionality)
 *
 * Shuffle uses Fisher-Yates algorithm to generate a random order.
 * The current track is always placed first in the shuffle order
 * to avoid repeating it immediately when shuffle is enabled.
 */
export class PlaylistManager {
  /** The list of playlist items */
  private items: PlaylistItem[] = [];

  /** Index of the currently selected item (-1 if none) */
  private currentIndex: number = -1;

  /** Whether shuffle mode is enabled */
  private shuffleEnabled: boolean = false;

  /** Whether repeat mode is enabled */
  private repeatEnabled: boolean = false;

  /** Randomized order for shuffle mode */
  private shuffleOrder: number[] = [];

  /** Current position within the shuffle order */
  private shufflePosition: number = 0;

  /** History of played track indices for "previous" navigation */
  private playHistory: number[] = [];

  /** Path to the .opp file the current playlist was loaded from, or null if not from a file */
  private sourceFilePath: string | null = null;

  /** Reference to SSE manager for broadcasting updates */
  private readonly sse: SSEManager;

  /** Callback for mode changes */
  private readonly onModeChange: ((shuffle: boolean, repeat: boolean) => void) | null;

  /**
   * Creates a new playlist manager.
   *
   * @param sse - SSE manager for broadcasting playlist updates
   * @param onModeChange - Optional callback for mode changes
   */
  public constructor(sse: Readonly<SSEManager>, onModeChange?: (shuffle: boolean, repeat: boolean) => void) {
    this.sse = sse as SSEManager;
    this.onModeChange = onModeChange ?? null;
  }

  /**
   * Gets the complete playlist state for synchronization.
   *
   * @returns Current playlist state including items and settings
   */
  public getState(): PlaylistState {
    return {
      items: this.items,
      currentIndex: this.currentIndex,
      shuffleEnabled: this.shuffleEnabled,
      repeatEnabled: this.repeatEnabled,
    };
  }

  /**
   * Gets the source .opp file path, or null if the playlist was not loaded from a file.
   *
   * @returns The source file path or null
   */
  public getSourceFilePath(): string | null {
    return this.sourceFilePath;
  }

  /**
   * Sets the source .opp file path (called after loading or saving a playlist file).
   *
   * @param filePath - The file path, or null to clear
   */
  public setSourceFilePath(filePath: string | null): void {
    this.sourceFilePath = filePath;
  }

  /**
   * Gets the currently selected playlist item.
   *
   * @returns The current item, or null if nothing is selected
   */
  public getCurrentItem(): PlaylistItem | null {
    if (this.currentIndex >= 0 && this.currentIndex < this.items.length) {
      return this.items[this.currentIndex];
    }
    return null;
  }

  /**
   * Adds new items to the playlist.
   *
   * Items are assigned unique IDs and added to the end of the playlist.
   * If the playlist was empty, the first item is automatically selected.
   * Shuffle order is regenerated if shuffle mode is enabled.
   *
   * @param newItems - Items to add (without IDs, which will be generated)
   * @returns The items that were added (with generated IDs)
   */
  public addItems(newItems: readonly Omit<PlaylistItem, 'id'>[]): PlaylistItem[] {
    const itemsWithIds: PlaylistItem[] = newItems.map((item: Readonly<Omit<PlaylistItem, 'id'>>): PlaylistItem => ({
      ...item,
      id: this.generateId(),
    }));

    const startIndex: number = this.items.length;
    this.items.push(...itemsWithIds);

    if (this.shuffleEnabled) {
      this.regenerateShuffleOrder();
    }

    let selectionChanged: boolean = false;
    if (this.currentIndex === -1 && this.items.length > 0) {
      this.currentIndex = 0;
      selectionChanged = true;
      if (this.shuffleEnabled) {
        this.shufflePosition = this.shuffleOrder.indexOf(0);
      }
    }

    // Broadcast delta update instead of full playlist
    this.sse.broadcast('playlist:items:added', {
      items: itemsWithIds,
      startIndex,
      currentIndex: this.currentIndex,
    });

    if (selectionChanged) {
      this.broadcastSelectionChange();
    }

    return itemsWithIds;
  }

  /**
   * Removes an item from the playlist by ID.
   *
   * Adjusts the current index if necessary to maintain valid selection.
   * Regenerates shuffle order if shuffle mode is enabled.
   *
   * @param id - The ID of the item to remove
   * @returns True if the item was found and removed, false otherwise
   */
  public removeItem(id: string): boolean {
    const idx: number = this.items.findIndex((item: Readonly<PlaylistItem>): boolean => item.id === id);
    if (idx === -1) return false;

    const currentIdx: number = this.currentIndex;
    this.items = this.items.filter((item: Readonly<PlaylistItem>): boolean => item.id !== id);

    let selectionChanged: boolean = false;
    if (idx < currentIdx) {
      this.currentIndex--;
      selectionChanged = true;
    } else if (idx === currentIdx) {
      selectionChanged = true;
      if (this.items.length === 0) {
        this.currentIndex = -1;
      } else if (currentIdx >= this.items.length) {
        this.currentIndex = this.items.length - 1;
      }
    }

    if (this.shuffleEnabled) {
      this.regenerateShuffleOrder();
    }

    // Broadcast delta update instead of full playlist
    this.sse.broadcast('playlist:items:removed', {
      id,
      removedIndex: idx,
      currentIndex: this.currentIndex,
    });

    if (selectionChanged) {
      this.broadcastSelectionChange();
    }

    return true;
  }

  /**
   * Clears all items from the playlist.
   * Resets all state including shuffle order, play history, and source file.
   */
  public clear(): void {
    this.items = [];
    this.currentIndex = -1;
    this.shuffleOrder = [];
    this.shufflePosition = 0;
    this.playHistory = [];
    this.sourceFilePath = null;
    // Broadcast cleared event instead of full playlist
    this.sse.broadcast('playlist:cleared', {});
  }

  /**
   * Selects a specific item by ID.
   *
   * @param id - The ID of the item to select
   * @returns The selected item, or null if not found
   */
  public selectItem(id: string): PlaylistItem | null {
    const idx: number = this.items.findIndex((item: Readonly<PlaylistItem>): boolean => item.id === id);
    if (idx === -1) return null;

    this.currentIndex = idx;
    this.playHistory.push(idx);

    if (this.shuffleEnabled) {
      this.shufflePosition = this.shuffleOrder.indexOf(idx);
    }

    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Selects a specific item by index.
   *
   * @param index - The index of the item to select
   * @returns The selected item, or null if index is invalid
   */
  public selectIndex(index: number): PlaylistItem | null {
    if (index < 0 || index >= this.items.length) return null;

    this.currentIndex = index;
    this.playHistory.push(index);

    if (this.shuffleEnabled) {
      this.shufflePosition = this.shuffleOrder.indexOf(index);
    }

    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Advances to the next track in the playlist.
   *
   * In shuffle mode, advances through the shuffle order.
   * In repeat mode, wraps to the beginning when reaching the end.
   *
   * @returns The next item, or null if at end of playlist (and not repeating)
   */
  public next(): PlaylistItem | null {
    if (this.items.length === 0) return null;

    if (this.repeatEnabled && !this.canGoNext()) {
      // Repeat playlist from beginning
      if (this.shuffleEnabled) {
        this.regenerateShuffleOrder();
        this.shufflePosition = 0;
        this.currentIndex = this.shuffleOrder[0];
      } else {
        this.currentIndex = 0;
      }
      this.playHistory.push(this.currentIndex);
      this.broadcastSelectionChange();
      return this.getCurrentItem();
    }

    if (!this.canGoNext()) return null;

    if (this.shuffleEnabled) {
      this.shufflePosition++;
      this.currentIndex = this.shuffleOrder[this.shufflePosition];
    } else {
      this.currentIndex++;
    }

    this.playHistory.push(this.currentIndex);
    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Goes to the previous track in the playlist.
   *
   * First checks play history for the previously played track.
   * Falls back to sequential/shuffle navigation if no history.
   * In repeat mode, wraps to the end when at the beginning.
   *
   * @returns The previous item, or null if at beginning (and not repeating)
   */
  public previous(): PlaylistItem | null {
    if (this.items.length === 0) return null;

    // Check play history first
    if (this.playHistory.length > 1) {
      this.playHistory.pop();
      const prevIdx: number | undefined = this.playHistory[this.playHistory.length - 1];
      if (prevIdx !== undefined && prevIdx >= 0 && prevIdx < this.items.length) {
        this.currentIndex = prevIdx;
        if (this.shuffleEnabled) {
          this.shufflePosition = this.shuffleOrder.indexOf(prevIdx);
        }
        this.broadcastSelectionChange();
        return this.getCurrentItem();
      }
    }

    if (!this.canGoPrevious()) {
      if (this.repeatEnabled) {
        if (this.shuffleEnabled) {
          this.shufflePosition = this.shuffleOrder.length - 1;
          this.currentIndex = this.shuffleOrder[this.shufflePosition];
        } else {
          this.currentIndex = this.items.length - 1;
        }
        this.playHistory.push(this.currentIndex);
        this.broadcastSelectionChange();
        return this.getCurrentItem();
      }
      return null;
    }

    if (this.shuffleEnabled) {
      this.shufflePosition--;
      this.currentIndex = this.shuffleOrder[this.shufflePosition];
    } else {
      this.currentIndex--;
    }

    this.playHistory.push(this.currentIndex);
    this.broadcastSelectionChange();
    return this.getCurrentItem();
  }

  /**
   * Enables or disables shuffle mode.
   *
   * When enabling shuffle, generates a new random order with the
   * current track at the front. Resets play history.
   *
   * @param enabled - Whether to enable shuffle mode
   */
  public setShuffle(enabled: boolean): void {
    if (this.shuffleEnabled === enabled) return;

    this.shuffleEnabled = enabled;

    if (enabled) {
      this.regenerateShuffleOrder();
      this.shufflePosition = this.shuffleOrder.indexOf(this.currentIndex);
      if (this.shufflePosition === -1) this.shufflePosition = 0;
    }

    this.playHistory = [this.currentIndex];
    this.broadcastModeChange();
  }

  /**
   * Enables or disables repeat mode.
   *
   * When repeat is enabled, the playlist wraps around instead of stopping.
   *
   * @param enabled - Whether to enable repeat mode
   */
  public setRepeat(enabled: boolean): void {
    if (this.repeatEnabled === enabled) return;
    this.repeatEnabled = enabled;
    this.broadcastModeChange();
  }

  /**
   * Checks if there's a next track available (without repeat).
   */
  private canGoNext(): boolean {
    if (this.items.length === 0) return false;
    if (this.shuffleEnabled) {
      return this.shufflePosition < this.shuffleOrder.length - 1;
    }
    return this.currentIndex < this.items.length - 1;
  }

  /**
   * Checks if there's a previous track available (without repeat).
   */
  private canGoPrevious(): boolean {
    if (this.items.length === 0) return false;
    if (this.shuffleEnabled) {
      return this.shufflePosition > 0;
    }
    return this.currentIndex > 0;
  }

  /**
   * Regenerates the shuffle order using Fisher-Yates algorithm.
   *
   * The current track is moved to the front of the shuffle order
   * to avoid immediately repeating it when shuffle is enabled.
   */
  private regenerateShuffleOrder(): void {
    const length: number = this.items.length;
    if (length === 0) {
      this.shuffleOrder = [];
      return;
    }

    this.shuffleOrder = Array.from({ length }, (_: unknown, i: number): number => i);

    // Fisher-Yates shuffle
    for (let i: number = length - 1; i > 0; i--) {
      const j: number = Math.floor(Math.random() * (i + 1));
      [this.shuffleOrder[i], this.shuffleOrder[j]] = [this.shuffleOrder[j], this.shuffleOrder[i]];
    }

    // Move current track to front
    const currentIdx: number = this.currentIndex;
    if (currentIdx >= 0) {
      const posInShuffle: number = this.shuffleOrder.indexOf(currentIdx);
      if (posInShuffle > 0) {
        [this.shuffleOrder[0], this.shuffleOrder[posInShuffle]] = [this.shuffleOrder[posInShuffle], this.shuffleOrder[0]];
      }
    }

    this.shufflePosition = 0;
  }

  /**
   * Generates a unique ID for a playlist item.
   * Combines timestamp with random string for uniqueness.
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /** Broadcasts full playlist state to all clients */
  private broadcastPlaylistUpdate(): void {
    this.sse.broadcast('playlist:updated', this.getState());
  }

  /** Broadcasts current selection change to all clients */
  private broadcastSelectionChange(): void {
    this.sse.broadcast('playlist:selection', {
      currentIndex: this.currentIndex,
      currentItem: this.getCurrentItem(),
    });
  }

  /** Updates duration for all playlist items matching a file path. */
  public updateItemDurations(filePath: string, duration: number): void {
    let updated: boolean = false;
    this.items = this.items.map((item: PlaylistItem): PlaylistItem => {
      if (item.filePath === filePath && Math.abs(item.duration - duration) > 1) {
        updated = true;
        return {...item, duration};
      }
      return item;
    });

    if (updated) {
      this.sse.broadcast('playlist:items:duration', {filePath, duration});
    }
  }

  /** Broadcasts shuffle/repeat mode change to all clients */
  private broadcastModeChange(): void {
    this.sse.broadcast('playlist:mode', {
      shuffleEnabled: this.shuffleEnabled,
      repeatEnabled: this.repeatEnabled,
    });
    this.onModeChange?.(this.shuffleEnabled, this.repeatEnabled);
  }
}
