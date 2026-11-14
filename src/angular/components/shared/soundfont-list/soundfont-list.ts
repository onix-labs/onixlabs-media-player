/**
 * @fileoverview The list of installed SoundFonts, shared by the settings
 * window and the setup wizard.
 *
 * Each row shows a SoundFont's name and size, a radio that makes it the one
 * MIDI is played with, and a button that removes it. One component rather
 * than a copy in each window, so the two lists cannot drift apart.
 *
 * It renders only the list. What to say when nothing is installed, and how
 * a SoundFont is added, belong to the window it sits in.
 *
 * @module app/components/shared/soundfont-list
 */

import {Component, ChangeDetectionStrategy, inject} from '@angular/core';
import {DependencyService} from '../../../services/dependency.service';
import type {SoundFontInfo} from '../../../services/dependency.service';

/**
 * The installed SoundFonts, with the active one marked.
 *
 * @example
 * @if (soundFonts().length > 0) {
 *   <app-soundfont-list/>
 * }
 */
@Component({
  selector: 'app-soundfont-list',
  standalone: true,
  templateUrl: './soundfont-list.html',
  styleUrl: './soundfont-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SoundFontList {
  /** Source of the installed SoundFonts and of the commands on them */
  private readonly dependencies: DependencyService = inject(DependencyService);

  /** The installed SoundFonts */
  public readonly soundFonts: DependencyService['soundFonts'] = this.dependencies.soundFonts;

  /**
   * Whether a SoundFont is the one MIDI is played with. The dependency state
   * records the active SoundFont by path, so that is what is compared.
   *
   * @param soundFont - The SoundFont to check
   * @returns true if it is the active SoundFont
   */
  public isActive(soundFont: SoundFontInfo): boolean {
    return soundFont.filePath === this.dependencies.activeSoundFont();
  }

  /**
   * Makes a SoundFont the one MIDI is played with.
   *
   * @param fileName - The SoundFont's file name
   */
  public async select(fileName: string): Promise<void> {
    await this.dependencies.setActiveSoundFont(fileName);
  }

  /**
   * Removes an installed SoundFont.
   *
   * @param fileName - The SoundFont's file name
   */
  public async remove(fileName: string): Promise<void> {
    await this.dependencies.removeSoundFont(fileName);
  }

  /**
   * Formats a file size for display.
   *
   * @param bytes - Size in bytes
   * @returns The size in bytes, kilobytes or megabytes
   */
  public formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
