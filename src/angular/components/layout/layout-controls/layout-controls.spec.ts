/**
 * @fileoverview Unit tests for LayoutControls component.
 *
 * Tests cover:
 * - Component creation
 * - Computed signal values (canOpenFiles, isPlaying, progress, volume, hasTrack,
 *   currentTime, totalDuration, trackTitle, canSkipBackward, canSkipForward,
 *   backwardIcon, forwardIcon, playPauseIcon)
 * - Event handlers (onEject, onShuffle, onRepeat, onBackward, onPlayPause,
 *   onForward, onMuteToggle, onVolumeChange, onToggleFullscreen,
 *   onEnterMiniplayer, onProgressMouseDown)
 * - Shift key state tracking for icon and behavior changes
 *
 * Dependencies (MediaPlayerService, ElectronService, DependencyService) are
 * fully mocked with writable signals and vi.fn() stubs.
 *
 * @module app/components/layout/layout-controls.spec
 */

import {signal, WritableSignal} from '@angular/core';
import {ComponentFixture, TestBed} from '@angular/core/testing';
import {NO_ERRORS_SCHEMA} from '@angular/core';
import {LayoutControls} from './layout-controls';
import {MediaPlayerService} from '../../../services/media-player.service';
import {ElectronService} from '../../../services/electron.service';
import {DependencyService} from '../../../services/dependency.service';
import type {PlaylistItem, PlaylistState} from '../../../types/electron';

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
    progress: signal(0),
    currentVolume: signal(1),
    isMuted: signal(false),
    isShuffleEnabled: signal(false),
    isRepeatEnabled: signal(false),
    time: signal(0),
    totalDuration: signal(0),
    playlistCount: signal(0),
    formatTime: vi.fn((seconds: number): string => {
      const m: number = Math.floor(seconds / 60);
      const s: number = Math.floor(seconds % 60);
      return `${m}:${s.toString().padStart(2, '0')}`;
    }),
    playbackState: signal('idle'),
    eject: vi.fn().mockResolvedValue(undefined),
    toggleShuffle: vi.fn().mockResolvedValue(undefined),
    toggleRepeat: vi.fn().mockResolvedValue(undefined),
    previous: vi.fn().mockResolvedValue(undefined),
    next: vi.fn().mockResolvedValue(undefined),
    skipBackward: vi.fn().mockResolvedValue(undefined),
    skipForward: vi.fn().mockResolvedValue(undefined),
    togglePlayPause: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn().mockResolvedValue(undefined),
    toggleMute: vi.fn().mockResolvedValue(undefined),
    seekToProgress: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock ElectronService with writable signals and vi.fn() stubs.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    playlist: signal<PlaylistState>({
      items: [],
      currentIndex: -1,
      shuffleEnabled: false,
      repeatEnabled: false,
    }),
    toggleFullscreen: vi.fn().mockResolvedValue(undefined),
    enterMiniplayer: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Creates a mock DependencyService with writable signals.
 */
function createMockDependencyService(): Record<string, unknown> {
  return {
    noDependenciesInstalled: signal(false),
  };
}

/**
 * Helper to create a PlaylistItem for testing.
 */
