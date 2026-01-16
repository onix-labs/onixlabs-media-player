import {Injectable, NgZone, OnDestroy} from '@angular/core';
import {Observable, Subject, BehaviorSubject} from 'rxjs';
import type {MediaInfo, AudioChunk, VideoFrame} from '../types/electron';

export type {MediaInfo, AudioChunk, VideoFrame};

@Injectable({providedIn: 'root'})
export class ElectronService implements OnDestroy {
  private readonly audioData$ = new Subject<AudioChunk>();
  private readonly videoFrame$ = new Subject<VideoFrame>();
  private readonly videoChunk$ = new Subject<number[]>();
  private readonly timeUpdate$ = new BehaviorSubject<number>(0);
  private readonly durationChange$ = new BehaviorSubject<number>(0);
  private readonly mediaEnded$ = new Subject<void>();
  private readonly error$ = new Subject<string>();
  private readonly stateChange$ = new BehaviorSubject<string>('idle');
  private cleanupFns: (() => void)[] = [];

  constructor(private ngZone: NgZone) {
    this.setupEventListeners();
  }

  get isElectron(): boolean {
    return !!window.mediaPlayer;
  }

  private get api() {
    return window.mediaPlayer;
  }

  private setupEventListeners(): void {
    if (!this.isElectron || !this.api) return;

    this.cleanupFns.push(
      this.api.onAudioData((data: AudioChunk) => {
        this.ngZone.run(() => this.audioData$.next(data));
      }),
      this.api.onVideoFrame((frame: VideoFrame) => {
        this.ngZone.run(() => this.videoFrame$.next(frame));
      }),
      this.api.onVideoChunk((chunk: number[]) => {
        this.ngZone.run(() => this.videoChunk$.next(chunk));
      }),
      this.api.onTimeUpdate((time: number) => {
        this.ngZone.run(() => this.timeUpdate$.next(time));
      }),
      this.api.onDurationChange((duration: number) => {
        this.ngZone.run(() => this.durationChange$.next(duration));
      }),
      this.api.onMediaEnd(() => {
        this.ngZone.run(() => this.mediaEnded$.next());
      }),
      this.api.onError((error: string) => {
        this.ngZone.run(() => this.error$.next(error));
      }),
      this.api.onStateChange((state: string) => {
        this.ngZone.run(() => this.stateChange$.next(state));
      })
    );
  }

  get audioData(): Observable<AudioChunk> {
    return this.audioData$.asObservable();
  }

  get videoFrame(): Observable<VideoFrame> {
    return this.videoFrame$.asObservable();
  }

  get videoChunk(): Observable<number[]> {
    return this.videoChunk$.asObservable();
  }

  get timeUpdate(): Observable<number> {
    return this.timeUpdate$.asObservable();
  }

  get durationChange(): Observable<number> {
    return this.durationChange$.asObservable();
  }

  get mediaEnded(): Observable<void> {
    return this.mediaEnded$.asObservable();
  }

  get error(): Observable<string> {
    return this.error$.asObservable();
  }

  get stateChange(): Observable<string> {
    return this.stateChange$.asObservable();
  }

  get currentTime(): number {
    return this.timeUpdate$.value;
  }

  get duration(): number {
    return this.durationChange$.value;
  }

  get state(): string {
    return this.stateChange$.value;
  }

  async openFileDialog(multiSelect = true): Promise<string[]> {
    if (!this.isElectron || !this.api) return [];

    return this.api.openFileDialog({
      filters: [
        {name: 'Media Files', extensions: ['mp3', 'mp4', 'flac', 'mkv', 'avi', 'wav', 'ogg', 'webm', 'm4a', 'aac', 'wma', 'mov']},
        {name: 'Audio', extensions: ['mp3', 'flac', 'wav', 'ogg', 'm4a', 'aac', 'wma']},
        {name: 'Video', extensions: ['mp4', 'mkv', 'avi', 'webm', 'mov']}
      ],
      multiSelections: multiSelect
    });
  }

  async loadMedia(filePath: string): Promise<MediaInfo> {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.loadMedia(filePath);
  }

  async getMediaUrl(filePath: string): Promise<string> {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.getMediaUrl(filePath);
  }

  async getVideoUrl(filePath: string): Promise<string> {
    if (!this.isElectron || !this.api) {
      throw new Error('Not running in Electron');
    }
    return this.api.getVideoUrl(filePath);
  }

  async play(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    return this.api.play();
  }

  async pause(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    return this.api.pause();
  }

  async resume(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    return this.api.resume();
  }

  async seek(timeSeconds: number): Promise<void> {
    if (!this.isElectron || !this.api) return;
    return this.api.seek(timeSeconds);
  }

  async setVolume(volume: number): Promise<void> {
    if (!this.isElectron || !this.api) return;
    return this.api.setVolume(volume);
  }

  async stop(): Promise<void> {
    if (!this.isElectron || !this.api) return;
    return this.api.stop();
  }

  ngOnDestroy(): void {
    this.cleanupFns.forEach(fn => fn());
    this.cleanupFns = [];
  }
}
