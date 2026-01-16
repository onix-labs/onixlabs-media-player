import { BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';

export interface MediaInfo {
  duration: number;
  type: 'audio' | 'video';
  title: string;
  artist?: string;
  album?: string;
  filePath: string;
  width?: number;
  height?: number;
}

export class FFmpegManager {
  private window: BrowserWindow;
  private ffmpegProcess: ChildProcess | null = null;
  private currentMedia: MediaInfo | null = null;
  private isPlaying = false;
  private isPaused = false;
  private currentTime = 0;
  private volume = 1.0;
  private timeUpdateInterval: NodeJS.Timeout | null = null;
  private startTime = 0;
  private pausedTime = 0;
  private isDestroyed = false;

  constructor(window: BrowserWindow) {
    this.window = window;

    // Clean up when window closes
    window.on('closed', () => {
      this.isDestroyed = true;
      this.stopFFmpeg();
    });
  }

  private send(channel: string, data?: unknown): void {
    if (this.isDestroyed || this.window.isDestroyed()) return;
    this.window.webContents.send(channel, data);
  }

  async loadMedia(filePath: string): Promise<MediaInfo> {
    await this.stop();
    const mediaInfo = await this.probeMedia(filePath);
    this.currentMedia = mediaInfo;
    this.currentTime = 0;
    this.send('media:durationChange', mediaInfo.duration);
    return mediaInfo;
  }

  private async probeMedia(filePath: string): Promise<MediaInfo> {
    return new Promise((resolve, reject) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        filePath
      ]);

      let output = '';
      let errorOutput = '';

      ffprobe.stdout.on('data', (data) => { output += data; });
      ffprobe.stderr.on('data', (data) => { errorOutput += data; });

      ffprobe.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffprobe failed: ${errorOutput}`));
          return;
        }

        try {
          const data = JSON.parse(output);
          const format = data.format || {};
          const streams = data.streams || [];

          const videoStream = streams.find((s: { codec_type: string }) => s.codec_type === 'video');
          const audioStream = streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
          const hasVideo = !!videoStream && videoStream.codec_name !== 'mjpeg'; // Ignore album art

          const tags = format.tags || {};

          resolve({
            duration: parseFloat(format.duration) || 0,
            type: hasVideo ? 'video' : 'audio',
            title: tags.title || tags.TITLE || path.basename(filePath, path.extname(filePath)),
            artist: tags.artist || tags.ARTIST || tags.album_artist || tags.ALBUM_ARTIST,
            album: tags.album || tags.ALBUM,
            filePath,
            width: videoStream?.width,
            height: videoStream?.height
          });
        } catch (e) {
          reject(new Error(`Failed to parse ffprobe output: ${e}`));
        }
      });

      ffprobe.on('error', (err) => {
        reject(new Error(`ffprobe error: ${err.message}`));
      });
    });
  }

  async play(): Promise<void> {
    if (!this.currentMedia) {
      throw new Error('No media loaded');
    }

    if (this.isPaused && this.ffmpegProcess) {
      await this.resume();
      return;
    }

    if (this.isPlaying) return;

    this.isPlaying = true;
    this.isPaused = false;
    this.startTime = Date.now() - (this.currentTime * 1000);
    this.send('media:stateChange', 'playing');
    this.startFFmpegStream();
    this.startTimeTracking();
  }

  async pause(): Promise<void> {
    if (!this.isPlaying || this.isPaused) return;

    this.isPaused = true;
    this.pausedTime = this.currentTime;
    this.send('media:stateChange', 'paused');

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGSTOP');
    }
    this.stopTimeTracking();
  }

  async resume(): Promise<void> {
    if (!this.isPaused) return;

    this.isPaused = false;
    this.startTime = Date.now() - (this.pausedTime * 1000);
    this.send('media:stateChange', 'playing');

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGCONT');
    }
    this.startTimeTracking();
  }

  async seek(timeSeconds: number): Promise<void> {
    if (!this.currentMedia) return;

    this.currentTime = Math.max(0, Math.min(timeSeconds, this.currentMedia.duration));
    this.send('media:timeUpdate', this.currentTime);

    if (this.isPlaying) {
      const wasPlaying = !this.isPaused;
      await this.stopFFmpeg();
      this.isPlaying = true;
      this.isPaused = false;
      this.startTime = Date.now() - (this.currentTime * 1000);

      if (wasPlaying) {
        this.startFFmpegStream();
        this.startTimeTracking();
        this.send('media:stateChange', 'playing');
      }
    }
  }

  async setVolume(volume: number): Promise<void> {
    this.volume = Math.max(0, Math.min(1, volume));

    // Volume changes require restarting the stream with new volume filter
    if (this.isPlaying && !this.isPaused) {
      const currentPos = this.currentTime;
      await this.stopFFmpeg();
      this.currentTime = currentPos;
      this.isPlaying = true;
      this.startTime = Date.now() - (this.currentTime * 1000);
      this.startFFmpegStream();
      this.startTimeTracking();
    }
  }

  async stop(): Promise<void> {
    await this.stopFFmpeg();
    this.currentTime = 0;
    this.isPlaying = false;
    this.isPaused = false;
    this.send('media:stateChange', 'stopped');
    this.send('media:timeUpdate', 0);
  }

  private async stopFFmpeg(): Promise<void> {
    this.stopTimeTracking();

    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGKILL');
      this.ffmpegProcess = null;
    }

    this.isPlaying = false;
    this.isPaused = false;
  }

  private startFFmpegStream(): void {
    if (!this.currentMedia) return;

    const args = this.buildFFmpegArgs();
    this.ffmpegProcess = spawn('ffmpeg', args);

    if (this.currentMedia.type === 'audio') {
      this.handleAudioStream();
    } else {
      this.handleVideoStream();
    }

    this.ffmpegProcess.on('close', (code) => {
      if (this.isPlaying && !this.isPaused && code === 0) {
        this.send('media:ended');
        this.isPlaying = false;
        this.currentTime = 0;
        this.stopTimeTracking();
      }
    });

    this.ffmpegProcess.on('error', (err) => {
      this.send('media:error', err.message);
      this.isPlaying = false;
      this.stopTimeTracking();
    });

    this.ffmpegProcess.stderr?.on('data', (data) => {
      // FFmpeg outputs progress info to stderr, can parse for debugging
      // const output = data.toString();
      // console.log('FFmpeg:', output);
    });
  }

  private buildFFmpegArgs(): string[] {
    const media = this.currentMedia!;
    const seekTime = this.currentTime.toFixed(3);

    if (media.type === 'audio') {
      return [
        '-re',
        '-ss', seekTime,
        '-i', media.filePath,
        '-f', 's16le',
        '-acodec', 'pcm_s16le',
        '-ar', '44100',
        '-ac', '2',
        '-af', `volume=${this.volume}`,
        'pipe:1'
      ];
    } else {
      // Transcode to WebM for streaming to MediaSource API
      return [
        '-re',
        '-ss', seekTime,
        '-i', media.filePath,
        '-c:v', 'libvpx-vp9',
        '-c:a', 'libopus',
        '-b:v', '2M',
        '-b:a', '128k',
        '-f', 'webm',
        '-dash', '1',
        'pipe:1'
      ];
    }
  }

  private handleAudioStream(): void {
    const stdout = this.ffmpegProcess?.stdout;
    if (!stdout) return;

    stdout.on('data', (chunk: Buffer) => {
      if (!this.isPlaying || this.isPaused) return;

      // Convert Buffer to Uint8Array for proper IPC serialization
      const uint8Array = new Uint8Array(chunk);

      this.send('media:audioData', {
        data: Array.from(uint8Array),
        timestamp: this.currentTime
      });
    });
  }

  private handleVideoStream(): void {
    const stdout = this.ffmpegProcess?.stdout;
    if (!stdout) return;

    stdout.on('data', (chunk: Buffer) => {
      if (!this.isPlaying || this.isPaused) return;

      // Send WebM chunks directly to renderer for MediaSource API
      const uint8Array = new Uint8Array(chunk);
      this.send('media:videoChunk', Array.from(uint8Array));
    });
  }

  private startVideoAudio(): void {
    if (!this.currentMedia) return;

    const audioProcess = spawn('ffmpeg', [
      '-re',  // Read input at native frame rate (real-time playback)
      '-ss', this.currentTime.toFixed(3),
      '-i', this.currentMedia.filePath,
      '-vn',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      '-af', `volume=${this.volume}`,
      'pipe:1'
    ]);

    audioProcess.stdout?.on('data', (chunk: Buffer) => {
      if (!this.isPlaying || this.isPaused) return;

      // Convert Buffer to Uint8Array for proper IPC serialization
      const uint8Array = new Uint8Array(chunk);

      this.send('media:audioData', {
        data: Array.from(uint8Array),
        timestamp: this.currentTime
      });
    });

    // Kill audio process when main process dies
    this.ffmpegProcess?.on('close', () => {
      audioProcess.kill('SIGKILL');
    });
  }

  private startTimeTracking(): void {
    this.stopTimeTracking();

    this.timeUpdateInterval = setInterval(() => {
      if (!this.isPlaying || this.isPaused || !this.currentMedia) return;

      this.currentTime = (Date.now() - this.startTime) / 1000;

      if (this.currentTime >= this.currentMedia.duration) {
        this.currentTime = this.currentMedia.duration;
        this.stopTimeTracking();
      }

      this.send('media:timeUpdate', this.currentTime);
    }, 100);
  }

  private stopTimeTracking(): void {
    if (this.timeUpdateInterval) {
      clearInterval(this.timeUpdateInterval);
      this.timeUpdateInterval = null;
    }
  }

  getState(): { isPlaying: boolean; isPaused: boolean; currentTime: number } {
    return {
      isPlaying: this.isPlaying,
      isPaused: this.isPaused,
      currentTime: this.currentTime
    };
  }
}
