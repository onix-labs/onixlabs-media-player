/**
 * @fileoverview Unit tests for MediaPlayerService.
 *
 * Tests cover computed signals, formatTime utility, playback controls,
 * volume control, track navigation, and playlist management.
 *
 * Dependencies (ElectronService, SettingsService, DependencyService) are
 * fully mocked with writable signals and vi.fn() stubs.
 *
 * @module app/services/media-player.service.spec
 */

import {TestBed} from '@angular/core/testing';
import {signal, WritableSignal} from '@angular/core';
import {MediaPlayerService, PlaybackState} from './media-player.service';
import {ElectronService} from './electron.service';
import {SettingsService} from './settings.service';
import {DependencyService} from './dependency.service';
import type {MediaInfo, PlaylistItem, PlaylistState} from '../types/electron';

// ============================================================================
// Mock Factories
// ============================================================================

/**
 * Creates a mock ElectronService with writable signals and vi.fn() stubs.
 */
function createMockElectronService(): Record<string, WritableSignal<unknown> | ReturnType<typeof vi.fn>> {
  return {
    playbackState: signal<string>('idle'),
    currentTime: signal<number>(0),
    duration: signal<number>(0),
    volume: signal<number>(1),
    muted: signal<boolean>(false),
    serverUrl: signal<string>('http://127.0.0.1:12345'),
    errorMessage: signal<string | null>(null),
    currentMedia: signal<MediaInfo | null>(null),
    playlist: signal<PlaylistState>({
      items: [],
      currentIndex: -1,
      shuffleEnabled: false,
      repeatEnabled: false,
    }),
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn().mockResolvedValue(undefined),
    setVolume: vi.fn().mockResolvedValue(undefined),
    nextTrack: vi.fn().mockResolvedValue(undefined),
    previousTrack: vi.fn().mockResolvedValue(undefined),
    selectTrack: vi.fn().mockResolvedValue(undefined),
    removeFromPlaylist: vi.fn().mockResolvedValue(undefined),
    clearPlaylist: vi.fn().mockResolvedValue(undefined),
    setShuffle: vi.fn().mockResolvedValue(undefined),
    setRepeat: vi.fn().mockResolvedValue(undefined),
    openFileDialog: vi.fn().mockResolvedValue([]),
    addToPlaylist: vi.fn().mockResolvedValue({added: []}),
    getPathForFile: vi.fn().mockReturnValue('/path/to/file'),
    onSettingsUpdate: vi.fn(),
    onDependencyStateUpdate: vi.fn(),
    onDependencyProgressUpdate: vi.fn(),
  };
}

/**
 * Creates a mock SettingsService with writable signals.
 */
function createMockSettingsService(): Record<string, WritableSignal<unknown>> {
  return {
    isLoaded: signal<boolean>(true),
    defaultVolume: signal<number>(0.5),
    previousTrackThreshold: signal<number>(3),
    skipDuration: signal<number>(10),
    settings: signal<Record<string, unknown>>({}),
    defaultVisualization: signal<string>('bars'),
    crossfadeDuration: signal<number>(100),
    fftSize: signal<number>(2048),
    videoAspectMode: signal<string>('default'),
    perVisualizationSettings: signal<Record<string, unknown>>({}),
  };
}

/**
 * Creates a mock DependencyService with writable signals.
 */
