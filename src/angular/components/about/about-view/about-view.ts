/**
 * @fileoverview About view component displaying application information.
 *
 * This component displays application metadata including:
 * - Logo and version
 * - License information (MIT)
 * - Supported media formats
 * - External dependencies (FFmpeg, FluidSynth)
 * - Links to GitHub and onixlabs.io
 *
 * @module app/components/about/about-view
 */

import {Component, output, ChangeDetectionStrategy} from '@angular/core';

/**
 * Application version (CalVer format).
 */
const APP_VERSION: string = '2026.0.0';

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
 * - Links to project resources
 *
 * @example
 * <app-about-view (close)="exitAboutMode()" />
 */
@Component({
  selector: 'app-about-view',
  standalone: true,
  imports: [],
  templateUrl: './about-view.html',
  styleUrl: './about-view.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AboutView {
  // ============================================================================
  // Outputs
  // ============================================================================

  /** Event emitted when the close button is clicked */
  public readonly close = output<void>();

  // ============================================================================
  // Template Data
  // ============================================================================

  /** Application version */
  public readonly version: string = APP_VERSION;

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
  // Event Handlers
  // ============================================================================

  /**
   * Handles close button click.
   * Emits the close event to return to the media player view.
   */
  public onClose(): void {
    this.close.emit();
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
