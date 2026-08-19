/**
 * @fileoverview Remembers which subtitle and audio track a file was last using.
 *
 * The video outlet is destroyed and rebuilt whenever the view mode changes —
 * entering fullscreen, switching to the miniplayer — and each rebuild reloads
 * the file from scratch. Without somewhere outside the component to keep it,
 * the user's track choice is lost every time.
 *
 * Deliberately session-scoped and in-memory: this is "what you picked a moment
 * ago", not a persisted preference. Persisted defaults live in
 * {@link SettingsService} as the preferred audio/subtitle language.
 *
 * @module app/services/track-selection-cache.service
 */

import {Injectable} from '@angular/core';

/**
 * Per-file track selections, surviving component teardown.
 */
@Injectable({providedIn: 'root'})
export class TrackSelectionCache {
  /** Subtitle track index per file path. */
  private readonly subtitleSelections: Map<string, number> = new Map<string, number>();

  /** Audio track index per file path. */
  private readonly audioSelections: Map<string, number> = new Map<string, number>();

  /**
   * Gets the cached subtitle track selection for a file path.
   *
   * @param filePath - The media file path
   * @returns The selected track index, or undefined if no cached selection
   */
  public getSubtitleSelection(filePath: string): number | undefined {
    return this.subtitleSelections.get(filePath);
  }

  /**
   * Caches the subtitle track selection for a file path.
   *
   * @param filePath - The media file path
   * @param trackIndex - The selected track index (-1 for off, -2 for external)
   */
  public setSubtitleSelection(filePath: string, trackIndex: number): void {
    this.subtitleSelections.set(filePath, trackIndex);
  }

  /**
   * Clears the subtitle selection cache for a file path.
   *
   * @param filePath - The media file path
   */
  public clearSubtitleSelection(filePath: string): void {
    this.subtitleSelections.delete(filePath);
  }

  /**
   * Gets the cached audio track selection for a file path.
   *
   * @param filePath - The media file path
   * @returns The selected track index, or undefined if no cached selection
   */
  public getAudioSelection(filePath: string): number | undefined {
    return this.audioSelections.get(filePath);
  }

  /**
   * Caches the audio track selection for a file path.
   *
   * @param filePath - The media file path
   * @param trackIndex - The selected track index (0-based)
   */
  public setAudioSelection(filePath: string, trackIndex: number): void {
    this.audioSelections.set(filePath, trackIndex);
  }

  /**
   * Clears the audio selection cache for a file path.
   *
   * @param filePath - The media file path
   */
  public clearAudioSelection(filePath: string): void {
    this.audioSelections.delete(filePath);
  }

  /** Forgets every cached selection. */
  public clear(): void {
    this.subtitleSelections.clear();
    this.audioSelections.clear();
  }
}