function createMockDependencyService(): Record<string, WritableSignal<unknown>> {
  return {
    ffmpegInstalled: signal<boolean>(true),
    fluidsynthInstalled: signal<boolean>(true),
    noDependenciesInstalled: signal<boolean>(false),
    allowedExtensions: signal<ReadonlySet<string>>(new Set(['.mp3', '.mp4'])),
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

describe('MediaPlayerService', (): void => {
  let service: MediaPlayerService;
  let mockElectron: ReturnType<typeof createMockElectronService>;
  let mockSettings: ReturnType<typeof createMockSettingsService>;
  let mockDeps: ReturnType<typeof createMockDependencyService>;

  beforeEach((): void => {
    mockElectron = createMockElectronService();
    mockSettings = createMockSettingsService();
    mockDeps = createMockDependencyService();

    TestBed.configureTestingModule({
      providers: [
        MediaPlayerService,
        {provide: ElectronService, useValue: mockElectron},
        {provide: SettingsService, useValue: mockSettings},
        {provide: DependencyService, useValue: mockDeps},
      ],
    });

    service = TestBed.inject(MediaPlayerService);
  });

  // ==========================================================================
  // Computed Signals
  // ==========================================================================

  describe('computed signals', (): void => {
    it('should return null for currentTrack when playlist is empty', (): void => {
      const result: PlaylistItem | null = service.currentTrack();
      expect(result).toBeNull();
    });

    it('should return the correct item by currentIndex for currentTrack', (): void => {
      const items: PlaylistItem[] = [
        createPlaylistItem('a', 'Track A'),
        createPlaylistItem('b', 'Track B'),
        createPlaylistItem('c', 'Track C'),
      ];
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items,
        currentIndex: 1,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      const result: PlaylistItem | null = service.currentTrack();
      expect(result).not.toBeNull();
      expect(result!.id).toBe('b');
      expect(result!.title).toBe('Track B');
    });

    it('should return null for currentTrack when currentIndex is out of bounds', (): void => {
      const items: PlaylistItem[] = [createPlaylistItem('a', 'Track A')];
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items,
        currentIndex: 5,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      const result: PlaylistItem | null = service.currentTrack();
      expect(result).toBeNull();
    });

    it('should return true for isPlaying when state is playing', (): void => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('playing');

      const result: boolean = service.isPlaying();
      expect(result).toBe(true);
    });

    it('should return false for isPlaying when state is not playing', (): void => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('paused');

      const result: boolean = service.isPlaying();
      expect(result).toBe(false);
    });

    it('should return true for isPaused when state is paused', (): void => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('paused');

      const result: boolean = service.isPaused();
      expect(result).toBe(true);
    });

    it('should return false for isPaused when state is not paused', (): void => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('playing');

      const result: boolean = service.isPaused();
      expect(result).toBe(false);
    });

    it('should return true for isLoading when state is loading', (): void => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('loading');

      const result: boolean = service.isLoading();
      expect(result).toBe(true);
    });

    it('should return false for isLoading when state is not loading', (): void => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('idle');

      const result: boolean = service.isLoading();
      expect(result).toBe(false);
    });

    it('should return 0 for progress when duration is 0', (): void => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(10);
      (mockElectron['duration'] as WritableSignal<number>).set(0);

      const result: number = service.progress();
      expect(result).toBe(0);
    });

    it('should return the correct percentage for progress', (): void => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(30);
      (mockElectron['duration'] as WritableSignal<number>).set(120);

      const result: number = service.progress();
      expect(result).toBe(25);
    });

    it('should return true for isEmpty when no items exist', (): void => {
      const result: boolean = service.isEmpty();
      expect(result).toBe(true);
    });

    it('should return false for isEmpty when items exist', (): void => {
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [createPlaylistItem('a', 'Track A')],
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      const result: boolean = service.isEmpty();
      expect(result).toBe(false);
    });

    it('should return the correct item count for playlistCount', (): void => {
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [
          createPlaylistItem('a', 'Track A'),
          createPlaylistItem('b', 'Track B'),
          createPlaylistItem('c', 'Track C'),
        ],
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      const result: number = service.playlistCount();
      expect(result).toBe(3);
    });
  });

  // ==========================================================================
  // formatTime
  // ==========================================================================

  describe('formatTime', (): void => {
    it('should format 0 as "0:00"', (): void => {
      const result: string = service.formatTime(0);
      expect(result).toBe('0:00');
    });

    it('should format 61 as "1:01"', (): void => {
      const result: string = service.formatTime(61);
      expect(result).toBe('1:01');
    });

    it('should format 3661 as "61:01"', (): void => {
      const result: string = service.formatTime(3661);
      expect(result).toBe('61:01');
    });

    it('should handle NaN gracefully by returning "0:00"', (): void => {
      const result: string = service.formatTime(NaN);
      expect(result).toBe('0:00');
    });

    it('should handle Infinity gracefully by returning "0:00"', (): void => {
      const result: string = service.formatTime(Infinity);
      expect(result).toBe('0:00');
    });

    it('should handle negative Infinity gracefully by returning "0:00"', (): void => {
      const result: string = service.formatTime(-Infinity);
      expect(result).toBe('0:00');
    });

    it('should handle negative numbers gracefully by returning "0:00"', (): void => {
      const result: string = service.formatTime(-5);
      expect(result).toBe('0:00');
    });

    it('should format 125 as "2:05"', (): void => {
      const result: string = service.formatTime(125);
      expect(result).toBe('2:05');
    });

    it('should format fractional seconds by flooring', (): void => {
      const result: string = service.formatTime(65.9);
      expect(result).toBe('1:05');
    });
  });

  // ==========================================================================
  // Playback Control
  // ==========================================================================

  describe('playback control', (): void => {
    it('should call pause when togglePlayPause is invoked while playing', async (): Promise<void> => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('playing');

      await service.togglePlayPause();

      expect(mockElectron['pause']).toHaveBeenCalled();
      expect(mockElectron['play']).not.toHaveBeenCalled();
    });

    it('should call play when togglePlayPause is invoked while paused', async (): Promise<void> => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('paused');

      await service.togglePlayPause();

      expect(mockElectron['play']).toHaveBeenCalled();
      expect(mockElectron['pause']).not.toHaveBeenCalled();
    });

    it('should call play when togglePlayPause is invoked while idle', async (): Promise<void> => {
      (mockElectron['playbackState'] as WritableSignal<string>).set('idle');

      await service.togglePlayPause();

      expect(mockElectron['play']).toHaveBeenCalled();
      expect(mockElectron['pause']).not.toHaveBeenCalled();
    });

    it('should clamp seek time to valid range (lower bound)', async (): Promise<void> => {
      (mockElectron['duration'] as WritableSignal<number>).set(100);

      await service.seek(-10);

      expect(mockElectron['seek']).toHaveBeenCalledWith(0);
    });

    it('should clamp seek time to valid range (upper bound)', async (): Promise<void> => {
      (mockElectron['duration'] as WritableSignal<number>).set(100);

      await service.seek(150);

      expect(mockElectron['seek']).toHaveBeenCalledWith(100);
    });

    it('should pass through a valid seek time within range', async (): Promise<void> => {
      (mockElectron['duration'] as WritableSignal<number>).set(100);

      await service.seek(50);

      expect(mockElectron['seek']).toHaveBeenCalledWith(50);
    });

    it('should convert percentage to time for seekToProgress', async (): Promise<void> => {
      (mockElectron['duration'] as WritableSignal<number>).set(200);

      await service.seekToProgress(50);

      expect(mockElectron['seek']).toHaveBeenCalledWith(100);
    });

    it('should add skip duration to current time for skipForward', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(30);
      (mockElectron['duration'] as WritableSignal<number>).set(200);
      (mockSettings['skipDuration'] as WritableSignal<number>).set(10);

      await service.skipForward();

      // skipForward: Math.min(30 + 10, 200) = 40, then seek clamps to Math.max(0, Math.min(40, 200)) = 40
      expect(mockElectron['seek']).toHaveBeenCalledWith(40);
    });

    it('should clamp skipForward to duration', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(95);
      (mockElectron['duration'] as WritableSignal<number>).set(100);
      (mockSettings['skipDuration'] as WritableSignal<number>).set(10);

      await service.skipForward();

      // skipForward: Math.min(95 + 10, 100) = 100, then seek(100) -> clamped to 100
      expect(mockElectron['seek']).toHaveBeenCalledWith(100);
    });

    it('should subtract skip duration from current time for skipBackward', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(30);
      (mockElectron['duration'] as WritableSignal<number>).set(200);
      (mockSettings['skipDuration'] as WritableSignal<number>).set(10);

      await service.skipBackward();

      // skipBackward: Math.max(30 - 10, 0) = 20, then seek(20) -> clamped to 20
      expect(mockElectron['seek']).toHaveBeenCalledWith(20);
    });

    it('should clamp skipBackward to 0', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(3);
      (mockElectron['duration'] as WritableSignal<number>).set(200);
      (mockSettings['skipDuration'] as WritableSignal<number>).set(10);

      await service.skipBackward();

      // skipBackward: Math.max(3 - 10, 0) = 0, then seek(0) -> clamped to 0
      expect(mockElectron['seek']).toHaveBeenCalledWith(0);
    });
  });

  // ==========================================================================
  // Volume Control
  // ==========================================================================

  describe('volume control', (): void => {
    it('should normalize volume to 0-1 range (clamp above 1)', async (): Promise<void> => {
      await service.setVolume(1.5);

      expect(mockElectron['setVolume']).toHaveBeenCalledWith(1);
    });

    it('should normalize volume to 0-1 range (clamp below 0)', async (): Promise<void> => {
      await service.setVolume(-0.5);

      expect(mockElectron['setVolume']).toHaveBeenCalledWith(0);
    });

    it('should pass through a valid volume value', async (): Promise<void> => {
      await service.setVolume(0.7);

      expect(mockElectron['setVolume']).toHaveBeenCalledWith(0.7);
    });

    it('should toggle muted state from false to true', async (): Promise<void> => {
      (mockElectron['volume'] as WritableSignal<number>).set(0.8);
      (mockElectron['muted'] as WritableSignal<boolean>).set(false);

      await service.toggleMute();

      expect(mockElectron['setVolume']).toHaveBeenCalledWith(0.8, true);
    });

    it('should toggle muted state from true to false', async (): Promise<void> => {
      (mockElectron['volume'] as WritableSignal<number>).set(0.8);
      (mockElectron['muted'] as WritableSignal<boolean>).set(true);

      await service.toggleMute();

      expect(mockElectron['setVolume']).toHaveBeenCalledWith(0.8, false);
    });
  });

  // ==========================================================================
  // Track Navigation
  // ==========================================================================

  describe('track navigation', (): void => {
    it('should restart track when past threshold for previous', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(5);
      (mockElectron['duration'] as WritableSignal<number>).set(200);
      (mockSettings['previousTrackThreshold'] as WritableSignal<number>).set(3);

      await service.previous();

      // Past threshold (5 > 3), so should seek to 0 instead of going to previous track
      expect(mockElectron['seek']).toHaveBeenCalledWith(0);
      expect(mockElectron['previousTrack']).not.toHaveBeenCalled();
    });

    it('should go to previous track when before threshold for previous', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(2);
      (mockElectron['duration'] as WritableSignal<number>).set(200);
      (mockSettings['previousTrackThreshold'] as WritableSignal<number>).set(3);

      await service.previous();

      // Before threshold (2 <= 3), so should go to previous track
      expect(mockElectron['previousTrack']).toHaveBeenCalled();
      expect(mockElectron['seek']).not.toHaveBeenCalled();
    });

    it('should always go to previous track when threshold is 0', async (): Promise<void> => {
      (mockElectron['currentTime'] as WritableSignal<number>).set(100);
      (mockElectron['duration'] as WritableSignal<number>).set(200);
      (mockSettings['previousTrackThreshold'] as WritableSignal<number>).set(0);

      await service.previous();

      // Threshold is 0, so always go to previous track regardless of currentTime
      expect(mockElectron['previousTrack']).toHaveBeenCalled();
      expect(mockElectron['seek']).not.toHaveBeenCalled();
    });

    it('should call nextTrack for next', async (): Promise<void> => {
      await service.next();

      expect(mockElectron['nextTrack']).toHaveBeenCalled();
    });

    it('should select the correct item for selectTrackByIndex', async (): Promise<void> => {
      const items: PlaylistItem[] = [
        createPlaylistItem('a', 'Track A'),
        createPlaylistItem('b', 'Track B'),
        createPlaylistItem('c', 'Track C'),
      ];
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items,
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      await service.selectTrackByIndex(1);

      expect(mockElectron['selectTrack']).toHaveBeenCalledWith('b');
    });

    it('should do nothing for selectTrackByIndex with negative index', async (): Promise<void> => {
      const items: PlaylistItem[] = [
        createPlaylistItem('a', 'Track A'),
      ];
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items,
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      await service.selectTrackByIndex(-1);

      expect(mockElectron['selectTrack']).not.toHaveBeenCalled();
    });

    it('should do nothing for selectTrackByIndex with out-of-bounds index', async (): Promise<void> => {
      const items: PlaylistItem[] = [
        createPlaylistItem('a', 'Track A'),
      ];
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items,
        currentIndex: 0,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      await service.selectTrackByIndex(5);

      expect(mockElectron['selectTrack']).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Playlist Management
  // ==========================================================================

  describe('playlist management', (): void => {
    it('should enable shuffle when currently disabled via toggleShuffle', async (): Promise<void> => {
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [],
        currentIndex: -1,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      await service.toggleShuffle();

      expect(mockElectron['setShuffle']).toHaveBeenCalledWith(true);
    });

    it('should disable shuffle when currently enabled via toggleShuffle', async (): Promise<void> => {
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [],
        currentIndex: -1,
        shuffleEnabled: true,
        repeatEnabled: false,
      });

      await service.toggleShuffle();

      expect(mockElectron['setShuffle']).toHaveBeenCalledWith(false);
    });

    it('should enable repeat when currently disabled via toggleRepeat', async (): Promise<void> => {
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [],
        currentIndex: -1,
        shuffleEnabled: false,
        repeatEnabled: false,
      });

      await service.toggleRepeat();

      expect(mockElectron['setRepeat']).toHaveBeenCalledWith(true);
    });

    it('should disable repeat when currently enabled via toggleRepeat', async (): Promise<void> => {
      (mockElectron['playlist'] as WritableSignal<PlaylistState>).set({
        items: [],
        currentIndex: -1,
        shuffleEnabled: false,
        repeatEnabled: true,
      });

      await service.toggleRepeat();

      expect(mockElectron['setRepeat']).toHaveBeenCalledWith(false);
    });

    it('should delegate to electron clearPlaylist', async (): Promise<void> => {
      await service.clearPlaylist();

      expect(mockElectron['clearPlaylist']).toHaveBeenCalled();
    });

    it('should delegate to electron removeFromPlaylist', async (): Promise<void> => {
      await service.removeTrack('track-id-123');

      expect(mockElectron['removeFromPlaylist']).toHaveBeenCalledWith('track-id-123');
    });

    it('should delegate to electron selectTrack', async (): Promise<void> => {
      await service.selectTrack('track-id-456');

      expect(mockElectron['selectTrack']).toHaveBeenCalledWith('track-id-456');
    });
  });
});
