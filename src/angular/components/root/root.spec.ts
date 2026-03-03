/**
 * @fileoverview Unit tests for the Root component.
 *
 * Tests cover:
 * - Component creation
 * - Computed signals (isFullscreen, isMiniplayer, viewMode, isVideo, cursorHidden, showControls)
 * - Host bindings (fullscreenClass, miniplayerClass, cursorHiddenClass)
 * - Event listeners (Escape key, Tab key, mouse events for drag)
 * - Configuration mode (enter, exit, exit fullscreen/miniplayer first)
 * - About mode (enter, exit)
 * - Miniplayer mouse enter/leave for controls visibility
 * - ngOnDestroy cleanup
 *
 * All child components are ignored via NO_ERRORS_SCHEMA. Services are mocked
 * with writable signals so that reactive state can be manipulated in tests.
 *
 * @module app/components/root/root.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, WritableSignal, NO_ERRORS_SCHEMA} from '@angular/core';
import {Root} from './root';
import {ElectronService} from '../../services/electron.service';
import {MediaPlayerService} from '../../services/media-player.service';
import {SettingsService} from '../../services/settings.service';
import {DependencyService} from '../../services/dependency.service';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Creates a mock ElectronService with writable signals and vi.fn() methods.
 * All signals are writable so tests can manipulate reactive state.
 */
function createMockElectronService(): Record<string, unknown> {
  return {
    isFullscreen: signal(false),
    viewMode: signal('desktop' as 'desktop' | 'miniplayer' | 'fullscreen'),
    menuShowConfig: signal(0),
    menuOpenFile: signal(0),
    menuShowAbout: signal(0),
    menuShowHelp: signal(0),
    menuOpenPlaylist: signal(0),
    menuSavePlaylist: signal(0),
    menuSavePlaylistAs: signal(0),
    menuSelectAspectMode: signal(''),
    exitConfigurationModeRequested: signal(0),
    fadeOutRequested: signal(0),
    platformInfo: signal({platform: 'darwin', supportsGlass: false, systemTheme: 'dark' as const}),
    playlist: signal({items: [], currentIndex: -1, shuffleEnabled: false, repeatEnabled: false}),
    exitFullscreen: vi.fn().mockResolvedValue(undefined),
    exitMiniplayer: vi.fn().mockResolvedValue(undefined),
    openFileDialog: vi.fn().mockResolvedValue([]),
    addFilesWithAutoPlay: vi.fn().mockResolvedValue(undefined),
    setTrafficLightVisibility: vi.fn().mockResolvedValue(undefined),
    setConfigurationMode: vi.fn().mockResolvedValue(undefined),
    showConfigurationWindow: vi.fn().mockResolvedValue(undefined),
    getWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
    setWindowPosition: vi.fn().mockResolvedValue({x: 0, y: 0}),
    saveMiniplayerBounds: vi.fn().mockResolvedValue(undefined),
    openPlaylistDialog: vi.fn().mockResolvedValue(null),
    savePlaylistDialog: vi.fn().mockResolvedValue(null),
    savePlaylistToFile: vi.fn().mockResolvedValue(undefined),
    loadPlaylistFromFile: vi.fn().mockResolvedValue({count: 0, filePath: ''}),
    getPlaylistSourcePath: vi.fn().mockResolvedValue(null),
  };
}

/**
 * Creates a mock MediaPlayerService with writable signals.
 */
function createMockMediaPlayerService(): Record<string, unknown> {
  return {
    currentMediaType: signal(null as 'audio' | 'video' | null),
  };
}

/**
 * Creates a mock SettingsService with writable signals.
 */
function createMockSettingsService(): Record<string, unknown> {
  return {
    controlsAutoHideDelay: signal(5),
    glassEnabled: signal(true),
    backgroundColor: signal('#1e1e1e'),
    backgroundHue: signal(0),
    backgroundSaturation: signal(0),
    backgroundLightness: signal(12),
    windowTintHue: signal(0),
    windowTintSaturation: signal(0),
    windowTintLightness: signal(0),
    windowTintAlpha: signal(0),
    colorScheme: signal('system' as 'system' | 'dark' | 'light'),
  };
}

/**
 * Creates a mock DependencyService with writable signals.
 */
