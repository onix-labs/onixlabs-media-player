/**
 * @fileoverview Shared media-related constants.
 *
 * This module provides common constants used across multiple components
 * for media file handling and validation.
 *
 * @module app/constants/media.constants
 */

/**
 * File extensions requiring FFmpeg (audio and video formats).
 */
export const FFMPEG_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3', '.mp4', '.m4v', '.flac', '.mkv', '.avi', '.wav',
  '.ogg', '.webm', '.m4a', '.aac', '.wma', '.mov',
]);

/**
 * File extensions requiring FluidSynth (MIDI formats).
 */
export const MIDI_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mid', '.midi',
]);

/**
 * All supported media file extensions (union of FFmpeg + MIDI).
 * Files with other extensions are ignored when dropped.
 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...FFMPEG_EXTENSIONS, ...MIDI_EXTENSIONS,
]);

/**
 * File dialog filter definition.
 */
interface FileDialogFilter {
  readonly name: string;
  readonly extensions: string[];
}

/**
 * Builds file dialog filters based on which dependencies are installed.
 *
 * @param ffmpeg - Whether FFmpeg is installed
 * @param fluidsynth - Whether FluidSynth is installed
 * @returns Array of file dialog filter groups
 */
export function buildFileDialogFilters(ffmpeg: boolean, fluidsynth: boolean): FileDialogFilter[] {
  if (ffmpeg && fluidsynth) {
    return [
      {name: 'Media Files', extensions: ['mp3', 'mp4', 'm4v', 'flac', 'mkv', 'avi', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'wma', 'mov', 'mid', 'midi']},
      {name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma', 'mid', 'midi']},
      {name: 'Video', extensions: ['mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov']},
    ];
  }
  if (ffmpeg) {
    return [
      {name: 'Media Files', extensions: ['mp3', 'mp4', 'm4v', 'flac', 'mkv', 'avi', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'wma', 'mov']},
      {name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma']},
      {name: 'Video', extensions: ['mp4', 'm4v', 'mkv', 'avi', 'webm', 'mov']},
    ];
  }
  if (fluidsynth) {
    return [
      {name: 'MIDI Files', extensions: ['mid', 'midi']},
    ];
  }
  return [];
}