function createPlaylistItem(id: string, title: string, artist?: string): PlaylistItem {
  return {
    id,
    filePath: `/music/${title}.mp3`,
    title,
    artist,
    duration: 180,
    type: 'audio',
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('LayoutControls', (): void => {
  let component: LayoutControls;
  let fixture: ComponentFixture<LayoutControls>;
  let mockMediaPlayer: ReturnType<typeof createMockMediaPlayerService>;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;

  beforeEach(async (): Promise<void> => {
    mockMediaPlayer = createMockMediaPlayerService();
    mockElectron = createMockElectronService();
    mockDeps = createMockDependencyService();

    await TestBed.configureTestingModule({
      imports: [LayoutControls],
      providers: [
        {provide: MediaPlayerService, useValue: mockMediaPlayer},
        {provide: ElectronService, useValue: mockElectron},
        {provide: DependencyService, useValue: mockDeps},
      ],
      schemas: [NO_ERRORS_SCHEMA],
    }).compileComponents();

    fixture = TestBed.createComponent(LayoutControls);
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
  // Computed Signals - canOpenFiles
  // ==========================================================================

  describe('canOpenFiles', (): void => {
    it('should return true when dependencies are installed', (): void => {
      (mockDeps['noDependenciesInstalled'] as WritableSignal<boolean>).set(false);
      const result: boolean = component.canOpenFiles();
      expect(result).toBe(true);
    });

    it('should return false when no dependencies are installed', (): void => {
      (mockDeps['noDependenciesInstalled'] as WritableSignal<boolean>).set(true);
      const result: boolean = component.canOpenFiles();
      expect(result).toBe(false);
    });
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
  });

  describe('progress', (): void => {
    it('should reflect media player progress', (): void => {
      (mockMediaPlayer['progress'] as WritableSignal<number>).set(42.5);
      const result: number = component.progress();
      expect(result).toBe(42.5);
    });
  });

  describe('volume', (): void => {
    it('should compute volume as percentage (0-100)', (): void => {
      (mockMediaPlayer['currentVolume'] as WritableSignal<number>).set(0.75);
      const result: number = component.volume();
      expect(result).toBe(75);
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
  // Computed Signals - Time Display
  // ==========================================================================

  describe('currentTime', (): void => {
    it('should format time correctly', (): void => {
      (mockMediaPlayer['time'] as WritableSignal<number>).set(125);
      const result: string = component.currentTime();
      expect(result).toBe('2:05');
      expect(mockMediaPlayer['formatTime']).toHaveBeenCalledWith(125);
    });
  });

  describe('totalDuration', (): void => {
    it('should format total duration correctly', (): void => {
      (mockMediaPlayer['totalDuration'] as WritableSignal<number>).set(240);
      const result: string = component.totalDuration();
      expect(result).toBe('4:00');
      expect(mockMediaPlayer['formatTime']).toHaveBeenCalledWith(240);
    });
  });

  // ==========================================================================
  // Computed Signals - Track Title
  // ==========================================================================

  describe('trackTitle', (): void => {
    it('should return "Artist - Title" when artist is present', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'My Song', 'Test Artist')
      );
      const result: string = component.trackTitle();
      expect(result).toBe('Test Artist - My Song');
    });

    it('should return just title when no artist', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(
        createPlaylistItem('t1', 'Solo Track')
      );
      const result: string = component.trackTitle();
      expect(result).toBe('Solo Track');
    });

    it('should return empty string when no track', (): void => {
      (mockMediaPlayer['currentTrack'] as WritableSignal<PlaylistItem | null>).set(null);
      const result: string = component.trackTitle();
      expect(result).toBe('');
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
  // Event Handlers - Playlist Modes
  // ==========================================================================

  describe('onShuffle', (): void => {
    it('should call toggleShuffle', async (): Promise<void> => {
      await component.onShuffle();
      expect(mockMediaPlayer['toggleShuffle']).toHaveBeenCalled();
    });
  });

  describe('onRepeat', (): void => {
    it('should call toggleRepeat', async (): Promise<void> => {
      await component.onRepeat();
      expect(mockMediaPlayer['toggleRepeat']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - File Operations
  // ==========================================================================

  describe('onEject', (): void => {
    it('should call eject', async (): Promise<void> => {
      await component.onEject();
      expect(mockMediaPlayer['eject']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - Volume Control
  // ==========================================================================

  describe('onMuteToggle', (): void => {
    it('should call toggleMute', async (): Promise<void> => {
      await component.onMuteToggle();
      expect(mockMediaPlayer['toggleMute']).toHaveBeenCalled();
    });
  });

  describe('onVolumeChange', (): void => {
    it('should call setVolume with normalized value', async (): Promise<void> => {
      const input: HTMLInputElement = document.createElement('input');
      input.value = '75';
      const event: Event = new Event('input');
      Object.defineProperty(event, 'target', {value: input, writable: false});
      await component.onVolumeChange(event);
      expect(mockMediaPlayer['setVolume']).toHaveBeenCalledWith(0.75);
    });
  });

  // ==========================================================================
  // Event Handlers - Window Control
  // ==========================================================================

  describe('onToggleFullscreen', (): void => {
    it('should call toggleFullscreen on electron service', async (): Promise<void> => {
      await component.onToggleFullscreen();
      expect(mockElectron['toggleFullscreen']).toHaveBeenCalled();
    });
  });

  describe('onEnterMiniplayer', (): void => {
    it('should call enterMiniplayer on electron service', async (): Promise<void> => {
      await component.onEnterMiniplayer();
      expect(mockElectron['enterMiniplayer']).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Event Handlers - Seek Control
  // ==========================================================================

  describe('onProgressMouseDown', (): void => {
    it('should call seekToProgress with calculated percentage on mousedown', (): void => {
      const target: HTMLProgressElement = document.createElement('progress');
      Object.defineProperty(target, 'getBoundingClientRect', {
        value: (): DOMRect => ({
          left: 0,
          width: 200,
          top: 0,
          right: 200,
          bottom: 10,
          height: 10,
          x: 0,
          y: 0,
          toJSON: (): void => {},
        }),
      });
      const event: MouseEvent = new MouseEvent('mousedown', {clientX: 100});
      Object.defineProperty(event, 'currentTarget', {value: target, writable: false});
      component.onProgressMouseDown(event);
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledWith(50);
    });

    it('should clamp percentage to 0-100 range', (): void => {
      const target: HTMLProgressElement = document.createElement('progress');
      Object.defineProperty(target, 'getBoundingClientRect', {
        value: (): DOMRect => ({
          left: 100,
          width: 200,
          top: 0,
          right: 300,
          bottom: 10,
          height: 10,
          x: 100,
          y: 0,
          toJSON: (): void => {},
        }),
      });

      // Click before the progress bar (should clamp to 0)
      const eventBefore: MouseEvent = new MouseEvent('mousedown', {clientX: 50});
      Object.defineProperty(eventBefore, 'currentTarget', {value: target, writable: false});
      component.onProgressMouseDown(eventBefore);
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledWith(0);

      // Click after the progress bar (should clamp to 100)
      const eventAfter: MouseEvent = new MouseEvent('mousedown', {clientX: 400});
      Object.defineProperty(eventAfter, 'currentTarget', {value: target, writable: false});
      component.onProgressMouseDown(eventAfter);
      expect(mockMediaPlayer['seekToProgress']).toHaveBeenCalledWith(100);
    });
  });

  // ==========================================================================
  // Keyboard Event Listeners
  // ==========================================================================

  describe('keyboard events', (): void => {
    it('should track shift key press and release', (): void => {
      // Shift pressed: icons should change when track is loaded
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
