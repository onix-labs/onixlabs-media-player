import {Injectable, computed, signal} from '@angular/core';

export interface PlaylistItem {
  id: string;
  filePath: string;
  title: string;
  artist?: string;
  album?: string;
  duration: number;
  type: 'audio' | 'video';
}

@Injectable({providedIn: 'root'})
export class PlaylistService {
  private readonly items = signal<PlaylistItem[]>([]);
  private readonly currentIndex = signal<number>(-1);
  private readonly shuffleEnabled = signal<boolean>(false);
  private readonly repeatEnabled = signal<boolean>(false);

  // Shuffle state: stores the order of indices to play
  private shuffleOrder: number[] = [];
  private shufflePosition = 0;
  private playHistory: number[] = [];

  readonly playlist = computed(() => this.items());
  readonly currentItem = computed(() => {
    const idx = this.currentIndex();
    const list = this.items();
    return idx >= 0 && idx < list.length ? list[idx] : null;
  });
  readonly isShuffleEnabled = computed(() => this.shuffleEnabled());
  readonly isRepeatEnabled = computed(() => this.repeatEnabled());
  readonly hasNext = computed(() => this.canGoNext());
  readonly hasPrevious = computed(() => this.canGoPrevious());
  readonly isEmpty = computed(() => this.items().length === 0);
  readonly count = computed(() => this.items().length);
  readonly currentTrackIndex = computed(() => this.currentIndex());

  addItems(newItems: Omit<PlaylistItem, 'id'>[]): void {
    const itemsWithIds = newItems.map(item => ({
      ...item,
      id: this.generateId()
    }));

    this.items.update(current => [...current, ...itemsWithIds]);

    if (this.shuffleEnabled()) {
      this.regenerateShuffleOrder();
    }

    if (this.currentIndex() === -1 && this.items().length > 0) {
      this.currentIndex.set(0);
      if (this.shuffleEnabled()) {
        this.shufflePosition = this.shuffleOrder.indexOf(0);
      }
    }
  }

  removeItem(id: string): void {
    const idx = this.items().findIndex(item => item.id === id);
    if (idx === -1) return;

    const currentIdx = this.currentIndex();

    this.items.update(current => current.filter(item => item.id !== id));

    if (idx < currentIdx) {
      this.currentIndex.update(i => i - 1);
    } else if (idx === currentIdx) {
      const newLength = this.items().length;
      if (newLength === 0) {
        this.currentIndex.set(-1);
      } else if (currentIdx >= newLength) {
        this.currentIndex.set(newLength - 1);
      }
    }

    if (this.shuffleEnabled()) {
      this.regenerateShuffleOrder();
    }
  }

  clear(): void {
    this.items.set([]);
    this.currentIndex.set(-1);
    this.shuffleOrder = [];
    this.shufflePosition = 0;
    this.playHistory = [];
  }

  selectItem(id: string): boolean {
    const idx = this.items().findIndex(item => item.id === id);
    if (idx === -1) return false;

    this.currentIndex.set(idx);
    this.playHistory.push(idx);

    if (this.shuffleEnabled()) {
      this.shufflePosition = this.shuffleOrder.indexOf(idx);
    }

    return true;
  }

  selectIndex(index: number): boolean {
    if (index < 0 || index >= this.items().length) return false;

    this.currentIndex.set(index);
    this.playHistory.push(index);

    if (this.shuffleEnabled()) {
      this.shufflePosition = this.shuffleOrder.indexOf(index);
    }

    return true;
  }

  next(): PlaylistItem | null {
    if (this.items().length === 0) return null;

    // If repeat single is enabled, return current
    if (this.repeatEnabled() && !this.canGoNext()) {
      // Repeat the playlist from beginning
      if (this.shuffleEnabled()) {
        this.regenerateShuffleOrder();
        this.shufflePosition = 0;
        this.currentIndex.set(this.shuffleOrder[0]);
      } else {
        this.currentIndex.set(0);
      }
      this.playHistory.push(this.currentIndex());
      return this.currentItem();
    }

    if (!this.canGoNext()) return null;

    if (this.shuffleEnabled()) {
      this.shufflePosition++;
      this.currentIndex.set(this.shuffleOrder[this.shufflePosition]);
    } else {
      this.currentIndex.update(i => i + 1);
    }

    this.playHistory.push(this.currentIndex());
    return this.currentItem();
  }

  previous(): PlaylistItem | null {
    if (this.items().length === 0) return null;

    // Check play history first for true "back" behavior
    if (this.playHistory.length > 1) {
      this.playHistory.pop(); // Remove current
      const prevIdx = this.playHistory[this.playHistory.length - 1];
      if (prevIdx !== undefined && prevIdx >= 0 && prevIdx < this.items().length) {
        this.currentIndex.set(prevIdx);
        if (this.shuffleEnabled()) {
          this.shufflePosition = this.shuffleOrder.indexOf(prevIdx);
        }
        return this.currentItem();
      }
    }

    if (!this.canGoPrevious()) {
      if (this.repeatEnabled()) {
        // Go to end
        if (this.shuffleEnabled()) {
          this.shufflePosition = this.shuffleOrder.length - 1;
          this.currentIndex.set(this.shuffleOrder[this.shufflePosition]);
        } else {
          this.currentIndex.set(this.items().length - 1);
        }
        this.playHistory.push(this.currentIndex());
        return this.currentItem();
      }
      return null;
    }

    if (this.shuffleEnabled()) {
      this.shufflePosition--;
      this.currentIndex.set(this.shuffleOrder[this.shufflePosition]);
    } else {
      this.currentIndex.update(i => i - 1);
    }

    this.playHistory.push(this.currentIndex());
    return this.currentItem();
  }

  toggleShuffle(): void {
    this.shuffleEnabled.update(v => !v);

    if (this.shuffleEnabled()) {
      this.regenerateShuffleOrder();
      this.shufflePosition = this.shuffleOrder.indexOf(this.currentIndex());
      if (this.shufflePosition === -1) this.shufflePosition = 0;
    }

    this.playHistory = [this.currentIndex()];
  }

  toggleRepeat(): void {
    this.repeatEnabled.update(v => !v);
  }

  private canGoNext(): boolean {
    if (this.items().length === 0) return false;

    if (this.shuffleEnabled()) {
      return this.shufflePosition < this.shuffleOrder.length - 1;
    }

    return this.currentIndex() < this.items().length - 1;
  }

  private canGoPrevious(): boolean {
    if (this.items().length === 0) return false;

    if (this.shuffleEnabled()) {
      return this.shufflePosition > 0;
    }

    return this.currentIndex() > 0;
  }

  /**
   * Fisher-Yates shuffle algorithm
   * Ensures each item plays exactly once in random order
   */
  private regenerateShuffleOrder(): void {
    const length = this.items().length;
    if (length === 0) {
      this.shuffleOrder = [];
      return;
    }

    this.shuffleOrder = Array.from({length}, (_, i) => i);

    // Fisher-Yates shuffle
    for (let i = length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.shuffleOrder[i], this.shuffleOrder[j]] =
        [this.shuffleOrder[j], this.shuffleOrder[i]];
    }

    // Move current track to front so we don't skip it
    const currentIdx = this.currentIndex();
    if (currentIdx >= 0) {
      const posInShuffle = this.shuffleOrder.indexOf(currentIdx);
      if (posInShuffle > 0) {
        [this.shuffleOrder[0], this.shuffleOrder[posInShuffle]] =
          [this.shuffleOrder[posInShuffle], this.shuffleOrder[0]];
      }
    }

    this.shufflePosition = 0;
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }
}
