/**
 * @fileoverview Unit tests for MiniplayerControls component.
 *
 * Tests cover:
 * - Component creation
 * - Computed signal values (isPlaying, hasTrack, canSkipBackward, canSkipForward,
 *   backwardIcon, forwardIcon, playPauseIcon)
 * - Event handlers (onBackward, onPlayPause, onForward, onExitMiniplayer)
 * - Shift key state tracking for icon and behavior changes
 *
 * Dependencies (MediaPlayerService, ElectronService) are fully mocked
 * with writable signals and vi.fn() stubs.
 *
 * @module app/components/miniplayer/miniplayer-controls.spec
 */

import {signal, WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NO_ERRORS_SCHEMA} from '@angular/core';
import {MiniplayerControls} from './miniplayer-controls';
import {MediaPlayerService} from '../../services/media-player.service';
import {ElectronService} from '../../services/electron.service';
import type {PlaylistItem, PlaylistState} from '../../types/electron';

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock MediaPlayerService with writable signals and vi.fn() stubs.
 */
function createMockMediaPlayerService(): Record<string, unknown> {
  return {
    isPlaying: signal(false),
    currentTrack: signal(null),
    playlistCount: signal(0),
    isRepeatEnabled: signal(false),
    playbackState: signal('idle'),
    previous: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    skipBackward: vi.fn().mockResolvedValue(undefined),
    skipForward: vi.fn().mockResolvedValue(undefined),
    togglePlayPause: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock ElectronService with writable signals and vi.fn() stubs.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    playlist: signal<PlaylistState>({
      items: [],
      currentIndex: -1,
      shuffleEnabled: false,
      repeatEnabled: false,
    }),
    exitMiniplayer: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Helper to create a PlaylistItem for testing.
 */
function createPlaylistItem(id: string, title: string): PlaylistItem {
  return {
    id,
    filePath: `/music/${title}.mp3`,
    title,
    duration: 180,
    type: 'audio',
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('MiniplayerControls', (): void => {
  let component: MiniplayerControls;
  let fixture: ComponentFixture<MiniplayerControls>;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();

    await TestBed.configureTestingModule({
      imports: [MiniplayerControls],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(MiniplayerControls);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  // ==========================================================================
  // Component Creation
  // ==========================================================================

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });

  // ==========================================================================
  // Computed Signals - Playback State
  // ==========================================================================

  describe('isPlaying', (): void => {
    it('should reflect media player playing state', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(true);
      const result: boolean = component.isPlaying();
      expect(result).toBe(true);
    });

    it('should return false when not playing', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(false);
      const result: boolean = component.isPlaying();
      expect(result).toBe(false);
    });
  });

  describe('hasTrack', (): void => {
    it('should return false when no track is loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(null);
      const result: boolean = component.hasTrack();
      expect(result).toBe(false);
    });

    it('should return true when a track is loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track One')
      );
      const result: boolean = component.hasTrack();
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Computed Signals - Skip Navigation
  // ==========================================================================

  describe('canSkipBackward', (): void => {
    it('should return true when playlist count is at least 1', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(1);
      const result: boolean = component.canSkipBackward();
      expect(result).toBe(true);
    });

    it('should return false when playlist is empty', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(0);
      const result: boolean = component.canSkipBackward();
      expect(result).toBe(false);
    });
  });

  describe('canSkipForward', (): void => {
    it('should return false when single track without shift or repeat', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(1);
      (mockMediaPlayer['isRepeatEnabled'] as WritableSignal<boolean>).set(false);
      const result: boolean = component.canSkipForward();
      expect(result).toBe(false);
    });

    it('should return true when shift is pressed', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(1);
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: boolean = component.canSkipForward();
      expect(result).toBe(true);
    });

    it('should return true when multiple tracks and not at end', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(3);
      (mockMediaPlayer['isRepeatEnabled'] as WritableSignal<boolean>).set(false);
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [
          createPlaylistItem('a', 'A'),
          createPlaylistItem('b', 'B'),
          createPlaylistItem('c', 'C'),
        ],
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });
      const result: boolean = component.canSkipForward();
      expect(result).toBe(true);
    });

    it('should return true when repeat is enabled', (): void => {
      (mockMediaPlayer['playlistCount'] as WritableSignal<number>).set(2);
      (mockMediaPlayer['isRepeatEnabled'] as WritableSignal<boolean>).set(true);
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [
          createPlaylistItem('a', 'A'),
          createPlaylistItem('b', 'B'),
        ],
        currentIndex: 1,
        shuffleEnabled: false,
        repeatEnabled: true,
      });
      const result: boolean = component.canSkipForward();
      expect(result).toBe(true);
    });
  });

  // ==========================================================================
  // Computed Signals - Icons
  // ==========================================================================

  describe('backwardIcon', (): void => {
    it('should show step icon by default', (): void => {
      const result: string = component.backwardIcon();
      expect(result).toBe('fa-solid fa-backward-step');
    });

    it('should show backward icon when shift pressed and track loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: string = component.backwardIcon();
      expect(result).toBe('fa-solid fa-backward');
    });
  });

  describe('forwardIcon', (): void => {
    it('should show step icon by default', (): void => {
      const result: string = component.forwardIcon();
      expect(result).toBe('fa-solid fa-forward-step');
    });

    it('should show forward icon when shift pressed and track loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: string = component.forwardIcon();
      expect(result).toBe('fa-solid fa-forward');
    });
  });

  describe('playPauseIcon', (): void => {
    it('should show play icon when not playing', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(false);
      const result: string = component.playPauseIcon();
      expect(result).toBe('fa-solid fa-play');
    });

    it('should show pause icon when playing', (): void => {
      (mockMediaPlayer['isPlaying'] as WritableSignal<boolean>).set(true);
      const result: string = component.playPauseIcon();
      expect(result).toBe('fa-solid fa-pause');
    });

    it('should show stop icon when shift pressed and track loaded', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );
      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      const result: string = component.playPauseIcon();
      expect(result).toBe('fa-solid fa-stop');
    });
  });

  // ==========================================================================
  // Event Handlers - Transport Controls
  // ==========================================================================

  describe('onBackward', (): void => {
    it('should call previous() without shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: false});
      await component.onBackward(event);
      expect(mockMediaPlayer['previous']).toHaveBeenCalled();
      expect(mockMediaPlayer['skipBackward']).not.toHaveBeenCalled();
    });

    it('should call skipBackward() with shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: true});
      await component.onBackward(event);
      expect(mockMediaPlayer['skipBackward']).toHaveBeenCalled();
      expect(mockMediaPlayer['previous']).not.toHaveBeenCalled();
    });
  });

  describe('onPlayPause', (): void => {
    it('should call togglePlayPause() without shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: false});
      await component.onPlayPause(event);
      expect(mockMediaPlayer['togglePlayPause']).toHaveBeenCalled();
      expect(mockMediaPlayer['stop']).not.toHaveBeenCalled();
    });

    it('should call stop() with shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: true});
      await component.onPlayPause(event);
      expect(mockMediaPlayer['stop']).toHaveBeenCalled();
      expect(mockMediaPlayer['togglePlayPause']).not.toHaveBeenCalled();
    });
  });

  describe('onForward', (): void => {
    it('should call next() without shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: false});
      await component.onForward(event);
      expect(mockMediaPlayer['next']).toHaveBeenCalled();
      expect(mockMediaPlayer['skipForward']).not.toHaveBeenCalled();
    });

    it('should call skipForward() with shift', async (): Promise<void> => {
      const event: MouseEvent = new MouseEvent('click', {shiftKey: true});
      await component.onForward(event);
      expect(mockMediaPlayer['skipForward']).toHaveBeenCalled();
      expect(mockMediaPlayer['next']).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - Window Control
  // ==========================================================================

  describe('onExitMiniplayer', (): void => {
    it('should call exitMiniplayer on electron service', async (): Promise<void> => {
      await component.onExitMiniplayer();
      expect(mockElectron['exitMiniplayer']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Keyboard Event Listeners
  // ==========================================================================

  describe('keyboard events', (): void => {
    it('should track shift key press and release', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );

      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Shift'}));
      expect(component.backwardIcon()).toBe('fa-solid fa-backward');

      component.onKeyUp(new KeyboardEvent('keyup', {key: 'Shift'}));
      expect(component.backwardIcon()).toBe('fa-solid fa-backward-step');
    });

    it('should ignore non-Shift key events', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Track')
      );

      component.onKeyDown(new KeyboardEvent('keydown', {key: 'Control'}));
      expect(component.backwardIcon()).toBe('fa-solid fa-backward-step');
    });
  });
});
