/**
 * @fileoverview Tests for ConfigurationView.
 *
 * The settings window is almost entirely wiring: every control reads a
 * service signal and writes back through a service setter. The tests render
 * the component against fake services and drive it through the DOM, so a
 * control bound to the wrong setter, the wrong signal or the wrong value
 * conversion fails here.
 *
 * Tests cover:
 * - Category navigation, the visualizations accordion, the initialCategory
 *   input and the standalone-window URL parameter
 * - Every select, slider, colour picker and toggle writing the converted
 *   value to its setter
 * - Service signals being reflected in the rendered controls
 * - Conditional sections (macOS, glass support, equalizer, video adjustments,
 *   text shadow, hardware encoders, FluidSynth)
 * - Dependency rows, progress, SoundFonts and external links
 * - Handlers ignoring events that carry no usable value
 *
 * @module app/components/configuration/configuration-view.spec
 */

import {ComponentFixture, TestBed} from '@angular/core/testing';
import {signal, type WritableSignal} from '@angular/core';

import {ConfigurationView} from './configuration-view';
import {SettingsService, VISUALIZATION_METADATA} from '../../../services/settings.service';
import type {AudioBitrate, ColorScheme, CrossfadeDuration, CrossfadeStyle, FftSize, HardwareAcceleration, LocalSettingKey, MacOSVisualEffectState, PerVisualizationSettings, PreferredAudioLanguage, PreferredSubtitleLanguage, RenderResolution, SeekMode, SubtitleFontFamily, VideoAspectMode, VideoQuality, VisualizationMetadata} from '../../../services/settings.service';
import {ElectronService} from '../../../services/electron.service';
import {DependencyService} from '../../../services/dependency.service';
import type {DependencyState, DependencyStatus, HardwareEncoderInfo, InstallProgress, SoundFontInfo} from '../../../services/dependency.service';
import {NEUTRAL_VIDEO_ADJUSTMENTS, type VideoAdjustmentValues} from '../../../services/video-adjustments';
import {buildTextShadow} from '../../../utils/subtitle-style';

// ============================================================================
// Fakes
// ============================================================================

/** A vitest mock function. */
type Spy = ReturnType<typeof vi.fn>;

/** Platform information as exposed by ElectronService. */
interface PlatformInfo {
  platform: string;
  supportsGlass: boolean;
  systemTheme: 'dark' | 'light';
}

/** The SettingsService signals the view reads. */
interface SettingsSignals {
  maxFrameRate: WritableSignal<number>;
  fftSize: WritableSignal<FftSize>;
  renderResolution: WritableSignal<RenderResolution>;
  visualizationCrossfadeDuration: WritableSignal<CrossfadeDuration>;
  visualizationCrossfadeStyle: WritableSignal<CrossfadeStyle>;
  perVisualizationSettings: WritableSignal<PerVisualizationSettings>;
  defaultVolume: WritableSignal<number>;
  crossfadeDuration: WritableSignal<number>;
  videoQuality: WritableSignal<VideoQuality>;
  audioBitrate: WritableSignal<AudioBitrate>;
  hardwareAcceleration: WritableSignal<HardwareAcceleration>;
  equalizerEnabled: WritableSignal<boolean>;
  equalizerPreset: WritableSignal<string>;
  equalizerBands: WritableSignal<readonly number[]>;
  videoAdjustmentsEnabled: WritableSignal<boolean>;
  videoAdjustmentsPreset: WritableSignal<string>;
  videoAdjustments: WritableSignal<VideoAdjustmentValues>;
  serverPort: WritableSignal<number>;
  controlsAutoHideDelay: WritableSignal<number>;
  previousTrackThreshold: WritableSignal<number>;
  skipDuration: WritableSignal<number>;
  seekMode: WritableSignal<SeekMode>;
  miniplayerOnFocusLoss: WritableSignal<boolean>;
  videoAspectMode: WritableSignal<VideoAspectMode>;
  preferredAudioLanguage: WritableSignal<PreferredAudioLanguage>;
  preferredSubtitleLanguage: WritableSignal<PreferredSubtitleLanguage>;
  colorScheme: WritableSignal<ColorScheme>;
  glassEnabled: WritableSignal<boolean>;
  backgroundColor: WritableSignal<string>;
  macOSVisualEffectState: WritableSignal<MacOSVisualEffectState>;
  backgroundHue: WritableSignal<number>;
  backgroundSaturation: WritableSignal<number>;
  backgroundLightness: WritableSignal<number>;
  windowTintHue: WritableSignal<number>;
  windowTintSaturation: WritableSignal<number>;
  windowTintLightness: WritableSignal<number>;
  windowTintAlpha: WritableSignal<number>;
  subtitleFontSize: WritableSignal<number>;
  subtitleFontColor: WritableSignal<string>;
  subtitleBackgroundColor: WritableSignal<string>;
  subtitleBackgroundOpacity: WritableSignal<number>;
  subtitleFontFamily: WritableSignal<SubtitleFontFamily>;
  subtitleTextShadow: WritableSignal<boolean>;
  subtitleShadowSpread: WritableSignal<number>;
  subtitleShadowBlur: WritableSignal<number>;
  subtitleShadowColor: WritableSignal<string>;
}

/** Every SettingsService method the view writes through. */
const SETTINGS_METHODS: readonly [
  'setMaxFrameRate', 'setFftSize', 'setRenderResolution', 'setVisualizationCrossfadeDuration',
  'setVisualizationCrossfadeStyle', 'setVisualizationSetting', 'resetVisualizationSetting',
  'resetAllVisualizationSettings', 'setServerPort', 'setControlsAutoHideDelay', 'setMiniplayerOnFocusLoss',
  'setSeekMode', 'setPreviousTrackThreshold', 'setSkipDuration', 'setDefaultVolume', 'setCrossfadeDuration',
  'setEqualizerEnabled', 'setEqualizerPreset', 'setEqualizerBand', 'resetEqualizer',
  'setVideoAdjustmentsEnabled', 'setVideoAdjustmentPreset', 'setVideoAdjustment', 'resetVideoAdjustments',
  'setVideoQuality', 'setAudioBitrate', 'setHardwareAcceleration', 'setVideoAspectMode',
  'setPreferredAudioLanguage', 'setPreferredSubtitleLanguage', 'setGlassEnabled', 'setMacOSVisualEffectState',
  'setColorScheme', 'setBackgroundColor', 'setBackgroundHue', 'setBackgroundSaturation', 'setBackgroundLightness',
  'setWindowTintHue', 'setWindowTintSaturation', 'setWindowTintLightness', 'setWindowTintAlpha',
  'setSubtitleFontSize', 'setSubtitleFontColor', 'setSubtitleBackgroundColor', 'setSubtitleBackgroundOpacity',
  'setSubtitleFontFamily', 'setSubtitleTextShadow', 'setSubtitleShadowSpread', 'setSubtitleShadowBlur',
  'setSubtitleShadowColor',
] = [
  'setMaxFrameRate', 'setFftSize', 'setRenderResolution', 'setVisualizationCrossfadeDuration',
  'setVisualizationCrossfadeStyle', 'setVisualizationSetting', 'resetVisualizationSetting',
  'resetAllVisualizationSettings', 'setServerPort', 'setControlsAutoHideDelay', 'setMiniplayerOnFocusLoss',
  'setSeekMode', 'setPreviousTrackThreshold', 'setSkipDuration', 'setDefaultVolume', 'setCrossfadeDuration',
  'setEqualizerEnabled', 'setEqualizerPreset', 'setEqualizerBand', 'resetEqualizer',
  'setVideoAdjustmentsEnabled', 'setVideoAdjustmentPreset', 'setVideoAdjustment', 'resetVideoAdjustments',
  'setVideoQuality', 'setAudioBitrate', 'setHardwareAcceleration', 'setVideoAspectMode',
  'setPreferredAudioLanguage', 'setPreferredSubtitleLanguage', 'setGlassEnabled', 'setMacOSVisualEffectState',
  'setColorScheme', 'setBackgroundColor', 'setBackgroundHue', 'setBackgroundSaturation', 'setBackgroundLightness',
  'setWindowTintHue', 'setWindowTintSaturation', 'setWindowTintLightness', 'setWindowTintAlpha',
  'setSubtitleFontSize', 'setSubtitleFontColor', 'setSubtitleBackgroundColor', 'setSubtitleBackgroundOpacity',
  'setSubtitleFontFamily', 'setSubtitleTextShadow', 'setSubtitleShadowSpread', 'setSubtitleShadowBlur',
  'setSubtitleShadowColor',
];

/** Name of a SettingsService method the view writes through. */
type SettingsMethod = (typeof SETTINGS_METHODS)[number];

/** The fake SettingsService: writable signals, spied setters and the two real lookups. */
type FakeSettings = SettingsSignals & Record<SettingsMethod, Spy> & {
  hasApplicableSetting: Spy;
  getVisualizationMetadata: Spy;
};

/** The fake DependencyService. */
interface FakeDeps {
  dependencyState: WritableSignal<DependencyState | null>;
  installProgress: WritableSignal<InstallProgress | null>;
  soundFontError: WritableSignal<string | null>;
  soundFonts: WritableSignal<SoundFontInfo[]>;
  activeSoundFont: WritableSignal<string | null>;
  fluidsynthInstalled: WritableSignal<boolean>;
  isOperationInProgress: WritableSignal<boolean>;
  hardwareEncoders: WritableSignal<HardwareEncoderInfo>;
  installDependency: Spy;
  uninstallDependency: Spy;
  updateDependency: Spy;
  installSoundFont: Spy;
  removeSoundFont: Spy;
  setActiveSoundFont: Spy;
}

/** The fake ElectronService. */
interface FakeElectron {
  platformInfo: WritableSignal<PlatformInfo>;
}

/** The preload API surface the view uses. */
interface MockApi {
  openExternal: Spy;
}

/**
 * Creates the fake SettingsService.
 *
 * Defaults enable every optional section (equalizer, video adjustments, text
 * shadow, glass) so that their controls are rendered unless a test turns
 * them off.
 *
 * @returns The fake, so tests can set signals and assert against setters
 */
