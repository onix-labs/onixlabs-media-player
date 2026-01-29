/**
 * @fileoverview Unit tests for Playlist component.
 *
 * Tests reactive signal state, computed signal derivations, visibility
 * control, track actions, utility methods, and drag-and-drop handlers
 * using mock services for MediaPlayerService, ElectronService, and
 * FileDropService.
 *
 * @module app/components/playlist/playlist.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal, NO_ERRORS_SCHEMA} from '@angular/core';
import {Playlist} from './playlist';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService} from '../../services/electron.service';
import {FileDropService} from '../../services/file-drop.service';
import type {PlaylistItem} from '../../types/electron';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a PlaylistItem with sensible defaults for testing.
 *
 * @param overrides - Partial PlaylistItem fields to override
 * @returns A complete PlaylistItem
 */
function createPlaylistItem(overrides: Partial<PlaylistItem> = {}): PlaylistItem {
  return {
    id: 'test-id-1',
    filePath: '/music/song.mp3',
    title: 'Test Song',
    duration: 180,
    type: 'audio',
    ...overrides,
  };
}

/**
 * Creates a mock DragEvent with configurable preventDefault and stopPropagation.
 *
 * @returns A DragEvent-shaped object for testing
 */
function createDragEvent(): DragEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    dataTransfer: {files: {length: 0} as FileList},
  } as unknown as DragEvent;
}

/**
 * Creates a mock Event with a stopPropagation stub.
 *
 * @returns An Event-shaped object for testing
 */
function createEvent(): Event {
  return {
    stopPropagation: vi.fn(),
  } as unknown as Event;
}

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock MediaPlayerService with controllable signals and stub methods.
 */
function createMockMediaPlayerService(): Record<string, unknown> {
  return {
    currentMediaType: signal(null as 'audio' | 'video' | null),
    isPlaying: signal(false),
    isPaused: signal(false),
    isLoading: signal(false),
    currentTrack: signal(null),
    playlistItems: signal([]),
    playlistCount: signal(0),
    playbackState: signal('idle'),
    selectTrack: vi.fn().mockResolvedValue(undefined),
    removeTrack: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    clearPlaylist: vi.fn().mockResolvedValue(undefined),
    formatTime: vi.fn((seconds: number): string => {
      const m: number = Math.floor(seconds / 60);
      const s: number = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }),
  };
}

/**
 * Creates a mock ElectronService with controllable signals and stub methods.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    viewMode: signal('desktop'),
    playlist: signal({items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false}),
    addFilesWithAutoPlay: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock FileDropService with a stub extractMediaFilePaths method.
 */
