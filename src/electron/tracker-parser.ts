/**
 * @fileoverview Tracker module format definitions.
 *
 * Tracker modules (Amiga Oktalyzer, ProTracker MOD, FastTracker XM, Impulse
 * Tracker IT, etc.) are not PCM audio and cannot be probed or decoded by
 * ffprobe/FFmpeg directly. They are rendered to PCM by libopenmpt's
 * `openmpt123` binary and then encoded like any other audio stream.
 *
 * This module defines the set of recognised tracker file extensions. Duration
 * is obtained from the rendered output (probed as MP3), so — unlike MIDI — no
 * bespoke binary duration parser is required here.
 *
 * @see {@link https://lib.openmpt.org/libopenmpt/ libopenmpt}
 * @module electron/tracker-parser
 */

/**
 * Recognised tracker module file extensions (lower-case, with leading dot).
 *
 * Covers the formats decodable by libopenmpt that a user is realistically
 * likely to encounter, headlined by Amiga Oktalyzer (.okt).
 */
export const TRACKER_FORMATS: Set<string> = new Set([
  '.okt',   // Amiga Oktalyzer (headline format)
  '.mod',   // ProTracker / SoundTracker / NoiseTracker
  '.xm',    // FastTracker II
  '.s3m',   // ScreamTracker 3
  '.it',    // Impulse Tracker
  '.mptm',  // OpenMPT
  '.mtm',   // MultiTracker
  '.med',   // OctaMED
  '.stm',   // ScreamTracker 2
  '.digi',  // DigiBooster
  '.dbm',   // DigiBooster Pro
  '.dsm',   // DSIK / Digital Sound Interface Kit
  '.dtm',   // Digital Tracker
  '.far',   // Farandole Composer
  '.gdm',   // General DigiMusic
  '.imf',   // Imago Orpheus
  '.j2b',   // Galaxy Sound System (Jazz Jackrabbit 2)
  '.mdl',   // DigiTrakker
  '.mt2',   // MadTracker 2
  '.ult',   // UltraTracker
  '.669',   // Composer 669 / UNIS 669
  '.amf',   // DSMI Advanced Module Format / ASYLUM
  '.ams',   // Extreme's Tracker / Velvet Studio
  '.psm',   // Epic MegaGames MASI
  '.ptm',   // PolyTracker
  '.umx',   // Unreal music package
  '.mo3',   // compressed module container
]);