function createMockDependencyService(): Record<string, unknown> {
  return {
    noDependenciesInstalled: signal(false),
    ffmpegInstalled: signal(true),
    fluidsynthInstalled: signal(false),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('Root', (): void => {
  let component: Root;
  let fixture: ComponentFixture<Root>;
  let mockElectron: Record<string, unknown>;
  let mockMediaPlayer: Record<string, unknown>;
  let mockSettings: Record<string, unknown>;
  let mockDeps: Record<string, unknown>;

  beforeEach(async (): Promise<void> => {
    mockElectron = createMockElectronService();
    mockMediaPlayer = createMockMediaPlayerService();
    mockSettings = createMockSettingsService();
    mockDeps = createMockDependencyService();

    await TestBed.configureTestingModule({
      imports: [Root],
      schemas: [NO_ERRORS_SCHEMA],
    })
      .overrideComponent(Root, {
        set: {
          imports: [],
          schemas: [NO_ERRORS_SCHEMA],
        },
      })
      .overrideProvider(ElectronService, {useValue: mockElectron})
      .overrideProvider(MediaPlayerService, {useValue: mockMediaPlayer})
      .overrideProvider(SettingsService, {useValue: mockSettings})
      .overrideProvider(DependencyService, {useValue: mockDeps})
      .compileComponents();

    fixture = TestBed.createComponent(Root);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  afterEach((): void => {
    vi.restoreAllMocks();
  });

  // ============================================================================
  // Component Creation
  // ============================================================================

  describe('creation', (): void => {
    it('should create', (): void => {
      expect(component).toBeTruthy();
    });
  });

  // ============================================================================
  // Computed Signals
  // ============================================================================

  describe('computed signals', (): void => {
    it('isFullscreen returns false when viewMode is desktop', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      const result: boolean = component.isFullscreen();
      expect(result).toBe(false);
    });

    it('isFullscreen returns true when electron isFullscreen is true', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      const result: boolean = component.isFullscreen();
      expect(result).toBe(true);
    });

    it('viewMode reflects electron viewMode signal', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');

      const result: string = component.viewMode();
      expect(result).toBe('fullscreen');
    });

    it('isMiniplayer returns true when viewMode is miniplayer', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(true);
    });

    it('isMiniplayer returns false when viewMode is desktop', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(false);
    });

    it('isMiniplayer returns false when viewMode is fullscreen', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');

      const result: boolean = component.isMiniplayer();
      expect(result).toBe(false);
    });

    it('isVideo returns true when currentMediaType is video', (): void => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set('video');

      const result: boolean = component.isVideo();
      expect(result).toBe(true);
    });

    it('isVideo returns false when currentMediaType is audio', (): void => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set('audio');

      const result: boolean = component.isVideo();
      expect(result).toBe(false);
    });

    it('isVideo returns false when currentMediaType is null', (): void => {
      (mockMediaPlayer['currentMediaType'] as WritableSignal<'audio' | 'video' | null>).set(null);

      const result: boolean = component.isVideo();
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // cursorHidden
  // ============================================================================

  describe('cursorHidden', (): void => {
    it('returns false in desktop mode regardless of controls visibility', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.cursorHidden();
      expect(result).toBe(false);
    });

    it('returns false in fullscreen mode when controls are visible', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      // showControls will return true because controlsVisible defaults to true
      // and autoHideDelay is 5 (non-zero)

      const result: boolean = component.cursorHidden();
      expect(result).toBe(false);
    });

    it('returns true in fullscreen mode when controls are hidden', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      // Trigger mouse leave to hide controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.cursorHidden();
      expect(result).toBe(true);
    });

    it('returns true in miniplayer mode when controls are hidden', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      // Hide controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.cursorHidden();
      expect(result).toBe(true);
    });
  });

  // ============================================================================
  // showControls
  // ============================================================================

  describe('showControls', (): void => {
    it('always returns true in desktop mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');
      // Even if controlsVisible were false, desktop mode always shows controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.showControls();
      expect(result).toBe(true);
    });

    it('respects controlsVisible in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Initially, controlsVisible is true
      expect(component.showControls()).toBe(true);

      // After mouse leave, controlsVisible becomes false
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });

    it('always returns true when autoHideDelay is 0 in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(0);

      // Even after hiding controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.showControls();
      expect(result).toBe(true);
    });

    it('always returns true when autoHideDelay is 0 in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(0);

      // Even after hiding controls
      component.onMiniplayerMouseLeave();

      const result: boolean = component.showControls();
      expect(result).toBe(true);
    });

    it('respects controlsVisible in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Initially visible
      expect(component.showControls()).toBe(true);

      // After mouse leave, hidden
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });
  });

  // ============================================================================
  // Host Bindings
  // ============================================================================

  describe('host bindings', (): void => {
    it('fullscreenClass returns true when fullscreen', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      const result: boolean = component.fullscreenClass;
      expect(result).toBe(true);
    });

    it('fullscreenClass returns false when not fullscreen', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      const result: boolean = component.fullscreenClass;
      expect(result).toBe(false);
    });

    it('miniplayerClass returns true when miniplayer', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      const result: boolean = component.miniplayerClass;
      expect(result).toBe(true);
    });

    it('miniplayerClass returns false when not miniplayer', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.miniplayerClass;
      expect(result).toBe(false);
    });

    it('cursorHiddenClass returns false in desktop mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');

      const result: boolean = component.cursorHiddenClass;
      expect(result).toBe(false);
    });

    it('cursorHiddenClass returns true when fullscreen and controls hidden', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);
      // Force controls hidden
      component.onMiniplayerMouseLeave();

      const result: boolean = component.cursorHiddenClass;
      expect(result).toBe(true);
    });
  });

  // ============================================================================
  // Escape Key Handler
  // ============================================================================

  describe('onEscapeKey', (): void => {
    it('calls exitFullscreen when in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      component.onEscapeKey();

      expect(mockElectron['exitFullscreen']).toHaveBeenCalled();
    });

    it('does not call exitFullscreen when not in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      component.onEscapeKey();

      expect(mockElectron['exitFullscreen']).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Tab Key Handler
  // ============================================================================

  describe('onKeyDown', (): void => {
    it('prevents default on Tab key press', (): void => {
      const event: KeyboardEvent = new KeyboardEvent('keydown', {key: 'Tab'});
      const preventDefaultSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(event, 'preventDefault');

      component.onKeyDown(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it('does not prevent default on non-Tab key press', (): void => {
      const event: KeyboardEvent = new KeyboardEvent('keydown', {key: 'Enter'});
      const preventDefaultSpy: ReturnType<typeof vi.spyOn> = vi.spyOn(event, 'preventDefault');

      component.onKeyDown(event);

      expect(preventDefaultSpy).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // Mouse Events for Drag (miniplayer)
  // ============================================================================

  describe('onMouseDown', (): void => {
    it('does nothing when not in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('desktop');
      const event: MouseEvent = new MouseEvent('mousedown', {screenX: 100, screenY: 100});

      component.onMouseDown(event);

      expect(mockElectron['getWindowPosition']).not.toHaveBeenCalled();
    });

    it('starts drag tracking in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      const div: HTMLDivElement = document.createElement('div');
      document.body.appendChild(div);
      const event: MouseEvent = new MouseEvent('mousedown', {screenX: 100, screenY: 100, bubbles: true});
      Object.defineProperty(event, 'target', {value: div});

      component.onMouseDown(event);

      expect(mockElectron['getWindowPosition']).toHaveBeenCalled();
      document.body.removeChild(div);
    });

    it('does not start drag when clicking a button', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      // Create a button element and use it as the event target
      const button: HTMLButtonElement = document.createElement('button');
      document.body.appendChild(button);

      const event: MouseEvent = new MouseEvent('mousedown', {
        screenX: 100,
        screenY: 100,
        bubbles: true,
      });
      Object.defineProperty(event, 'target', {value: button});

      component.onMouseDown(event);

      expect(mockElectron['getWindowPosition']).not.toHaveBeenCalled();

      document.body.removeChild(button);
    });
  });

  describe('onMouseMoveForDrag', (): void => {
    it('shows controls temporarily on mouse move in fullscreen when not dragging', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // First hide the controls
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);

      // Mouse move should show them temporarily
      const event: MouseEvent = new MouseEvent('mousemove', {screenX: 200, screenY: 200});
      component.onMouseMoveForDrag(event);

      expect(component.showControls()).toBe(true);
    });
  });

  describe('onMouseUp', (): void => {
    it('saves miniplayer bounds after drag completes', async (): Promise<void> => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      // Start drag
      const div: HTMLDivElement = document.createElement('div');
      document.body.appendChild(div);
      const downEvent: MouseEvent = new MouseEvent('mousedown', {screenX: 100, screenY: 100, bubbles: true});
      Object.defineProperty(downEvent, 'target', {value: div});
      component.onMouseDown(downEvent);

      // Wait for getWindowPosition to resolve
      await vi.waitFor((): void => {
        expect(mockElectron['getWindowPosition']).toHaveBeenCalled();
      });

      // Move mouse far enough to exceed drag threshold
      const moveEvent: MouseEvent = new MouseEvent('mousemove', {screenX: 200, screenY: 200});
      component.onMouseMoveForDrag(moveEvent);

      // Release mouse
      component.onMouseUp();

      expect(mockElectron['saveMiniplayerBounds']).toHaveBeenCalled();
      document.body.removeChild(div);
    });

    it('does not save bounds when not dragging', (): void => {
      component.onMouseUp();

      expect(mockElectron['saveMiniplayerBounds']).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // About Mode
  // ============================================================================

  describe('enterAboutMode', (): void => {
    it('sets isAboutMode to true and notifies main process', async (): Promise<void> => {
      await component.enterAboutMode();

      expect(component.isAboutMode()).toBe(true);
      expect(mockElectron['setConfigurationMode']).toHaveBeenCalledWith(true);
    });

    it('exits fullscreen before entering about mode', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      await component.enterAboutMode();

      expect(mockElectron['exitFullscreen']).toHaveBeenCalled();
      expect(component.isAboutMode()).toBe(true);
    });

    it('exits miniplayer before entering about mode', async (): Promise<void> => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      await component.enterAboutMode();

      expect(mockElectron['exitMiniplayer']).toHaveBeenCalled();
      expect(component.isAboutMode()).toBe(true);
    });

    it('does not exit fullscreen when not fullscreen', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      await component.enterAboutMode();

      expect(mockElectron['exitFullscreen']).not.toHaveBeenCalled();
    });
  });

  describe('exitAboutMode', (): void => {
    it('sets isAboutMode to false and notifies main process', (): void => {
      component.isAboutMode.set(true);

      component.exitAboutMode();

      expect(component.isAboutMode()).toBe(false);
      expect(mockElectron['setConfigurationMode']).toHaveBeenCalledWith(false);
    });
  });

  // ============================================================================
  // Help Mode
  // ============================================================================

  describe('enterHelpMode', (): void => {
    it('sets isHelpMode to true and notifies main process', async (): Promise<void> => {
      await component.enterHelpMode();

      expect(component.isHelpMode()).toBe(true);
      expect(mockElectron['setConfigurationMode']).toHaveBeenCalledWith(true);
    });

    it('exits fullscreen before entering help mode', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);

      await component.enterHelpMode();

      expect(mockElectron['exitFullscreen']).toHaveBeenCalled();
      expect(component.isHelpMode()).toBe(true);
    });

    it('exits miniplayer before entering help mode', async (): Promise<void> => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');

      await component.enterHelpMode();

      expect(mockElectron['exitMiniplayer']).toHaveBeenCalled();
      expect(component.isHelpMode()).toBe(true);
    });

    it('exits about mode when entering help mode', async (): Promise<void> => {
      component.isAboutMode.set(true);

      await component.enterHelpMode();

      expect(component.isAboutMode()).toBe(false);
      expect(component.isHelpMode()).toBe(true);
    });

    it('does not exit fullscreen when not fullscreen', async (): Promise<void> => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);

      await component.enterHelpMode();

      expect(mockElectron['exitFullscreen']).not.toHaveBeenCalled();
    });
  });

  describe('exitHelpMode', (): void => {
    it('sets isHelpMode to false and notifies main process', (): void => {
      component.isHelpMode.set(true);

      component.exitHelpMode();

      expect(component.isHelpMode()).toBe(false);
      expect(mockElectron['setConfigurationMode']).toHaveBeenCalledWith(false);
    });
  });

  // ============================================================================
  // Configuration Window
  // ============================================================================

  describe('onOpenDependencySettings', (): void => {
    it('opens configuration window with dependencies category', (): void => {
      component.onOpenDependencySettings();

      expect(mockElectron['showConfigurationWindow']).toHaveBeenCalledWith('dependencies');
    });
  });

  // ============================================================================
  // Miniplayer Controls Visibility
  // ============================================================================

  describe('onMiniplayerMouseEnter', (): void => {
    it('shows controls when mouse enters', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // First hide controls
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);

      // Mouse enter should show them
      component.onMiniplayerMouseEnter();
      expect(component.showControls()).toBe(true);
    });
  });

  describe('onMiniplayerMouseLeave', (): void => {
    it('hides controls when mouse leaves in miniplayer mode', (): void => {
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('miniplayer');
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(false);
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Controls start visible
      expect(component.showControls()).toBe(true);

      // Mouse leave should hide them
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });

    it('hides controls when mouse leaves in fullscreen mode', (): void => {
      (mockElectron['isFullscreen'] as WritableSignal<boolean>).set(true);
      (mockElectron['viewMode'] as WritableSignal<'desktop' | 'miniplayer' | 'fullscreen'>).set('fullscreen');
      (mockSettings['controlsAutoHideDelay'] as WritableSignal<number>).set(5);

      // Controls start visible
      expect(component.showControls()).toBe(true);

      // Mouse leave should hide them
      component.onMiniplayerMouseLeave();
      expect(component.showControls()).toBe(false);
    });
  });

  // ============================================================================
  // Lifecycle
  // ============================================================================

  describe('ngOnDestroy', (): void => {
    it('does not throw when called', (): void => {
      expect((): void => component.ngOnDestroy()).not.toThrow();
    });

    it('does not throw when called with no active timeout', (): void => {
      // Ensure no timeout is running
      component.onMiniplayerMouseLeave();
      expect((): void => component.ngOnDestroy()).not.toThrow();
    });

    it('cleans up without error after showing controls temporarily', (): void => {
      // Trigger showControlsTemporarily by mouse enter
      component.onMiniplayerMouseEnter();

      // ngOnDestroy should clear the timeout without errors
      expect((): void => component.ngOnDestroy()).not.toThrow();
    });
  });
});