function createMockFileDropService(): Record<string, unknown> {
  return {
    extractMediaFilePaths: vi.fn().mockReturnValue([]),
    hasValidFiles: vi.fn().mockReturnValue(true),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Playlist', (): void => {
  let component: Playlist;
  let fixture: ComponentFixture<Playlist>;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockFileDrop: ReturnType<typeof createMockFileDropService>;

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockFileDrop = createMockFileDropService();

    await TestBed.configureTestingModule({
      imports: [Playlist],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: FileDropService, useValue: mockFileDrop},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(Playlist);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  // ==========================================================================
  // Creation
  // ==========================================================================

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });

  // ==========================================================================
  // Visibility Control
  // ==========================================================================

  describe('visibility control', (): void => {
    it('isVisible starts as false', (): void => {
      const result: boolean = component.isVisible();
      expect(result).toBe(false);
    });

    it('toggle flips visibility', (): void => {
      component.toggle();
      expect(component.isVisible()).toBe(true);

      component.toggle();
      expect(component.isVisible()).toBe(false);
    });

    it('show sets visible to true', (): void => {
      component.show();

      const result: boolean = component.isVisible();
      expect(result).toBe(true);
    });

    it('hide sets visible to false', (): void => {
      component.isVisible.set(true);

      component.hide();

      const result: boolean = component.isVisible();
      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // Computed Signals
  // ==========================================================================

  describe('computed signals', (): void => {
    it('items reflects media player playlist items', (): void => {
      const playlistItems: WritableSignal<PlaylistItem[]> = mockMediaPlayer['playlistItems'] as WritableSignal<PlaylistItem[]>;
      const item: PlaylistItem = createPlaylistItem();
      playlistItems.set([item]);

      const result: PlaylistItem[] = component.items();
      expect(result).toEqual([item]);
    });

    it('count reflects playlist count', (): void => {
      const playlistCount: WritableSignal<number> = mockMediaPlayer['playlistCount'] as WritableSignal<number>;
      playlistCount.set(5);

      const result: number = component.count();
      expect(result).toBe(5);
    });

    it('isPlaying reflects media player state', (): void => {
      const isPlaying: WritableSignal<boolean> = mockMediaPlayer['isPlaying'] as WritableSignal<boolean>;
      isPlaying.set(true);

      const result: boolean = component.isPlaying();
      expect(result).toBe(true);
    });

    it('isPaused reflects media player state', (): void => {
      const isPaused: WritableSignal<boolean> = mockMediaPlayer['isPaused'] as WritableSignal<boolean>;
      isPaused.set(true);

      const result: boolean = component.isPaused();
      expect(result).toBe(true);
    });

    it('isStopped true when playbackState is stopped', (): void => {
      const playbackState: WritableSignal<string> = mockMediaPlayer['playbackState'] as WritableSignal<string>;
      playbackState.set('stopped');

      const result: boolean = component.isStopped();
      expect(result).toBe(true);
    });

    it('isStopped false when playbackState is not stopped', (): void => {
      const playbackState: WritableSignal<string> = mockMediaPlayer['playbackState'] as WritableSignal<string>;
      playbackState.set('playing');

      const result: boolean = component.isStopped();
      expect(result).toBe(false);
    });

    it('currentTrack reflects media player current track', (): void => {
      const currentTrack: WritableSignal<PlaylistItem | null> = mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>;
      const item: PlaylistItem = createPlaylistItem({id: 'track-1'});
      currentTrack.set(item);

      const result: PlaylistItem | null = component.currentTrack();
      expect(result).toEqual(item);
    });
  });

  // ==========================================================================
  // Track Actions
  // ==========================================================================

  describe('track actions', (): void => {
    it('selectItem calls selectTrack with item id', async (): Promise<void> => {
      const item: PlaylistItem = createPlaylistItem({id: 'track-42'});

      await component.selectItem(item);

      expect(mockMediaPlayer['selectTrack']).toHaveBeenCalledWith('track-42');
    });

    it('removeItem stops propagation and calls removeTrack', (): void => {
      const event: Event = createEvent();
      const item: PlaylistItem = createPlaylistItem({id: 'track-99'});

      component.removeItem(event, item);

      expect(event.stopPropagation).toHaveBeenCalledOnce();
      expect(mockMediaPlayer['removeTrack']).toHaveBeenCalledWith('track-99');
    });

    it('clearPlaylist calls stop then clearPlaylist', async (): Promise<void> => {
      await component.clearPlaylist();

      expect(mockMediaPlayer['stop']).toHaveBeenCalledOnce();
      expect(mockMediaPlayer['clearPlaylist']).toHaveBeenCalledOnce();
    });
  });

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  describe('utility methods', (): void => {
    it('formatDuration delegates to formatTime', (): void => {
      const result: string = component.formatDuration(125);

      expect(mockMediaPlayer['formatTime']).toHaveBeenCalledWith(125);
      expect(result).toBe('2:05');
    });

    it('isCurrentItem returns true for matching item', (): void => {
      const currentTrack: WritableSignal<PlaylistItem | null> = mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>;
      const item: PlaylistItem = createPlaylistItem({id: 'track-match'});
      currentTrack.set(item);

      const result: boolean = component.isCurrentItem(item);
      expect(result).toBe(true);
    });

    it('isCurrentItem returns false for non-matching item', (): void => {
      const currentTrack: WritableSignal<PlaylistItem | null> = mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>;
      const currentItem: PlaylistItem = createPlaylistItem({id: 'track-current'});
      const otherItem: PlaylistItem = createPlaylistItem({id: 'track-other'});
      currentTrack.set(currentItem);

      const result: boolean = component.isCurrentItem(otherItem);
      expect(result).toBe(false);
    });

    it('isCurrentItem returns false when no current track', (): void => {
      const item: PlaylistItem = createPlaylistItem({id: 'track-1'});

      const result: boolean = component.isCurrentItem(item);
      expect(result).toBe(false);
    });

    it('trackByFn returns item id', (): void => {
      const item: PlaylistItem = createPlaylistItem({id: 'track-unique'});

      const result: string = component.trackByFn(0, item);
      expect(result).toBe('track-unique');
    });
  });

  // ==========================================================================
  // Drag and Drop
  // ==========================================================================

  describe('drag and drop', (): void => {
    it('isDragOver defaults to false', (): void => {
      const result: boolean = component.isDragOver();
      expect(result).toBe(false);
    });

    it('onDragOver sets isDragOver true', (): void => {
      const event: DragEvent = createDragEvent();

      component.onDragOver(event);

      expect(component.isDragOver()).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('onDragLeave sets isDragOver false', (): void => {
      component.isDragOver.set(true);
      const event: DragEvent = createDragEvent();

      component.onDragLeave(event);

      expect(component.isDragOver()).toBe(false);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('onDrop resets isDragOver and calls addFilesWithAutoPlay', async (): Promise<void> => {
      component.isDragOver.set(true);
      const event: DragEvent = createDragEvent();
      const filePaths: string[] = ['/music/song.mp3', '/music/video.mp4'];
      (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue(filePaths);

      await component.onDrop(event);

      expect(component.isDragOver()).toBe(false);
      expect(mockFileDrop['extractMediaFilePaths']).toHaveBeenCalledWith(event);
      expect(mockElectron['addFilesWithAutoPlay']).toHaveBeenCalledWith(filePaths);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it('onDrop does nothing for empty file paths', async (): Promise<void> => {
      component.isDragOver.set(true);
      const event: DragEvent = createDragEvent();
      (mockFileDrop['extractMediaFilePaths'] as ReturnType<typeof vi.fn>).mockReturnValue([]);

      await component.onDrop(event);

      expect(component.isDragOver()).toBe(false);
      expect(mockElectron['addFilesWithAutoPlay']).not.toHaveBeenCalled();
    });
  });
});