function createFakeSettings(): FakeSettings {
  const signals: SettingsSignals = {
    maxFrameRate: signal<number>(60),
    fftSize: signal<FftSize>(2048),
    renderResolution: signal<RenderResolution>('native'),
    visualizationCrossfadeDuration: signal<CrossfadeDuration>(1000),
    visualizationCrossfadeStyle: signal<CrossfadeStyle>('fade'),
    perVisualizationSettings: signal<PerVisualizationSettings>({}),
    defaultVolume: signal<number>(0.5),
    crossfadeDuration: signal<number>(100),
    videoQuality: signal<VideoQuality>('medium'),
    audioBitrate: signal<AudioBitrate>(192),
    hardwareAcceleration: signal<HardwareAcceleration>('auto'),
    equalizerEnabled: signal<boolean>(true),
    equalizerPreset: signal<string>('flat'),
    equalizerBands: signal<readonly number[]>([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    videoAdjustmentsEnabled: signal<boolean>(true),
    videoAdjustmentsPreset: signal<string>('default'),
    videoAdjustments: signal<VideoAdjustmentValues>(NEUTRAL_VIDEO_ADJUSTMENTS),
    serverPort: signal<number>(0),
    controlsAutoHideDelay: signal<number>(5),
    previousTrackThreshold: signal<number>(3),
    skipDuration: signal<number>(10),
    seekMode: signal<SeekMode>('drop'),
    miniplayerOnFocusLoss: signal<boolean>(false),
    videoAspectMode: signal<VideoAspectMode>('default'),
    preferredAudioLanguage: signal<PreferredAudioLanguage>('default'),
    preferredSubtitleLanguage: signal<PreferredSubtitleLanguage>('default'),
    colorScheme: signal<ColorScheme>('system'),
    glassEnabled: signal<boolean>(true),
    backgroundColor: signal<string>('#1e1e1e'),
    macOSVisualEffectState: signal<MacOSVisualEffectState>('followWindow'),
    backgroundHue: signal<number>(10),
    backgroundSaturation: signal<number>(20),
    backgroundLightness: signal<number>(30),
    windowTintHue: signal<number>(210),
    windowTintSaturation: signal<number>(60),
    windowTintLightness: signal<number>(40),
    windowTintAlpha: signal<number>(0.5),
    subtitleFontSize: signal<number>(100),
    subtitleFontColor: signal<string>('#ffffff'),
    subtitleBackgroundColor: signal<string>('#000000'),
    subtitleBackgroundOpacity: signal<number>(0.75),
    subtitleFontFamily: signal<SubtitleFontFamily>('sans-serif'),
    subtitleTextShadow: signal<boolean>(true),
    subtitleShadowSpread: signal<number>(2),
    subtitleShadowBlur: signal<number>(2),
    subtitleShadowColor: signal<string>('#000000'),
  };

  const methods: Partial<Record<SettingsMethod, Spy>> = {};
  for (const name of SETTINGS_METHODS) {
    methods[name] = vi.fn().mockResolvedValue(undefined);
  }

  return {
    ...signals,
    ...(methods as Record<SettingsMethod, Spy>),
    hasApplicableSetting: vi.fn((vizId: string, setting: LocalSettingKey): boolean =>
      VISUALIZATION_METADATA.find((v: VisualizationMetadata): boolean => v.id === vizId)?.applicableSettings.includes(setting) ?? false),
    getVisualizationMetadata: vi.fn((vizId: string): VisualizationMetadata | undefined =>
      VISUALIZATION_METADATA.find((v: VisualizationMetadata): boolean => v.id === vizId)),
  };
}

/**
 * Creates the fake DependencyService.
 *
 * @returns The fake, so tests can set signals and assert against its methods
 */
function createFakeDeps(): FakeDeps {
  return {
    dependencyState: signal<DependencyState | null>(null),
    installProgress: signal<InstallProgress | null>(null),
    soundFontError: signal<string | null>(null),
    soundFonts: signal<SoundFontInfo[]>([]),
    activeSoundFont: signal<string | null>(null),
    fluidsynthInstalled: signal<boolean>(false),
    isOperationInProgress: signal<boolean>(false),
    hardwareEncoders: signal<HardwareEncoderInfo>({available: false, encoders: []}),
    installDependency: vi.fn().mockResolvedValue(undefined),
    uninstallDependency: vi.fn().mockResolvedValue(undefined),
    updateDependency: vi.fn().mockResolvedValue(undefined),
    installSoundFont: vi.fn().mockResolvedValue(undefined),
    removeSoundFont: vi.fn().mockResolvedValue(undefined),
    setActiveSoundFont: vi.fn().mockResolvedValue(undefined),
  };
}

/**
 * Builds a dependency status.
 *
 * @param overrides - Fields to override on a bundled, installed FFmpeg
 * @returns The status
 */
function createDep(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    id: 'ffmpeg',
    name: 'FFmpeg',
    installed: true,
    path: '/app/bin/ffmpeg',
    source: 'bundled',
    version: '9.0.2',
    managed: false,
    description: 'Media transcoding',
    websiteUrl: 'https://ffmpeg.org',
    ...overrides,
  };
}

/**
 * Builds a full dependency state: bundled FFmpeg and FluidSynth, and a
 * yt-dlp that has not been downloaded.
 *
 * @param overrides - Fields to override
 * @returns The state
 */
function createDepState(overrides: Partial<DependencyState> = {}): DependencyState {
  return {
    ffmpeg: createDep(),
    fluidsynth: createDep({id: 'fluidsynth', name: 'FluidSynth', path: '/app/bin/fluidsynth', version: '2.4.0', description: 'MIDI synthesis', websiteUrl: 'https://www.fluidsynth.org'}),
    ytdlp: createDep({id: 'yt-dlp', name: 'yt-dlp', installed: false, path: null, source: null, version: null, managed: true, description: 'Internet media', websiteUrl: 'https://github.com/yt-dlp/yt-dlp'}),
    trackerSupport: true,
    midiSupport: true,
    soundfonts: [],
    activeSoundFont: null,
    hardwareEncoders: {available: false, encoders: []},
    ...overrides,
  };
}

/** A yt-dlp that has been downloaded, so it offers Update and Remove. */
const DOWNLOADED_YTDLP: DependencyStatus = createDep({
  id: 'yt-dlp', name: 'yt-dlp', path: '/data/bin/yt-dlp', source: 'downloaded', version: '2026.10.01', managed: true, websiteUrl: 'https://github.com/yt-dlp/yt-dlp',
});

/**
 * Creates a preload API stub and installs it on window.
 *
 * @returns The stub, so tests can assert against it
 */
function installApi(): MockApi {
  const api: MockApi = {openExternal: vi.fn().mockResolvedValue(undefined)};
  (window as unknown as {mediaPlayer: MockApi | undefined}).mediaPlayer = api;
  return api;
}

/** Removes the preload API from window. */
function removeApi(): void {
  (window as unknown as {mediaPlayer: MockApi | undefined}).mediaPlayer = undefined;
}

/**
 * Builds an event that has really been dispatched from a form control, so
 * its target is that control.
 *
 * @param tag - The element to dispatch from
 * @param type - The event type
 * @param value - The control's value
 * @returns The dispatched event
 */
function eventFrom(tag: 'input' | 'select' | 'div', type: string, value: string = ''): Event {
  const element: HTMLElement = document.createElement(tag);
  if (element instanceof HTMLInputElement) element.value = value;
  const event: Event = new Event(type);
  element.dispatchEvent(event);
  return event;
}

// ============================================================================
// Control Tables
// ============================================================================

/** A control that writes a value to a SettingsService method. */
interface WriteCase {
  /** Sidebar name of the category holding the control */
  readonly category: string;
  /** Element id of the control */
  readonly id: string;
  /** The raw value the user picks or types */
  readonly value: string;
  /** The setter expected to be called */
  readonly method: SettingsMethod;
  /** The arguments the setter is expected to receive */
  readonly args: readonly unknown[];
}

/** A toggle that writes its checked state to a SettingsService method. */
interface ToggleCase {
  readonly category: string;
  readonly id: string;
  readonly method: SettingsMethod;
  /** Arguments expected when the toggle is switched on */
  readonly args: readonly unknown[];
}

/** A service signal that is expected to show up in the DOM. */
interface ReflectCase {
  /** What the test is named for */
  readonly name: string;
  readonly category: string;
  /** Puts the service into the state under test */
  readonly arrange: (settings: FakeSettings) => void;
  /** Reads the rendered result */
  readonly read: (host: HTMLElement) => string | boolean | null | undefined;
  readonly expected: string | boolean;
}

const SELECT_CASES: readonly WriteCase[] = [
  {category: 'Audio Visualizations', id: 'max-frame-rate', value: '30', method: 'setMaxFrameRate', args: [30]},
  {category: 'Audio Visualizations', id: 'fft-size', value: '4096', method: 'setFftSize', args: [4096]},
  {category: 'Audio Visualizations', id: 'render-resolution', value: '640x480', method: 'setRenderResolution', args: ['640x480']},
  {category: 'Audio Visualizations', id: 'visualization-crossfade-duration', value: '1500', method: 'setVisualizationCrossfadeDuration', args: [1500]},
  {category: 'Audio Visualizations', id: 'crossfade-style', value: 'blur', method: 'setVisualizationCrossfadeStyle', args: ['blur']},
  {category: 'Playback', id: 'seek-mode', value: 'drag', method: 'setSeekMode', args: ['drag']},
  {category: 'Audio Playback', id: 'preferred-audio-language', value: 'jpn', method: 'setPreferredAudioLanguage', args: ['jpn']},
  {category: 'Audio Playback', id: 'audio-bitrate', value: '320', method: 'setAudioBitrate', args: [320]},
  {category: 'Audio Playback', id: 'equalizer-preset', value: 'rock', method: 'setEqualizerPreset', args: ['rock']},
  {category: 'Video Playback', id: 'video-aspect-mode', value: '16:9', method: 'setVideoAspectMode', args: ['16:9']},
  {category: 'Video Playback', id: 'preferred-subtitle-language', value: 'off', method: 'setPreferredSubtitleLanguage', args: ['off']},
  {category: 'Video Playback', id: 'video-quality', value: 'high', method: 'setVideoQuality', args: ['high']},
  {category: 'Video Playback', id: 'hardware-acceleration', value: 'disabled', method: 'setHardwareAcceleration', args: ['disabled']},
  {category: 'Video Playback', id: 'video-adjustments-preset', value: 'noir', method: 'setVideoAdjustmentPreset', args: ['noir']},
  {category: 'Video Subtitles', id: 'subtitle-font-family', value: 'serif', method: 'setSubtitleFontFamily', args: ['serif']},
  {category: 'Appearance', id: 'color-scheme', value: 'light', method: 'setColorScheme', args: ['light']},
  {category: 'Appearance', id: 'macos-visual-effect-state', value: 'active', method: 'setMacOSVisualEffectState', args: ['active']},
];

const INPUT_CASES: readonly WriteCase[] = [
  {category: 'Playback', id: 'previous-track-threshold', value: '5', method: 'setPreviousTrackThreshold', args: [5]},
  {category: 'Playback', id: 'skip-duration', value: '30', method: 'setSkipDuration', args: [30]},
  {category: 'Audio Playback', id: 'default-volume', value: '0.25', method: 'setDefaultVolume', args: [0.25]},
  {category: 'Audio Playback', id: 'crossfade-duration', value: '250', method: 'setCrossfadeDuration', args: [250]},
  {category: 'Video Playback', id: 'auto-hide-delay', value: '12', method: 'setControlsAutoHideDelay', args: [12]},
  {category: 'Video Playback', id: 'video-adj-brightness', value: '40', method: 'setVideoAdjustment', args: ['brightness', 40]},
  {category: 'Video Playback', id: 'video-adj-contrast', value: '-25', method: 'setVideoAdjustment', args: ['contrast', -25]},
  {category: 'Video Playback', id: 'video-adj-hue', value: '-90', method: 'setVideoAdjustment', args: ['hue', -90]},
  {category: 'Video Playback', id: 'video-adj-sepia', value: '60', method: 'setVideoAdjustment', args: ['sepia', 60]},
  {category: 'Video Subtitles', id: 'subtitle-font-size', value: '150', method: 'setSubtitleFontSize', args: [150]},
  {category: 'Video Subtitles', id: 'subtitle-font-color', value: '#ff8800', method: 'setSubtitleFontColor', args: ['#ff8800']},
  {category: 'Video Subtitles', id: 'subtitle-background-color', value: '#112233', method: 'setSubtitleBackgroundColor', args: ['#112233']},
  {category: 'Video Subtitles', id: 'subtitle-background-opacity', value: '0.4', method: 'setSubtitleBackgroundOpacity', args: [0.4]},
  {category: 'Video Subtitles', id: 'subtitle-shadow-spread', value: '2.5', method: 'setSubtitleShadowSpread', args: [2.5]},
  {category: 'Video Subtitles', id: 'subtitle-shadow-blur', value: '4', method: 'setSubtitleShadowBlur', args: [4]},
  {category: 'Video Subtitles', id: 'subtitle-shadow-color', value: '#00ff00', method: 'setSubtitleShadowColor', args: ['#00ff00']},
  {category: 'Appearance', id: 'window-color-alpha', value: '0.35', method: 'setWindowTintAlpha', args: [0.35]},
];

const TOGGLE_CASES: readonly ToggleCase[] = [
  {category: 'Application', id: 'miniplayer-on-focus-loss', method: 'setMiniplayerOnFocusLoss', args: [true]},
  {category: 'Audio Playback', id: 'equalizer-enabled', method: 'setEqualizerEnabled', args: [true]},
  {category: 'Video Playback', id: 'video-adjustments-enabled', method: 'setVideoAdjustmentsEnabled', args: [true]},
  {category: 'Video Playback', id: 'video-adj-invert', method: 'setVideoAdjustment', args: ['invert', true]},
  {category: 'Video Subtitles', id: 'subtitle-text-shadow', method: 'setSubtitleTextShadow', args: [true]},
  {category: 'Appearance', id: 'glass-enabled', method: 'setGlassEnabled', args: [true]},
];

/**
 * Reads the value of the form control with the given id.
 *
 * @param id - The element id
 * @returns A reader for use in a ReflectCase
 */
function valueOf(id: string): (host: HTMLElement) => string | undefined {
  return (host: HTMLElement): string | undefined =>
    host.querySelector<HTMLInputElement | HTMLSelectElement>(`#${id}`)?.value;
}

/**
 * Reads the formatted value shown beside the slider with the given id.
 *
 * @param id - The slider's element id
 * @returns A reader for use in a ReflectCase
 */
function labelOf(id: string): (host: HTMLElement) => string | undefined {
  return (host: HTMLElement): string | undefined =>
    host.querySelector(`#${id}`)?.parentElement?.querySelector('.slider-value, .color-value')?.textContent.trim();
}

/**
 * Reads the checked state of the toggle with the given id.
 *
 * @param id - The checkbox's element id
 * @returns A reader for use in a ReflectCase
 */
function checkedOf(id: string): (host: HTMLElement) => boolean | undefined {
  return (host: HTMLElement): boolean | undefined => host.querySelector<HTMLInputElement>(`#${id}`)?.checked;
}

const REFLECT_CASES: readonly ReflectCase[] = [
  // Application
  {name: 'a fixed server port in the port field', category: 'Application', arrange: (s: FakeSettings): void => s.serverPort.set(8080), read: valueOf('server-port'), expected: '8080'},
  {name: 'an auto-assigned server port as an empty port field', category: 'Application', arrange: (s: FakeSettings): void => s.serverPort.set(0), read: valueOf('server-port'), expected: ''},
  {name: 'mini-player on focus loss as a checked toggle', category: 'Application', arrange: (s: FakeSettings): void => s.miniplayerOnFocusLoss.set(true), read: checkedOf('miniplayer-on-focus-loss'), expected: true},
  // Playback
  {name: 'the previous track threshold in seconds', category: 'Playback', arrange: (s: FakeSettings): void => s.previousTrackThreshold.set(7), read: labelOf('previous-track-threshold'), expected: '7s'},
  {name: 'a zero previous track threshold as Off', category: 'Playback', arrange: (s: FakeSettings): void => s.previousTrackThreshold.set(0), read: labelOf('previous-track-threshold'), expected: 'Off'},
  {name: 'the previous track threshold on its slider', category: 'Playback', arrange: (s: FakeSettings): void => s.previousTrackThreshold.set(7), read: valueOf('previous-track-threshold'), expected: '7'},
  {name: 'the skip duration in seconds', category: 'Playback', arrange: (s: FakeSettings): void => s.skipDuration.set(15), read: labelOf('skip-duration'), expected: '15s'},
  {name: 'the skip duration on its slider', category: 'Playback', arrange: (s: FakeSettings): void => s.skipDuration.set(15), read: valueOf('skip-duration'), expected: '15'},
  {name: 'the seek mode as the selected option', category: 'Playback', arrange: (s: FakeSettings): void => s.seekMode.set('drag'), read: valueOf('seek-mode'), expected: 'drag'},
  // Audio
  {name: 'the default volume as a percentage', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.defaultVolume.set(0.75), read: labelOf('default-volume'), expected: '75%'},
  {name: 'the default volume on its slider', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.defaultVolume.set(0.75), read: valueOf('default-volume'), expected: '0.75'},
  {name: 'the track crossfade in milliseconds', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.crossfadeDuration.set(200), read: labelOf('crossfade-duration'), expected: '200ms'},
  {name: 'a zero track crossfade as Off', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.crossfadeDuration.set(0), read: labelOf('crossfade-duration'), expected: 'Off'},
  {name: 'the preferred audio language as the selected option', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.preferredAudioLanguage.set('kor'), read: valueOf('preferred-audio-language'), expected: 'kor'},
  {name: 'the audio bitrate as the selected option', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.audioBitrate.set(256), read: valueOf('audio-bitrate'), expected: '256'},
  {name: 'a disabled equalizer as an unchecked toggle', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.equalizerEnabled.set(false), read: checkedOf('equalizer-enabled'), expected: false},
  {name: 'the equalizer preset as the selected option', category: 'Audio Playback', arrange: (s: FakeSettings): void => s.equalizerPreset.set('jazz'), read: valueOf('equalizer-preset'), expected: 'jazz'},
  // Visualizations
  {name: 'the max frame rate as the selected option', category: 'Audio Visualizations', arrange: (s: FakeSettings): void => s.maxFrameRate.set(15), read: valueOf('max-frame-rate'), expected: '15'},
  {name: 'the FFT size as the selected option', category: 'Audio Visualizations', arrange: (s: FakeSettings): void => s.fftSize.set(512), read: valueOf('fft-size'), expected: '512'},
  {name: 'the render resolution as the selected option', category: 'Audio Visualizations', arrange: (s: FakeSettings): void => s.renderResolution.set('800x600'), read: valueOf('render-resolution'), expected: '800x600'},
  {name: 'the visualization crossfade duration as the selected option', category: 'Audio Visualizations', arrange: (s: FakeSettings): void => s.visualizationCrossfadeDuration.set(2000), read: valueOf('visualization-crossfade-duration'), expected: '2000'},
  {name: 'the visualization crossfade style as the selected option', category: 'Audio Visualizations', arrange: (s: FakeSettings): void => s.visualizationCrossfadeStyle.set('zoom'), read: valueOf('crossfade-style'), expected: 'zoom'},
  // Video
  {name: 'the video aspect mode as the selected option', category: 'Video Playback', arrange: (s: FakeSettings): void => s.videoAspectMode.set('fit'), read: valueOf('video-aspect-mode'), expected: 'fit'},
  {name: 'the preferred subtitle language as the selected option', category: 'Video Playback', arrange: (s: FakeSettings): void => s.preferredSubtitleLanguage.set('off'), read: valueOf('preferred-subtitle-language'), expected: 'off'},
  {name: 'the controls auto-hide delay in seconds', category: 'Video Playback', arrange: (s: FakeSettings): void => s.controlsAutoHideDelay.set(8), read: labelOf('auto-hide-delay'), expected: '8s'},
  {name: 'a zero controls auto-hide delay as Off', category: 'Video Playback', arrange: (s: FakeSettings): void => s.controlsAutoHideDelay.set(0), read: labelOf('auto-hide-delay'), expected: 'Off'},
  {name: 'the video quality as the selected option', category: 'Video Playback', arrange: (s: FakeSettings): void => s.videoQuality.set('low'), read: valueOf('video-quality'), expected: 'low'},
  {name: 'the hardware acceleration mode as the selected option', category: 'Video Playback', arrange: (s: FakeSettings): void => s.hardwareAcceleration.set('disabled'), read: valueOf('hardware-acceleration'), expected: 'disabled'},
  {name: 'the video adjustments preset as the selected option', category: 'Video Playback', arrange: (s: FakeSettings): void => s.videoAdjustmentsPreset.set('warm'), read: valueOf('video-adjustments-preset'), expected: 'warm'},
  {name: 'a video adjustment value on its slider', category: 'Video Playback', arrange: (s: FakeSettings): void => s.videoAdjustments.set({...NEUTRAL_VIDEO_ADJUSTMENTS, contrast: 20}), read: valueOf('video-adj-contrast'), expected: '20'},
  {name: 'the hue adjustment with its degree unit', category: 'Video Playback', arrange: (s: FakeSettings): void => s.videoAdjustments.set({...NEUTRAL_VIDEO_ADJUSTMENTS, hue: -15}), read: labelOf('video-adj-hue'), expected: '-15°'},
  {name: 'inverted colours as a checked toggle', category: 'Video Playback', arrange: (s: FakeSettings): void => s.videoAdjustments.set({...NEUTRAL_VIDEO_ADJUSTMENTS, invert: true}), read: checkedOf('video-adj-invert'), expected: true},
  // Subtitles
  {name: 'the subtitle font size as a percentage', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleFontSize.set(120), read: labelOf('subtitle-font-size'), expected: '120%'},
  {name: 'the subtitle font colour as its hex code', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleFontColor.set('#ffcc00'), read: labelOf('subtitle-font-color'), expected: '#ffcc00'},
  {name: 'the subtitle font colour on its picker', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleFontColor.set('#ffcc00'), read: valueOf('subtitle-font-color'), expected: '#ffcc00'},
  {name: 'the subtitle background colour as its hex code', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleBackgroundColor.set('#223344'), read: labelOf('subtitle-background-color'), expected: '#223344'},
  {name: 'the subtitle background opacity as a rounded percentage', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleBackgroundOpacity.set(0.555), read: labelOf('subtitle-background-opacity'), expected: '56%'},
  {name: 'the subtitle font family as the selected option', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleFontFamily.set('monospace'), read: valueOf('subtitle-font-family'), expected: 'monospace'},
  {name: 'the subtitle shadow spread in pixels', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleShadowSpread.set(1.5), read: labelOf('subtitle-shadow-spread'), expected: '1.5px'},
  {name: 'the subtitle shadow blur in pixels', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleShadowBlur.set(3), read: labelOf('subtitle-shadow-blur'), expected: '3px'},
  {name: 'the subtitle shadow colour as its hex code', category: 'Video Subtitles', arrange: (s: FakeSettings): void => s.subtitleShadowColor.set('#445566'), read: labelOf('subtitle-shadow-color'), expected: '#445566'},
  // Appearance
  {name: 'a disabled glass effect as an unchecked toggle', category: 'Appearance', arrange: (s: FakeSettings): void => s.glassEnabled.set(false), read: checkedOf('glass-enabled'), expected: false},
  {name: 'the colour scheme as the selected option', category: 'Appearance', arrange: (s: FakeSettings): void => s.colorScheme.set('dark'), read: valueOf('color-scheme'), expected: 'dark'},
  {name: 'the visual effect state as the selected option', category: 'Appearance', arrange: (s: FakeSettings): void => s.macOSVisualEffectState.set('inactive'), read: valueOf('macos-visual-effect-state'), expected: 'inactive'},
  {name: 'the window tint alpha as a percentage', category: 'Appearance', arrange: (s: FakeSettings): void => s.windowTintAlpha.set(0.35), read: labelOf('window-color-alpha'), expected: '35%'},
];

// ============================================================================
// Tests
// ============================================================================

describe('ConfigurationView', (): void => {
  let fixture: ComponentFixture<ConfigurationView>;
  let component: ConfigurationView;
  let host: HTMLElement;
  let settings: FakeSettings;
  let deps: FakeDeps;
  let electron: FakeElectron;

  /**
   * Finds exactly one element, failing the test if it is absent.
   *
   * @param selector - CSS selector
   * @returns The element
   */
  function get<T extends Element>(selector: string): T {
    const element: T | null = host.querySelector<T>(selector);
    if (!element) throw new Error(`No element matches ${selector}`);
    return element;
  }

  /**
   * Finds every element matching a selector.
   *
   * @param selector - CSS selector
   * @returns The elements, in document order
   */
  function all<T extends Element>(selector: string): T[] {
    return Array.from(host.querySelectorAll<T>(selector));
  }

  /**
   * Reads the trimmed text of every element matching a selector.
   *
   * @param selector - CSS selector
   * @returns The texts, in document order
   */
  function texts(selector: string): string[] {
    return all<HTMLElement>(selector).map((element: HTMLElement): string => element.textContent.trim());
  }

  /**
   * Opens a category by clicking its entry in the sidebar.
   *
   * @param name - The category's display name
   */
  async function open(name: string): Promise<void> {
    const button: HTMLButtonElement | undefined = all<HTMLButtonElement>('.category-item')
      .find((item: HTMLButtonElement): boolean => item.querySelector('span')?.textContent.trim() === name);
    if (!button) throw new Error(`No category named ${name}`);
    button.click();
    await fixture.whenStable();
  }

  /** Expands or collapses the visualizations accordion. */
  async function toggleAccordion(): Promise<void> {
    get<HTMLButtonElement>('.accordion-toggle').click();
    await fixture.whenStable();
  }

  /**
   * Opens the per-visualization settings for a visualization.
   *
   * @param name - The visualization's display name
   */
  async function openVisualization(name: string): Promise<void> {
    await toggleAccordion();
    const child: HTMLButtonElement | undefined = all<HTMLButtonElement>('.category-child')
      .find((item: HTMLButtonElement): boolean => item.textContent.trim() === name);
    if (!child) throw new Error(`No visualization named ${name}`);
    child.click();
    await fixture.whenStable();
  }

  /**
   * Picks an option in a select, as a user would.
   *
   * @param selector - CSS selector of the select
   * @param value - The option value to pick
   */
  async function choose(selector: string, value: string): Promise<void> {
    const select: HTMLSelectElement = get<HTMLSelectElement>(selector);
    select.value = value;
    select.dispatchEvent(new Event('change', {bubbles: true}));
    await fixture.whenStable();
  }

  /**
   * Sets an input's value and fires an event from it, as a user would.
   *
   * @param selector - CSS selector of the input
   * @param value - The value to enter
   * @param type - The event the control listens for
   */
  async function enter(selector: string, value: string, type: 'input' | 'change' = 'input'): Promise<void> {
    const input: HTMLInputElement = get<HTMLInputElement>(selector);
    input.value = value;
    input.dispatchEvent(new Event(type, {bubbles: true}));
    await fixture.whenStable();
  }

  /**
   * Switches a toggle, as a user would.
   *
   * @param selector - CSS selector of the checkbox
   * @param checked - The state to switch to
   */
  async function setChecked(selector: string, checked: boolean): Promise<void> {
    const input: HTMLInputElement = get<HTMLInputElement>(selector);
    input.checked = checked;
    input.dispatchEvent(new Event('change', {bubbles: true}));
    await fixture.whenStable();
  }

  /**
   * Clicks an element and waits for the view to settle.
   *
   * @param selector - CSS selector of the element
   */
  async function click(selector: string): Promise<void> {
    get<HTMLElement>(selector).click();
    await fixture.whenStable();
  }

  /**
   * Finds the dependency row for a named dependency.
   *
   * @param name - The dependency's display name
   * @returns The row element
   */
  function depRow(name: string): HTMLElement {
    const row: HTMLElement | undefined = all<HTMLElement>('.dependency-row')
      .find((item: HTMLElement): boolean => item.querySelector('.dependency-name')?.textContent.trim() === name);
    if (!row) throw new Error(`No dependency row named ${name}`);
    return row;
  }

  beforeEach(async (): Promise<void> => {
    settings = createFakeSettings();
    deps = createFakeDeps();
    electron = {platformInfo: signal<PlatformInfo>({platform: 'darwin', supportsGlass: true, systemTheme: 'dark'})};

    await TestBed.configureTestingModule({
      imports: [ConfigurationView],
      providers: [
        {provide: SettingsService, useValue: settings},
        {provide: DependencyService, useValue: deps},
        {provide: ElectronService, useValue: electron},
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfigurationView);
    component = fixture.componentInstance;
    host = fixture.nativeElement as HTMLElement;
    await fixture.whenStable();
  });

  afterEach((): void => {
    removeApi();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Navigation
  // ==========================================================================

  describe('category navigation', (): void => {
    it('lists every category in the sidebar', (): void => {
      expect(texts('.category-item > span')).toEqual([
        'Application', 'Appearance', 'Dependencies', 'Playback', 'Audio Playback', 'Audio Visualizations', 'Video Playback', 'Video Subtitles',
      ]);
    });

    it('opens on the Application category', (): void => {
      expect(get('.panel-header h2').textContent).toBe('Application');
      expect(texts('.category-item.active > span')).toEqual(['Application']);
    });

    it.each([
      ['Appearance', 'Configure window transparency and background.'],
      ['Dependencies', 'Manage required external dependencies for media playback.'],
      ['Playback', 'Configure shared playback behaviour.'],
      ['Audio Playback', 'Configure audio playback and output.'],
      ['Audio Visualizations', 'Configure audio visualization preferences.'],
      ['Video Playback', 'Configure video playback and display.'],
      ['Video Subtitles', 'Configure subtitle appearance for video playback.'],
    ])('shows the %s panel when its sidebar entry is clicked', async (name: string, description: string): Promise<void> => {
      await open(name);

      expect(get('.panel-header h2').textContent).toBe(name);
      expect(get('.panel-description').textContent).toBe(description);
      expect(texts('.category-item.active > span')).toEqual([name]);
    });

    it('replaces the previous category\'s controls', async (): Promise<void> => {
      await open('Playback');

      expect(host.querySelector('#server-port')).toBeNull();
      expect(host.querySelector('#skip-duration')).not.toBeNull();
    });

    it('opens the category given by the initialCategory input', async (): Promise<void> => {
      fixture.componentRef.setInput('initialCategory', 'subtitles');
      await fixture.whenStable();

      expect(get('.panel-header h2').textContent).toBe('Video Subtitles');
    });

    it('shows no panel for a category that does not exist', async (): Promise<void> => {
      fixture.componentRef.setInput('initialCategory', 'nonsense');
      await fixture.whenStable();

      expect(host.querySelector('.panel-header')).toBeNull();
      expect(host.querySelector('.settings-content')).toBeNull();
    });
  });

  describe('standalone window', (): void => {
    afterEach((): void => {
      window.history.replaceState({}, '', window.location.pathname);
    });

    it('opens the category named in the URL', async (): Promise<void> => {
      window.history.replaceState({}, '', '?category=dependencies');

      fixture.componentRef.setInput('isStandaloneWindow', true);
      await fixture.whenStable();

      expect(get('.panel-header h2').textContent).toBe('Dependencies');
    });

    it('stays on the default category when the URL names none', async (): Promise<void> => {
      fixture.componentRef.setInput('isStandaloneWindow', true);
      await fixture.whenStable();

      expect(get('.panel-header h2').textContent).toBe('Application');
    });

    it('ignores the URL when embedded in the main window', async (): Promise<void> => {
      window.history.replaceState({}, '', '?category=dependencies');

      fixture.componentRef.setInput('isStandaloneWindow', false);
      await fixture.whenStable();

      expect(get('.panel-header h2').textContent).toBe('Application');
    });

    it('prefers the initialCategory input over the URL', async (): Promise<void> => {
      window.history.replaceState({}, '', '?category=dependencies');

      fixture.componentRef.setInput('isStandaloneWindow', true);
      fixture.componentRef.setInput('initialCategory', 'audio');
      await fixture.whenStable();

      expect(get('.panel-header h2').textContent).toBe('Audio Playback');
    });

    it('marks the container and shows the window title', async (): Promise<void> => {
      fixture.componentRef.setInput('isStandaloneWindow', true);
      await fixture.whenStable();

      expect(get('.configuration-container').classList.contains('standalone-window')).toBe(true);
      expect(get('.header-title').textContent).toBe('ONIXPlayer Configuration');
    });

    it('shows no window title when embedded', (): void => {
      expect(get('.configuration-container').classList.contains('standalone-window')).toBe(false);
      expect(host.querySelector('.header-title')).toBeNull();
    });
  });

  describe('header', (): void => {
    it('reserves a drag region for the traffic lights on macOS', (): void => {
      expect(host.querySelector('.configuration-header')).not.toBeNull();
    });

    it('has no drag region on other platforms', async (): Promise<void> => {
      electron.platformInfo.set({platform: 'win32', supportsGlass: false, systemTheme: 'dark'});
      await fixture.whenStable();

      expect(host.querySelector('.configuration-header')).toBeNull();
    });
  });

  describe('visualizations accordion', (): void => {
    it('is collapsed to begin with', (): void => {
      expect(host.querySelector('.accordion-children')).toBeNull();
      expect(get('.accordion-toggle').classList.contains('expanded')).toBe(false);
    });

    it('lists only the visualizations that have their own settings', async (): Promise<void> => {
      await toggleAccordion();

      expect(texts('.category-child')).toEqual(['Analyzer']);
      expect(get('.accordion-toggle').classList.contains('expanded')).toBe(true);
    });

    it('does not nest the toggle inside another button', (): void => {
      expect(host.querySelector('button button')).toBeNull();
    });

    it('offers the category name as a keyboard stop of its own', (): void => {
      const name: HTMLElement = get<HTMLElement>('.category-item.has-accordion > span');

      expect(name.getAttribute('role')).toBe('button');
      expect(name.tabIndex).toBe(0);
    });

    it.each([['Enter'], [' ']])('opens the category when "%s" is pressed on its name', async (key: string): Promise<void> => {
      get<HTMLElement>('.category-item.has-accordion > span').dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true}));
      await fixture.whenStable();

      expect(get('.panel-header h2').textContent).toBe('Audio Visualizations');
    });

    it('keeps Space on the category name from scrolling the sidebar', (): void => {
      const event: KeyboardEvent = new KeyboardEvent('keydown', {key: ' ', bubbles: true, cancelable: true});

      get<HTMLElement>('.category-item.has-accordion > span').dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
    });

    it('names the category as it appears in the sidebar when pointing at the accordion', async (): Promise<void> => {
      await open('Audio Visualizations');

      expect(texts('.info-notice span')).toContain(
        'Expand "Audio Visualizations" in the sidebar to configure individual visualization settings.',
      );
    });

    it('expands without leaving the current category', async (): Promise<void> => {
      await toggleAccordion();

      expect(get('.panel-header h2').textContent).toBe('Application');
    });

    it('collapses when toggled again', async (): Promise<void> => {
      await toggleAccordion();

      await toggleAccordion();

      expect(host.querySelector('.accordion-children')).toBeNull();
    });

    it('shows a visualization\'s own settings when it is picked', async (): Promise<void> => {
      await openVisualization('Analyzer');

      expect(get('.panel-header h2').textContent).toBe('Audio Visualizations');
      expect(texts('.setting-label label')).toEqual(['Bar Density', 'Bar Color (Bottom)', 'Bar Color (Middle)', 'Bar Color (Top)']);
      expect(host.querySelector('#max-frame-rate')).toBeNull();
    });

    it('highlights the picked visualization rather than its parent category', async (): Promise<void> => {
      await openVisualization('Analyzer');

      expect(get('.category-child').classList.contains('active')).toBe(true);
      expect(host.querySelector('.category-item.active')).toBeNull();
    });

    it('returns to the global settings when the category itself is clicked', async (): Promise<void> => {
      await openVisualization('Analyzer');

      await open('Audio Visualizations');

      expect(host.querySelector('#max-frame-rate')).not.toBeNull();
      expect(get('.category-child').classList.contains('active')).toBe(false);
      expect(texts('.category-item.active > span')).toEqual(['Audio Visualizations']);
    });
  });

  // ==========================================================================
  // Controls: writing
  // ==========================================================================

  describe('writing settings', (): void => {
    it.each(SELECT_CASES)('calls $method with $args when $value is picked in #$id', async (row: WriteCase): Promise<void> => {
      await open(row.category);

      await choose(`#${row.id}`, row.value);

      expect(settings[row.method]).toHaveBeenCalledTimes(1);
      expect(settings[row.method]).toHaveBeenCalledWith(...row.args);
    });

    it.each(INPUT_CASES)('calls $method with $args when #$id is moved to $value', async (row: WriteCase): Promise<void> => {
      await open(row.category);

      await enter(`#${row.id}`, row.value);

      expect(settings[row.method]).toHaveBeenCalledTimes(1);
      expect(settings[row.method]).toHaveBeenCalledWith(...row.args);
    });

    it.each(TOGGLE_CASES)('calls $method with $args when #$id is switched on', async (row: ToggleCase): Promise<void> => {
      await open(row.category);

      await setChecked(`#${row.id}`, true);

      expect(settings[row.method]).toHaveBeenCalledTimes(1);
      expect(settings[row.method]).toHaveBeenCalledWith(...row.args);
    });

    it.each(TOGGLE_CASES)('calls $method with false when #$id is switched off', async (row: ToggleCase): Promise<void> => {
      await open(row.category);

      await setChecked(`#${row.id}`, false);

      expect(settings[row.method]).toHaveBeenCalledWith(...row.args.slice(0, -1), false);
    });
  });

  // ==========================================================================
  // Controls: reading
  // ==========================================================================

  describe('crossfade controls', (): void => {
    it('labels the visualization crossfade select by an id of its own', async (): Promise<void> => {
      await open('Audio Visualizations');

      expect(get<HTMLLabelElement>('label[for="visualization-crossfade-duration"]').textContent).toBe('Crossfade Duration');
      expect(get('#visualization-crossfade-duration').tagName).toBe('SELECT');
      expect(host.querySelector('#crossfade-duration')).toBeNull();
    });

    it('labels the track crossfade slider by an id of its own', async (): Promise<void> => {
      await open('Audio Playback');

      expect(get<HTMLLabelElement>('label[for="crossfade-duration"]').textContent).toBe('Crossfade Duration');
      expect(get<HTMLInputElement>('#crossfade-duration').type).toBe('range');
    });
  });

  describe('reflecting settings', (): void => {
    it.each(REFLECT_CASES)('shows $name', async (row: ReflectCase): Promise<void> => {
      await open(row.category);

      row.arrange(settings);
      await fixture.whenStable();

      expect(row.read(host)).toBe(row.expected);
    });
  });

  // ==========================================================================
  // Application
  // ==========================================================================

  describe('application settings', (): void => {
    it('saves a typed port number', async (): Promise<void> => {
      await enter('#server-port', '8080', 'change');

      expect(settings.setServerPort).toHaveBeenCalledWith(8080);
    });

    it('saves a cleared port field as auto-assign', async (): Promise<void> => {
      settings.serverPort.set(8080);
      await fixture.whenStable();

      await enter('#server-port', '', 'change');

      expect(settings.setServerPort).toHaveBeenCalledWith(0);
    });

    it('saves a port that is not a number as auto-assign', async (): Promise<void> => {
      await component.onServerPortChange(eventFrom('input', 'change', 'abc'));

      expect(settings.setServerPort).toHaveBeenCalledWith(0);
    });

    it('offers no reset button while the port is auto-assigned', (): void => {
      expect(host.querySelector('.port-control .reset-button')).toBeNull();
    });

    it('resets a fixed port to auto-assign', async (): Promise<void> => {
      settings.serverPort.set(8080);
      await fixture.whenStable();

      await click('.port-control .reset-button');

      expect(settings.setServerPort).toHaveBeenCalledWith(0);
    });

    it('shows no restart notice while the port is unchanged', (): void => {
      expect(host.querySelector('.restart-notice')).toBeNull();
    });

    it('warns that a changed port needs a restart', async (): Promise<void> => {
      settings.serverPort.set(8080);
      await fixture.whenStable();

      expect(get('.restart-notice').textContent).toContain('Server Port setting requires an application restart');
    });

    it('drops the restart notice when the port returns to its original value', async (): Promise<void> => {
      settings.serverPort.set(8080);
      await fixture.whenStable();

      settings.serverPort.set(0);
      await fixture.whenStable();

      expect(host.querySelector('.restart-notice')).toBeNull();
    });

    it('lists the audio, video and playlist extensions it can be associated with', (): void => {
      const badges: string[] = texts('.extension-badge');

      expect(badges).toEqual([
        '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma', '.mid', '.midi',
        '.mp4', '.m4v', '.mkv', '.avi', '.webm', '.mov',
        '.opp',
      ]);
    });

    it('explains file associations in Finder terms on macOS', (): void => {
      expect(get('.file-associations-hint').textContent).toContain('Finder');
    });

    it('explains file associations generically on other platforms', async (): Promise<void> => {
      electron.platformInfo.set({platform: 'linux', supportsGlass: false, systemTheme: 'dark'});
      await fixture.whenStable();

      expect(get('.file-associations-hint').textContent).not.toContain('Finder');
      expect(get('.file-associations-hint').textContent).toContain('"Open with"');
    });
  });

  // ==========================================================================
  // Audio
  // ==========================================================================

  describe('equalizer', (): void => {
    beforeEach(async (): Promise<void> => {
      await open('Audio Playback');
    });

    it('hides the preset, bands and reset while disabled', async (): Promise<void> => {
      settings.equalizerEnabled.set(false);
      await fixture.whenStable();

      expect(host.querySelector('#equalizer-preset')).toBeNull();
      expect(host.querySelector('.equalizer-bands')).toBeNull();
      expect(host.querySelector('.reset-button')).toBeNull();
    });

    it('labels the ten bands with their frequencies', (): void => {
      expect(texts('.equalizer-band-freq')).toEqual(['31', '62', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
    });

    it('names each band slider for assistive technology', (): void => {
      const sliders: HTMLInputElement[] = all<HTMLInputElement>('.equalizer-band-slider');

      expect(sliders[0].getAttribute('aria-label')).toBe('31Hz band');
      expect(sliders[9].getAttribute('aria-label')).toBe('16kHz band');
    });

    it('limits each band slider to the equalizer gain range', (): void => {
      const slider: HTMLInputElement = get<HTMLInputElement>('.equalizer-band-slider');

      expect(slider.min).toBe('-12');
      expect(slider.max).toBe('12');
    });

    it('shows each band\'s gain, signing boosts with a plus', async (): Promise<void> => {
      settings.equalizerBands.set([4, 3, 2, 0, -1, -1, 1, 3, 4, 12]);
      await fixture.whenStable();

      expect(texts('.equalizer-band-gain')).toEqual(['+4', '+3', '+2', '0', '-1', '-1', '+1', '+3', '+4', '+12']);
    });

    it('positions each band slider at its gain', async (): Promise<void> => {
      settings.equalizerBands.set([4, 3, 2, 0, -1, -1, 1, 3, 4, 12]);
      await fixture.whenStable();

      const values: string[] = all<HTMLInputElement>('.equalizer-band-slider').map((slider: HTMLInputElement): string => slider.value);
      expect(values).toEqual(['4', '3', '2', '0', '-1', '-1', '1', '3', '4', '12']);
    });

    it('saves a moved band with its index and gain', async (): Promise<void> => {
      const slider: HTMLInputElement = all<HTMLInputElement>('.equalizer-band-slider')[3];
      slider.value = '-6';

      slider.dispatchEvent(new Event('input', {bubbles: true}));
      await fixture.whenStable();

      expect(settings.setEqualizerBand).toHaveBeenCalledTimes(1);
      expect(settings.setEqualizerBand).toHaveBeenCalledWith(3, -6);
    });

    it('offers every preset including Custom', (): void => {
      const labels: string[] = texts('#equalizer-preset option');

      expect(labels).toEqual(['Flat', 'Rock', 'Pop', 'Jazz', 'Bass Boost', 'Vocal', 'Treble Boost', 'Custom']);
    });

    it('resets the equalizer from the reset button', async (): Promise<void> => {
      await click('.reset-button');

      expect(settings.resetEqualizer).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Video
  // ==========================================================================

  describe('hardware acceleration', (): void => {
    beforeEach(async (): Promise<void> => {
      await open('Video Playback');
    });

    it('offers only Auto and Disabled when no encoder is detected', (): void => {
      expect(texts('#hardware-acceleration option')).toEqual(['Auto (Recommended)', 'Disabled (Software Only)']);
    });

    it('explains that software encoding is used when no encoder is detected', (): void => {
      expect(get('.info-notice').textContent).toContain('No hardware encoders detected');
    });

    it('offers each detected encoder by its friendly name', async (): Promise<void> => {
      deps.hardwareEncoders.set({available: true, encoders: ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi']});
      await fixture.whenStable();

      expect(texts('#hardware-acceleration option')).toEqual([
        'Auto (Recommended)', 'Disabled (Software Only)',
        'VideoToolbox (macOS)', 'NVENC (NVIDIA)', 'Quick Sync (Intel)', 'AMF (AMD)', 'VAAPI (Linux)',
      ]);
    });

    it('offers an unrecognised encoder under its raw name', async (): Promise<void> => {
      deps.hardwareEncoders.set({available: true, encoders: ['h264_mystery']});
      await fixture.whenStable();

      expect(texts('#hardware-acceleration option')).toContain('h264_mystery');
    });

    it('hides the software-encoding notice when an encoder is detected', async (): Promise<void> => {
      deps.hardwareEncoders.set({available: true, encoders: ['h264_nvenc']});
      await fixture.whenStable();

      expect(host.querySelector('.info-notice')).toBeNull();
    });

    it('saves a detected encoder when it is picked', async (): Promise<void> => {
      deps.hardwareEncoders.set({available: true, encoders: ['h264_nvenc']});
      await fixture.whenStable();

      await choose('#hardware-acceleration', 'h264_nvenc');

      expect(settings.setHardwareAcceleration).toHaveBeenCalledWith('h264_nvenc');
    });
  });

  describe('video adjustments', (): void => {
    beforeEach(async (): Promise<void> => {
      await open('Video Playback');
    });

    it('hides the preset, sliders, invert toggle and reset while disabled', async (): Promise<void> => {
      settings.videoAdjustmentsEnabled.set(false);
      await fixture.whenStable();

      expect(host.querySelector('#video-adjustments-preset')).toBeNull();
      expect(host.querySelector('#video-adj-brightness')).toBeNull();
      expect(host.querySelector('#video-adj-invert')).toBeNull();
      expect(host.querySelector('.reset-button')).toBeNull();
    });

    it('renders one labelled slider per adjustment', (): void => {
      const labels: string[] = all<HTMLLabelElement>('label[for^="video-adj-"]').map((label: HTMLLabelElement): string => label.textContent.trim());

      expect(labels).toEqual(['Brightness', 'Contrast', 'Saturation', 'Hue', 'Soften', 'Grayscale', 'Sepia', 'Invert Colours']);
    });

    it('limits each slider to its adjustment\'s range', (): void => {
      const brightness: HTMLInputElement = get<HTMLInputElement>('#video-adj-brightness');
      const hue: HTMLInputElement = get<HTMLInputElement>('#video-adj-hue');
      const blur: HTMLInputElement = get<HTMLInputElement>('#video-adj-blur');

      expect([brightness.min, brightness.max]).toEqual(['-100', '100']);
      expect([hue.min, hue.max]).toEqual(['-180', '180']);
      expect([blur.min, blur.max]).toEqual(['0', '100']);
    });

    it('resets the adjustments from the reset button', async (): Promise<void> => {
      await click('.reset-button');

      expect(settings.resetVideoAdjustments).toHaveBeenCalledTimes(1);
    });
  });

  // ==========================================================================
  // Subtitles
  // ==========================================================================

  describe('subtitle settings', (): void => {
    beforeEach(async (): Promise<void> => {
      await open('Video Subtitles');
    });

    it('hides the shadow controls while text shadow is off', async (): Promise<void> => {
      settings.subtitleTextShadow.set(false);
      await fixture.whenStable();

      expect(host.querySelector('#subtitle-shadow-spread')).toBeNull();
      expect(host.querySelector('#subtitle-shadow-blur')).toBeNull();
      expect(host.querySelector('#subtitle-shadow-color')).toBeNull();
    });

    it('previews the font size, colour and family', async (): Promise<void> => {
      settings.subtitleFontSize.set(150);
      settings.subtitleFontColor.set('#ff0000');
      settings.subtitleFontFamily.set('monospace');
      await fixture.whenStable();

      const preview: HTMLElement = get<HTMLElement>('.subtitle-preview-text');
      expect(preview.style.fontSize).toBe('150%');
      expect(preview.style.color).toBe('rgb(255, 0, 0)');
      expect(preview.style.fontFamily).toBe('monospace');
    });

    it('previews the background colour at its opacity', async (): Promise<void> => {
      settings.subtitleBackgroundColor.set('#102030');
      settings.subtitleBackgroundOpacity.set(0.5);
      await fixture.whenStable();

      expect(get<HTMLElement>('.subtitle-preview-text').style.backgroundColor).toBe('rgba(16, 32, 48, 0.5)');
    });

    it('previews the outline built from the shadow settings', async (): Promise<void> => {
      settings.subtitleShadowSpread.set(3);
      settings.subtitleShadowBlur.set(1);
      settings.subtitleShadowColor.set('#123456');
      await fixture.whenStable();

      expect(get<HTMLElement>('.subtitle-preview-text').style.textShadow).toBe(buildTextShadow(3, 1, '#123456'));
    });

    it('previews no shadow while text shadow is off', async (): Promise<void> => {
      settings.subtitleTextShadow.set(false);
      await fixture.whenStable();

      expect(get<HTMLElement>('.subtitle-preview-text').style.textShadow).toBe('none');
    });
  });

  // ==========================================================================
  // Appearance
  // ==========================================================================

  describe('appearance settings', (): void => {
    beforeEach(async (): Promise<void> => {
      await open('Appearance');
    });

    describe('with glass enabled and supported', (): void => {
      it('describes the window colour as a tint', (): void => {
        expect(get('.setting-box .setting-description').textContent).toContain('Color tint over the glass effect');
      });

      it('shows the tint values on the colour sliders', (): void => {
        expect(get<HTMLInputElement>('#window-color-hue').value).toBe('210');
        expect(get<HTMLInputElement>('#window-color-saturation').value).toBe('60');
        expect(get<HTMLInputElement>('#window-color-lightness').value).toBe('40');
        expect(texts('.inline-slider-row .slider-value')).toEqual(['210°', '60%', '40%', '50%']);
      });

      it('previews the tint including its alpha', (): void => {
        expect(get<HTMLElement>('.color-preview').style.background).toBe('rgba(41, 102, 163, 0.5)');
      });

      it.each([
        ['window-color-hue', '200', 'setWindowTintHue', 'setBackgroundHue'],
        ['window-color-saturation', '80', 'setWindowTintSaturation', 'setBackgroundSaturation'],
        ['window-color-lightness', '25', 'setWindowTintLightness', 'setBackgroundLightness'],
      ] as const)('writes #%s to the tint, not the background', async (id: string, value: string, tint: SettingsMethod, background: SettingsMethod): Promise<void> => {
        await enter(`#${id}`, value);

        expect(settings[tint]).toHaveBeenCalledWith(Number(value));
        expect(settings[background]).not.toHaveBeenCalled();
      });

      it('enables the glass toggle', (): void => {
        expect(get<HTMLInputElement>('#glass-enabled').disabled).toBe(false);
        expect(get('.setting-description').textContent).toContain('Enables window transparency with blur effect.');
      });
    });

    describe('with glass disabled', (): void => {
      beforeEach(async (): Promise<void> => {
        settings.glassEnabled.set(false);
        await fixture.whenStable();
      });

      it('describes the window colour as a background', (): void => {
        expect(get('.setting-box .setting-description').textContent).toContain('Window background color.');
      });

      it('shows the background values on the colour sliders', (): void => {
        expect(texts('.inline-slider-row .slider-value')).toEqual(['10°', '20%', '30%']);
      });

      it('previews the opaque background colour', (): void => {
        expect(get<HTMLElement>('.color-preview').style.background).toBe('rgb(92, 66, 61)');
      });

      it('offers no alpha slider', (): void => {
        expect(host.querySelector('#window-color-alpha')).toBeNull();
      });

      it('offers no visual effect state', (): void => {
        expect(host.querySelector('#macos-visual-effect-state')).toBeNull();
      });

      it.each([
        ['window-color-hue', '200', 'setBackgroundHue', 'setWindowTintHue'],
        ['window-color-saturation', '80', 'setBackgroundSaturation', 'setWindowTintSaturation'],
        ['window-color-lightness', '25', 'setBackgroundLightness', 'setWindowTintLightness'],
      ] as const)('writes #%s to the background, not the tint', async (id: string, value: string, background: SettingsMethod, tint: SettingsMethod): Promise<void> => {
        await enter(`#${id}`, value);

        expect(settings[background]).toHaveBeenCalledWith(Number(value));
        expect(settings[tint]).not.toHaveBeenCalled();
      });
    });

    describe('on a platform without glass support', (): void => {
      beforeEach(async (): Promise<void> => {
        electron.platformInfo.set({platform: 'linux', supportsGlass: false, systemTheme: 'dark'});
        await fixture.whenStable();
      });

      it('disables the glass toggle and says why', (): void => {
        expect(get<HTMLInputElement>('#glass-enabled').disabled).toBe(true);
        expect(get('.setting-description').textContent).toContain('Glass effects are not supported on this platform.');
      });

      it('treats the window colour as a background even if glass is switched on', (): void => {
        expect(texts('.inline-slider-row .slider-value')).toEqual(['10°', '20%', '30%']);
        expect(host.querySelector('#window-color-alpha')).toBeNull();
      });

      it('writes the hue slider to the background even if glass is switched on', async (): Promise<void> => {
        await enter('#window-color-hue', '200');

        expect(settings.setBackgroundHue).toHaveBeenCalledWith(200);
        expect(settings.setWindowTintHue).not.toHaveBeenCalled();
      });

      it('offers no visual effect state', (): void => {
        expect(host.querySelector('#macos-visual-effect-state')).toBeNull();
      });
    });

    describe('visual effect state', (): void => {
      it('offers the three macOS states', (): void => {
        expect(texts('#macos-visual-effect-state option')).toEqual(['Follow Window', 'Always Active', 'Always Inactive']);
      });

      it('shows no restart notice while unchanged', (): void => {
        expect(host.querySelector('.restart-notice')).toBeNull();
      });

      it('warns that a changed state needs a restart', async (): Promise<void> => {
        settings.macOSVisualEffectState.set('active');
        await fixture.whenStable();

        expect(get('.restart-notice').textContent).toContain('Visual Effect State setting requires an application restart');
      });
    });
  });

  // ==========================================================================
  // Per-visualization settings
  // ==========================================================================

  describe('per-visualization settings', (): void => {
    beforeEach(async (): Promise<void> => {
      await openVisualization('Analyzer');
    });

    it('shows the defaults for a visualization with no custom settings', (): void => {
      expect(get<HTMLSelectElement>('.setting-control select').value).toBe('medium');
      expect(texts('.color-value')).toEqual(['#00cc00', '#cccc00', '#cc0000']);
    });

    it('shows the visualization\'s custom settings', async (): Promise<void> => {
      settings.perVisualizationSettings.set({bars: {barDensity: 'high', barColorBottom: '#111111', barColorTop: '#333333'}});
      await fixture.whenStable();

      expect(get<HTMLSelectElement>('.setting-control select').value).toBe('high');
      expect(texts('.color-value')).toEqual(['#111111', '#cccc00', '#333333']);
    });

    it('ignores custom settings that belong to another visualization', async (): Promise<void> => {
      settings.perVisualizationSettings.set({waveform: {barDensity: 'low'}});
      await fixture.whenStable();

      expect(get<HTMLSelectElement>('.setting-control select').value).toBe('medium');
    });

    it('saves a picked bar density against the visualization', async (): Promise<void> => {
      await choose('.setting-control select', 'low');

      expect(settings.setVisualizationSetting).toHaveBeenCalledWith('bars', 'barDensity', 'low');
    });

    it.each([
      [0, 'barColorBottom'],
      [1, 'barColorMiddle'],
      [2, 'barColorTop'],
    ] as const)('saves colour picker %i as %s', async (index: number, setting: LocalSettingKey): Promise<void> => {
      const picker: HTMLInputElement = all<HTMLInputElement>('input[type="color"]')[index];
      picker.value = '#123456';

      picker.dispatchEvent(new Event('input', {bubbles: true}));
      await fixture.whenStable();

      expect(settings.setVisualizationSetting).toHaveBeenCalledTimes(1);
      expect(settings.setVisualizationSetting).toHaveBeenCalledWith('bars', setting, '#123456');
    });

    it('hides the controls the visualization does not support', async (): Promise<void> => {
      settings.hasApplicableSetting.mockImplementation((_vizId: string, setting: LocalSettingKey): boolean => setting === 'barDensity');
      settings.perVisualizationSettings.set({bars: {}});
      await fixture.whenStable();

      expect(texts('.setting-label label')).toEqual(['Bar Density']);
    });

    it('reports whether a setting has been customised', async (): Promise<void> => {
      settings.perVisualizationSettings.set({bars: {barDensity: 'high'}});
      await fixture.whenStable();

      expect(component.hasCustomSetting('bars', 'barDensity')).toBe(true);
      expect(component.hasCustomSetting('bars', 'barColorTop')).toBe(false);
    });

    it('reports a customised setting of a visualization other than the one shown', async (): Promise<void> => {
      settings.perVisualizationSettings.set({waveform: {lineWidth: 3}});
      await fixture.whenStable();

      expect(component.hasCustomSetting('waveform', 'lineWidth')).toBe(true);
    });

    it('does not credit the shown visualization\'s customised setting to another visualization', async (): Promise<void> => {
      settings.perVisualizationSettings.set({bars: {barDensity: 'high'}});
      await fixture.whenStable();

      expect(component.hasCustomSetting('waveform', 'barDensity')).toBe(false);
    });

    it('resets a single setting through the service', async (): Promise<void> => {
      await component.onResetPerVizSetting('bars', 'barDensity');

      expect(settings.resetVisualizationSetting).toHaveBeenCalledWith('bars', 'barDensity');
    });

    it('resets all of a visualization\'s settings through the service', async (): Promise<void> => {
      await component.onResetAllVisualizationSettings('bars');

      expect(settings.resetAllVisualizationSettings).toHaveBeenCalledWith('bars');
    });

    it('names a known visualization by its display name', (): void => {
      expect(component.getVisualizationName('bars')).toBe('Analyzer');
    });

    it('names an unknown visualization by its id', (): void => {
      expect(component.getVisualizationName('nonsense')).toBe('nonsense');
    });
  });

  // ==========================================================================
  // Dependencies
  // ==========================================================================

  describe('dependencies', (): void => {
    beforeEach(async (): Promise<void> => {
      deps.dependencyState.set(createDepState());
      await open('Dependencies');
    });

    describe('rows', (): void => {
      it('shows nothing until the dependency state has loaded', async (): Promise<void> => {
        deps.dependencyState.set(null);
        await fixture.whenStable();

        expect(host.querySelector('.dependency-row')).toBeNull();
      });

      it('lists FFmpeg, FluidSynth and yt-dlp in that order', (): void => {
        expect(texts('.dependency-name')).toEqual(['FFmpeg', 'FluidSynth', 'yt-dlp']);
      });

      it('shows each dependency\'s description', (): void => {
        expect(texts('.dependency-description')).toEqual(['Media transcoding', 'MIDI synthesis', 'Internet media']);
      });

      it('marks an installed dependency with a tick', (): void => {
        const indicator: HTMLElement = depRow('FFmpeg').querySelector<HTMLElement>('.dependency-indicator')!;

        expect(indicator.classList.contains('installed')).toBe(true);
        expect(indicator.querySelector('i')?.classList.contains('fa-circle-check')).toBe(true);
      });

      it('marks a missing dependency with a cross', (): void => {
        const indicator: HTMLElement = depRow('yt-dlp').querySelector<HTMLElement>('.dependency-indicator')!;

        expect(indicator.classList.contains('missing')).toBe(true);
        expect(indicator.querySelector('i')?.classList.contains('fa-circle-xmark')).toBe(true);
      });

      it('describes a bundled dependency as built in, with its version', (): void => {
        expect(depRow('FFmpeg').querySelector('.dependency-path')?.textContent).toBe('Built in · 9.0.2');
      });

      it('describes a bundled dependency of unknown version as just built in', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ffmpeg: createDep({version: null})}));
        await fixture.whenStable();

        expect(depRow('FFmpeg').querySelector('.dependency-path')?.textContent).toBe('Built in');
      });

      it('describes a downloaded dependency with its version', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ytdlp: DOWNLOADED_YTDLP}));
        await fixture.whenStable();

        expect(depRow('yt-dlp').querySelector('.dependency-path')?.textContent).toBe('Downloaded · 2026.10.01');
      });

      it('describes a managed dependency that is absent as not downloaded', (): void => {
        expect(depRow('yt-dlp').querySelector('.dependency-path')?.textContent).toBe('Not downloaded');
      });

      it('describes an unmanaged dependency that is absent as missing from the build', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ffmpeg: createDep({installed: false, source: null, path: null, version: null})}));
        await fixture.whenStable();

        expect(depRow('FFmpeg').querySelector('.dependency-path')?.textContent).toBe('Missing from this build of ONIXPlayer');
      });

      it('describes a system dependency by its path', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({fluidsynth: createDep({id: 'fluidsynth', name: 'FluidSynth', source: 'system', path: '/usr/bin/fluidsynth'})}));
        await fixture.whenStable();

        expect(depRow('FluidSynth').querySelector('.dependency-path')?.textContent).toBe('Using /usr/bin/fluidsynth');
      });

      it('flags a system FFmpeg that cannot play tracker modules', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ffmpeg: createDep({source: 'system', path: '/usr/bin/ffmpeg'}), trackerSupport: false}));
        await fixture.whenStable();

        expect(depRow('FFmpeg').querySelector('.dependency-path')?.textContent).toBe('Using /usr/bin/ffmpeg (no tracker module support)');
      });

      it('does not flag a system FFmpeg that can play tracker modules', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ffmpeg: createDep({source: 'system', path: '/usr/bin/ffmpeg'}), trackerSupport: true}));
        await fixture.whenStable();

        expect(depRow('FFmpeg').querySelector('.dependency-path')?.textContent).toBe('Using /usr/bin/ffmpeg');
      });

      it('shows the full path as a tooltip', (): void => {
        expect(depRow('FFmpeg').querySelector<HTMLElement>('.dependency-path')?.title).toBe('/app/bin/ffmpeg');
      });

      it('shows an empty tooltip when there is no path', (): void => {
        expect(depRow('yt-dlp').querySelector<HTMLElement>('.dependency-path')?.title).toBe('');
      });
    });

    describe('actions', (): void => {
      it('offers no download, update or remove for a built-in dependency', (): void => {
        expect(depRow('FFmpeg').querySelector('.dependency-button')).toBeNull();
      });

      it('offers only Download for a managed dependency that is absent', (): void => {
        const labels: string[] = Array.from(depRow('yt-dlp').querySelectorAll('.dependency-button'))
          .map((button: Element): string => button.textContent.trim());

        expect(labels).toEqual(['Download']);
      });

      it('downloads the dependency when Download is clicked', async (): Promise<void> => {
        depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.install')!.click();
        await fixture.whenStable();

        expect(deps.installDependency).toHaveBeenCalledWith('yt-dlp');
      });

      it('offers Update and Remove for a downloaded dependency', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ytdlp: DOWNLOADED_YTDLP}));
        await fixture.whenStable();

        const labels: string[] = Array.from(depRow('yt-dlp').querySelectorAll('.dependency-button'))
          .map((button: Element): string => button.textContent.trim());
        expect(labels).toEqual(['Update', 'Remove']);
      });

      it('updates the dependency when Update is clicked', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ytdlp: DOWNLOADED_YTDLP}));
        await fixture.whenStable();

        depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.update')!.click();
        await fixture.whenStable();

        expect(deps.updateDependency).toHaveBeenCalledWith('yt-dlp');
      });

      it('removes the dependency when Remove is clicked', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ytdlp: DOWNLOADED_YTDLP}));
        await fixture.whenStable();

        depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.uninstall')!.click();
        await fixture.whenStable();

        expect(deps.uninstallDependency).toHaveBeenCalledWith('yt-dlp');
      });

      it('disables Download while another operation is running', async (): Promise<void> => {
        deps.isOperationInProgress.set(true);
        await fixture.whenStable();

        expect(depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.install')?.disabled).toBe(true);
      });

      it('disables Update and Remove while another operation is running', async (): Promise<void> => {
        deps.dependencyState.set(createDepState({ytdlp: DOWNLOADED_YTDLP}));
        deps.isOperationInProgress.set(true);
        await fixture.whenStable();

        expect(depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.update')?.disabled).toBe(true);
        expect(depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.uninstall')?.disabled).toBe(true);
      });

      it('enables Download when no operation is running', (): void => {
        expect(depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.install')?.disabled).toBe(false);
      });

      it('drops focus from an action button once the mouse is released', (): void => {
        const button: HTMLButtonElement = depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-button.install')!;
        button.focus();

        button.dispatchEvent(new MouseEvent('mouseup', {bubbles: true}));

        expect(document.activeElement).not.toBe(button);
      });
    });

    describe('website links', (): void => {
      it('opens the dependency\'s website through the preload bridge', async (): Promise<void> => {
        const api: MockApi = installApi();

        depRow('FluidSynth').querySelector<HTMLButtonElement>('.dependency-link')!.click();
        await fixture.whenStable();

        expect(api.openExternal).toHaveBeenCalledTimes(1);
        expect(api.openExternal).toHaveBeenCalledWith('https://www.fluidsynth.org');
      });

      it('never opens the website in an application window', async (): Promise<void> => {
        installApi();
        const windowOpen: ReturnType<typeof vi.spyOn> = vi.spyOn(window, 'open').mockReturnValue(null);

        depRow('FFmpeg').querySelector<HTMLButtonElement>('.dependency-link')!.click();
        await fixture.whenStable();

        expect(windowOpen).not.toHaveBeenCalled();
      });

      it('does nothing when the preload bridge is absent', (): void => {
        const windowOpen: ReturnType<typeof vi.spyOn> = vi.spyOn(window, 'open').mockReturnValue(null);
        const link: HTMLButtonElement = depRow('FFmpeg').querySelector<HTMLButtonElement>('.dependency-link')!;

        expect((): void => link.click()).not.toThrow();
        expect(windowOpen).not.toHaveBeenCalled();
      });

      it('names the website link after the dependency', (): void => {
        expect(depRow('yt-dlp').querySelector<HTMLButtonElement>('.dependency-link')?.title).toBe('yt-dlp website');
      });
    });

    describe('progress', (): void => {
      it('shows no progress when nothing is running', (): void => {
        expect(host.querySelector('.install-progress')).toBeNull();
      });

      it.each(['installing', 'updating', 'uninstalling'] as const)('shows the message and a spinner while %s', async (status: InstallProgress['status']): Promise<void> => {
        deps.installProgress.set({dependencyId: 'yt-dlp', status, message: 'Working on yt-dlp...'});
        await fixture.whenStable();

        const progress: HTMLElement = get<HTMLElement>('.install-progress');
        expect(progress.querySelector('.install-progress-header span')?.textContent).toBe('Working on yt-dlp...');
        expect(progress.querySelector('.fa-spinner')).not.toBeNull();
        expect(progress.classList.contains('error')).toBe(false);
      });

      it('shows the operation\'s output while it runs', async (): Promise<void> => {
        deps.installProgress.set({dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading', output: '42% of 12 MB'});
        await fixture.whenStable();

        expect(get('.install-output').textContent).toBe('42% of 12 MB');
      });

      it('shows no output block when the operation has produced none', async (): Promise<void> => {
        deps.installProgress.set({dependencyId: 'yt-dlp', status: 'installing', message: 'Downloading'});
        await fixture.whenStable();

        expect(host.querySelector('.install-output')).toBeNull();
      });

      it('shows a failure as an error with its message', async (): Promise<void> => {
        deps.installProgress.set({dependencyId: 'yt-dlp', status: 'error', message: 'Download failed'});
        await fixture.whenStable();

        const progress: HTMLElement = get<HTMLElement>('.install-progress');
        expect(progress.classList.contains('error')).toBe(true);
        expect(progress.querySelector('span')?.textContent).toBe('Download failed');
        expect(progress.querySelector('.fa-spinner')).toBeNull();
        expect(progress.querySelector('.install-output')).toBeNull();
      });

      it('shows a failure\'s output', async (): Promise<void> => {
        deps.installProgress.set({dependencyId: 'yt-dlp', status: 'error', message: 'Download failed', output: 'HTTP 503'});
        await fixture.whenStable();

        expect(get('.install-progress.error .install-output').textContent).toBe('HTTP 503');
      });

      it('shows nothing once the operation has succeeded', async (): Promise<void> => {
        deps.installProgress.set({dependencyId: 'yt-dlp', status: 'success', message: 'Done'});
        await fixture.whenStable();

        expect(host.querySelector('.install-progress')).toBeNull();
      });
    });

    describe('SoundFonts', (): void => {
      const SOUNDFONTS: SoundFontInfo[] = [
        {fileName: 'tiny.sf2', filePath: '/data/soundfonts/tiny.sf2', sizeBytes: 512},
        {fileName: 'small.sf2', filePath: '/data/soundfonts/small.sf2', sizeBytes: 1536},
        {fileName: 'general.sf2', filePath: '/data/soundfonts/general.sf2', sizeBytes: 148 * 1024 * 1024},
      ];

      it('hides the section when FluidSynth is not installed', (): void => {
        expect(host.querySelector('.soundfont-section')).toBeNull();
      });

      describe('with FluidSynth installed', (): void => {
        beforeEach(async (): Promise<void> => {
          deps.fluidsynthInstalled.set(true);
          await fixture.whenStable();
        });

        it('says so when no SoundFont is installed', (): void => {
          expect(get('.soundfont-empty').textContent).toContain('No SoundFonts installed');
          expect(host.querySelector('.soundfont-list')).toBeNull();
        });

        it('lists the installed SoundFonts', async (): Promise<void> => {
          deps.soundFonts.set(SOUNDFONTS);
          await fixture.whenStable();

          expect(texts('.soundfont-name')).toEqual(['tiny.sf2', 'small.sf2', 'general.sf2']);
          expect(host.querySelector('.soundfont-empty')).toBeNull();
        });

        it('shows each SoundFont\'s size in bytes, kilobytes or megabytes', async (): Promise<void> => {
          deps.soundFonts.set(SOUNDFONTS);
          await fixture.whenStable();

          expect(texts('.soundfont-size')).toEqual(['512 B', '1.5 KB', '148.0 MB']);
        });

        it('marks only the active SoundFont as selected', async (): Promise<void> => {
          deps.soundFonts.set(SOUNDFONTS);
          deps.activeSoundFont.set('/data/soundfonts/small.sf2');
          await fixture.whenStable();

          const selected: boolean[] = all<HTMLElement>('.soundfont-item').map((item: HTMLElement): boolean => item.classList.contains('selected'));
          const radios: boolean[] = all<HTMLElement>('.soundfont-radio').map((radio: HTMLElement): boolean => radio.classList.contains('active'));
          expect(selected).toEqual([false, true, false]);
          expect(radios).toEqual([false, true, false]);
        });

        it('marks none as selected when no SoundFont is active', async (): Promise<void> => {
          deps.soundFonts.set(SOUNDFONTS);
          await fixture.whenStable();

          expect(host.querySelector('.soundfont-item.selected')).toBeNull();
        });

        it('activates a SoundFont when its radio is clicked', async (): Promise<void> => {
          deps.soundFonts.set(SOUNDFONTS);
          await fixture.whenStable();

          all<HTMLButtonElement>('.soundfont-select')[2].click();
          await fixture.whenStable();

          expect(deps.setActiveSoundFont).toHaveBeenCalledWith('general.sf2');
        });

        it('removes a SoundFont when its bin is clicked', async (): Promise<void> => {
          deps.soundFonts.set(SOUNDFONTS);
          await fixture.whenStable();

          all<HTMLButtonElement>('.soundfont-remove')[0].click();
          await fixture.whenStable();

          expect(deps.removeSoundFont).toHaveBeenCalledWith('tiny.sf2');
        });

        it('starts a SoundFont install from the install button', async (): Promise<void> => {
          await click('.soundfont-install');

          expect(deps.installSoundFont).toHaveBeenCalledTimes(1);
        });

        it('shows why the last SoundFont operation failed', async (): Promise<void> => {
          deps.soundFontError.set('Not a SoundFont file');
          await fixture.whenStable();

          expect(get('.soundfont-section .install-progress.error span').textContent).toBe('Not a SoundFont file');
        });

        it('shows no error when the last SoundFont operation succeeded', (): void => {
          expect(host.querySelector('.soundfont-section .install-progress')).toBeNull();
        });
      });
    });
  });

  // ==========================================================================
  // Events without a usable value
  // ==========================================================================

  describe('events that carry no usable value', (): void => {
    it.each([
      ['onMaxFrameRateChange', 'setMaxFrameRate'],
      ['onFftSizeChange', 'setFftSize'],
      ['onVisualizationCrossfadeDurationChange', 'setVisualizationCrossfadeDuration'],
      ['onAudioBitrateChange', 'setAudioBitrate'],
      ['onSubtitleFontFamilyChange', 'setSubtitleFontFamily'],
      ['onEqualizerPresetChange', 'setEqualizerPreset'],
      ['onVideoAdjustmentPresetChange', 'setVideoAdjustmentPreset'],
    ] as const)('%s ignores an event that did not come from a select', async (
      handler: 'onMaxFrameRateChange' | 'onFftSizeChange' | 'onVisualizationCrossfadeDurationChange' | 'onAudioBitrateChange' | 'onSubtitleFontFamilyChange' | 'onEqualizerPresetChange' | 'onVideoAdjustmentPresetChange',
      method: SettingsMethod,
    ): Promise<void> => {
      await component[handler](eventFrom('div', 'change'));

      expect(settings[method]).not.toHaveBeenCalled();
    });

    it.each([
      ['onDefaultVolumeChange', 'setDefaultVolume'],
      ['onCrossfadeDurationChange', 'setCrossfadeDuration'],
      ['onAutoHideDelayChange', 'setControlsAutoHideDelay'],
      ['onPreviousTrackThresholdChange', 'setPreviousTrackThreshold'],
      ['onSkipDurationChange', 'setSkipDuration'],
      ['onSubtitleFontSizeChange', 'setSubtitleFontSize'],
      ['onSubtitleFontColorChange', 'setSubtitleFontColor'],
      ['onSubtitleBackgroundColorChange', 'setSubtitleBackgroundColor'],
      ['onSubtitleBackgroundOpacityChange', 'setSubtitleBackgroundOpacity'],
      ['onSubtitleShadowSpreadChange', 'setSubtitleShadowSpread'],
      ['onSubtitleShadowBlurChange', 'setSubtitleShadowBlur'],
      ['onSubtitleShadowColorChange', 'setSubtitleShadowColor'],
      ['onWindowTintAlphaChange', 'setWindowTintAlpha'],
      ['onBackgroundColorChange', 'setBackgroundColor'],
      ['onBackgroundHueChange', 'setBackgroundHue'],
      ['onBackgroundSaturationChange', 'setBackgroundSaturation'],
      ['onBackgroundLightnessChange', 'setBackgroundLightness'],
      ['onWindowTintHueChange', 'setWindowTintHue'],
      ['onWindowTintSaturationChange', 'setWindowTintSaturation'],
      ['onWindowTintLightnessChange', 'setWindowTintLightness'],
      ['onEqualizerToggle', 'setEqualizerEnabled'],
      ['onVideoAdjustmentsToggle', 'setVideoAdjustmentsEnabled'],
      ['onVideoAdjustmentInvertToggle', 'setVideoAdjustment'],
      ['onGlassEnabledChange', 'setGlassEnabled'],
      ['onMiniplayerOnFocusLossToggle', 'setMiniplayerOnFocusLoss'],
    ] as const)('%s ignores an event that did not come from an input', async (
      handler: 'onDefaultVolumeChange' | 'onCrossfadeDurationChange' | 'onAutoHideDelayChange' | 'onPreviousTrackThresholdChange' | 'onSkipDurationChange' | 'onSubtitleFontSizeChange' | 'onSubtitleFontColorChange' | 'onSubtitleBackgroundColorChange' | 'onSubtitleBackgroundOpacityChange' | 'onSubtitleShadowSpreadChange' | 'onSubtitleShadowBlurChange' | 'onSubtitleShadowColorChange' | 'onWindowTintAlphaChange' | 'onBackgroundColorChange' | 'onBackgroundHueChange' | 'onBackgroundSaturationChange' | 'onBackgroundLightnessChange' | 'onWindowTintHueChange' | 'onWindowTintSaturationChange' | 'onWindowTintLightnessChange' | 'onEqualizerToggle' | 'onVideoAdjustmentsToggle' | 'onVideoAdjustmentInvertToggle' | 'onGlassEnabledChange' | 'onMiniplayerOnFocusLossToggle',
      method: SettingsMethod,
    ): Promise<void> => {
      await component[handler](eventFrom('div', 'input'));

      expect(settings[method]).not.toHaveBeenCalled();
    });

    it.each([
      ['onWindowColorHueChange', 'setWindowTintHue', 'setBackgroundHue'],
      ['onWindowColorSaturationChange', 'setWindowTintSaturation', 'setBackgroundSaturation'],
      ['onWindowColorLightnessChange', 'setWindowTintLightness', 'setBackgroundLightness'],
    ] as const)('%s writes neither colour for an event that did not come from an input', async (
      handler: 'onWindowColorHueChange' | 'onWindowColorSaturationChange' | 'onWindowColorLightnessChange',
      tint: SettingsMethod,
      background: SettingsMethod,
    ): Promise<void> => {
      await component[handler](eventFrom('div', 'input'));

      expect(settings[tint]).not.toHaveBeenCalled();
      expect(settings[background]).not.toHaveBeenCalled();
    });

    it('ignores an equalizer band event that did not come from an input', async (): Promise<void> => {
      await component.onEqualizerBandChange(0, eventFrom('div', 'input'));

      expect(settings.setEqualizerBand).not.toHaveBeenCalled();
    });

    it('ignores a video adjustment event that did not come from an input', async (): Promise<void> => {
      await component.onVideoAdjustmentChange('brightness', eventFrom('div', 'input'));

      expect(settings.setVideoAdjustment).not.toHaveBeenCalled();
    });

    it('treats a text shadow event that did not come from a checkbox as switched off', async (): Promise<void> => {
      await component.onSubtitleTextShadowChange(eventFrom('input', 'change', 'on'));

      expect(settings.setSubtitleTextShadow).toHaveBeenCalledWith(false);
    });
  });

  // ==========================================================================
  // Handlers with no control in the template
  // ==========================================================================

  describe('colour handlers that are not bound to a control', (): void => {
    it.each([
      ['onBackgroundColorChange', '#abcdef', 'setBackgroundColor', '#abcdef'],
      ['onBackgroundHueChange', '120', 'setBackgroundHue', 120],
      ['onBackgroundSaturationChange', '45.5', 'setBackgroundSaturation', 45.5],
      ['onBackgroundLightnessChange', '12', 'setBackgroundLightness', 12],
      ['onWindowTintHueChange', '300', 'setWindowTintHue', 300],
      ['onWindowTintSaturationChange', '70', 'setWindowTintSaturation', 70],
      ['onWindowTintLightnessChange', '55', 'setWindowTintLightness', 55],
    ] as const)('%s saves the value %s', async (
      handler: 'onBackgroundColorChange' | 'onBackgroundHueChange' | 'onBackgroundSaturationChange' | 'onBackgroundLightnessChange' | 'onWindowTintHueChange' | 'onWindowTintSaturationChange' | 'onWindowTintLightnessChange',
      value: string,
      method: SettingsMethod,
      expected: string | number,
    ): Promise<void> => {
      await component[handler](eventFrom('input', 'input', value));

      expect(settings[method]).toHaveBeenCalledWith(expected);
    });

    it('exposes the background colour from the service', (): void => {
      settings.backgroundColor.set('#0a0b0c');

      expect(component.currentBackgroundColor()).toBe('#0a0b0c');
    });
  });

  describe('custom visualization settings with no visualization picked', (): void => {
    it('reports a customised setting of the visualization asked about', (): void => {
      settings.perVisualizationSettings.set({bars: {barDensity: 'high'}});

      expect(component.hasCustomSetting('bars', 'barDensity')).toBe(true);
    });
  });

  describe('per-dependency status', (): void => {
    it('is null for every dependency until the state has loaded', (): void => {
      expect(component.ffmpegStatus()).toBeNull();
      expect(component.fluidsynthStatus()).toBeNull();
      expect(component.ytdlpStatus()).toBeNull();
    });

    it('reports no tracker support until the state has loaded', (): void => {
      expect(component.trackerSupported()).toBe(false);
    });

    it('exposes each dependency from the loaded state', (): void => {
      const state: DependencyState = createDepState();

      deps.dependencyState.set(state);

      expect(component.ffmpegStatus()).toBe(state.ffmpeg);
      expect(component.fluidsynthStatus()).toBe(state.fluidsynth);
      expect(component.ytdlpStatus()).toBe(state.ytdlp);
    });
  });
});
