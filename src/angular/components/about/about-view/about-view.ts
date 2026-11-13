/**
 * @fileoverview About view component displaying application information.
 *
 * This component displays application metadata including:
 * - Logo and version
 * - License information (MIT)
 * - Supported media formats
 * - External dependencies (FFmpeg, FluidSynth)
 * - The licences of everything shipped, and where the bundled programs' source is
 * - Links to GitHub and onixlabs.io
 *
 * @module app/components/about/about-view
 */

import {Component, ChangeDetectionStrategy, OnInit, Signal, WritableSignal, computed, signal} from '@angular/core';
import type {AboutInfo, LicenseNotice} from '../../../types/electron';

/**
 * Version information for Electron and its components.
 */
interface VersionInfo {
  readonly electron: string;
  readonly node: string;
  readonly chrome: string;
  readonly v8: string;
}

/**
 * Supported audio file extensions.
 */
const AUDIO_EXTENSIONS: readonly string[] = [
  'MP3', 'FLAC', 'WAV', 'OGG', 'M4A', 'AAC', 'WMA', 'MIDI'
];

/**
 * Supported video file extensions.
 */
const VIDEO_EXTENSIONS: readonly string[] = [
  'MP4', 'M4V', 'MKV', 'AVI', 'WebM', 'MOV'
];

/**
 * External dependency information.
 */
interface Dependency {
  readonly name: string;
  readonly description: string;
  readonly url: string;
}

/**
 * External dependencies used by the application.
 */
const DEPENDENCIES: readonly Dependency[] = [
  {
    name: 'FFmpeg',
    description: 'Media transcoding and format conversion',
    url: 'https://ffmpeg.org'
  },
  {
    name: 'FluidSynth',
    description: 'MIDI synthesis and playback',
    url: 'https://www.fluidsynth.org'
  },
  {
    name: 'libopenmpt',
    description: 'Tracker module decoding (MOD, XM, IT, Oktalyzer, etc.)',
    url: 'https://lib.openmpt.org'
  }
];

/**
 * About view component displaying application information.
 *
 * Features:
 * - Application logo and version display
 * - MIT license notice
 * - Supported audio and video formats
 * - External dependency credits
 * - Third-party licences, each opened in the OS's viewer
 * - Links to project resources
 *
 * @example
 * <app-about-view />
 */
@Component({
  selector: 'app-about-view',
  standalone: true,
  imports: [],
  templateUrl: './about-view.html',
  styleUrl: './about-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutView implements OnInit {
  // ============================================================================
  // Template Data
  // ============================================================================

  /** Version and licences from the main process; null until loaded, or outside Electron */
  private readonly aboutInfo: WritableSignal<AboutInfo | null> = signal<AboutInfo | null>(null);

  /** Application version, from package.json */
  public readonly version: Signal<string> = computed<string>((): string => this.aboutInfo()?.version ?? '');

  /** Licences of everything shipped */
  public readonly licenses: Signal<readonly LicenseNotice[]> = computed<readonly LicenseNotice[]>((): readonly LicenseNotice[] => this.aboutInfo()?.licenses ?? []);

  /** The GitHub release carrying the bundled programs' source */
  public readonly sourceUrl: Signal<string | null> = computed<string | null>((): string | null => this.aboutInfo()?.sourceUrl ?? null);

  /** Version info for Electron and components */
  public readonly versionInfo: VersionInfo | null = window.mediaPlayer?.getVersionInfo() ?? null;

  /** Supported audio extensions */
  public readonly audioExtensions: readonly string[] = AUDIO_EXTENSIONS;

  /** Supported video extensions */
  public readonly videoExtensions: readonly string[] = VIDEO_EXTENSIONS;

  /** External dependencies */
  public readonly dependencies: readonly Dependency[] = DEPENDENCIES;

  /** GitHub repository URL */
  public readonly githubUrl: string = 'https://github.com/onix-labs/onixlabs-media-player';

  /** ONIX Labs website URL */
  public readonly onixlabsUrl: string = 'https://onixlabs.io';

  /** Current year for copyright */
  public readonly currentYear: number = new Date().getFullYear();

  // ============================================================================
  // Lifecycle
  // ============================================================================

  public async ngOnInit(): Promise<void> {
    const info: AboutInfo | undefined = await window.mediaPlayer?.getAboutInfo();
    if (info) this.aboutInfo.set(info);
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  /**
   * Opens a licence's text in the OS's default viewer.
   *
   * @param id - The licence id
   */
  public openLicense(id: string): void {
    void window.mediaPlayer?.openLicense(id);
  }

  /**
   * Opens an external URL in the default system browser.
   *
   * @param url - The URL to open
   */
  public openExternal(url: string): void {
    void window.mediaPlayer?.openExternal(url);
  }
}
