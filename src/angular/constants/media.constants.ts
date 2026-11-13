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
export const FFMPEG_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.wma',
]);

/**
 * Video file extensions requiring FFmpeg.
 */
export const FFMPEG_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mp4', '.m4v', '.mkv', '.avi', '.webm', '.mov',
]);

/**
 * All file extensions requiring FFmpeg (audio + video).
 */
export const FFMPEG_EXTENSIONS: ReadonlySet<string> = new Set([
  ...FFMPEG_AUDIO_EXTENSIONS, ...FFMPEG_VIDEO_EXTENSIONS,
]);

/**
 * File extensions requiring FluidSynth and an installed SoundFont (MIDI formats).
 */
export const MIDI_EXTENSIONS: ReadonlySet<string> = new Set([
  '.mid', '.midi',
]);

/**
 * File extensions decoded by FFmpeg's libopenmpt demuxer (tracker module formats).
 * Headlined by Amiga Oktalyzer (.okt). Kept in sync with TRACKER_FORMATS
 * in src/electron/tracker-parser.ts.
 */
export const TRACKER_EXTENSIONS: ReadonlySet<string> = new Set([
  '.okt', '.mod', '.xm', '.s3m', '.it', '.mptm', '.mtm', '.med', '.stm',
  '.digi', '.dbm', '.dsm', '.dtm', '.far', '.gdm', '.imf', '.j2b', '.mdl',
  '.mt2', '.ult', '.669', '.amf', '.ams', '.psm', '.ptm', '.umx', '.mo3',
]);

/**
 * All supported media file extensions (union of FFmpeg + MIDI + tracker).
 * Files with other extensions are ignored when dropped.
 */
export const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([
  ...FFMPEG_EXTENSIONS, ...MIDI_EXTENSIONS, ...TRACKER_EXTENSIONS,
]);

/**
 * File dialog filter definition.
 */
interface FileDialogFilter {
  readonly name: string;
  readonly extensions: string[];
}

/** Bare (dot-less) extension names, derived from an extension set. */
function bareExtensions(set: ReadonlySet<string>): string[] {
  return [...set].map((ext: string): string => ext.replace(/^\./, ''));
}

/**
 * Builds file dialog filters based on which dependencies are installed.
 *
 * Each installed dependency contributes the file types it can play, so the
 * dialog only offers formats the app can actually open.
 *
 * @param ffmpeg - Whether FFmpeg is installed (audio + video formats)
 * @param midi - Whether MIDI can be played (FluidSynth and a SoundFont)
 * @param trackers - Whether tracker modules can be played (FFmpeg built with libopenmpt)
 * @returns Array of file dialog filter groups
 */
export function buildFileDialogFilters(ffmpeg: boolean, midi: boolean, trackers: boolean): FileDialogFilter[] {
  const ffmpegAudio: string[] = bareExtensions(FFMPEG_AUDIO_EXTENSIONS);
  const video: string[] = bareExtensions(FFMPEG_VIDEO_EXTENSIONS);
  const midiExtensions: string[] = bareExtensions(MIDI_EXTENSIONS);
  const tracker: string[] = bareExtensions(TRACKER_EXTENSIONS);

  // Audio-playable types across all installed dependencies.
  const audio: string[] = [
    ...(ffmpeg ? ffmpegAudio : []),
    ...(midi ? midiExtensions : []),
    ...(trackers ? tracker : []),
  ];
  const allMedia: string[] = [...audio, ...(ffmpeg ? video : [])];

  if (allMedia.length === 0) {
    return [];
  }

  const filters: FileDialogFilter[] = [{name: 'Media Files', extensions: allMedia}];
  if (audio.length > 0) {
    filters.push({name: 'Audio', extensions: audio});
  }
  if (ffmpeg) {
    filters.push({name: 'Video', extensions: video});
  }
  if (trackers) {
    filters.push({name: 'Tracker Modules', extensions: tracker});
  }
  return filters;
}
