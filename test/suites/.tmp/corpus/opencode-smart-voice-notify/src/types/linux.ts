import type { ShellRunner } from './opencode-sdk.js';

export type LinuxSessionType = 'x11' | 'wayland' | 'tty' | 'unknown';

export interface LinuxPlatformParams {
  $?: ShellRunner;
  debugLog?: (message: string) => void;
}

export interface VolumeControlBackend {
  getVolume(): Promise<number>;
  setVolume(volume: number): Promise<boolean>;
  unmute(): Promise<boolean>;
  isMuted(): Promise<boolean | null>;
}

export interface LinuxPlatformAPI {
  isWayland(): boolean;
  isX11(): boolean;
  getSessionType(): LinuxSessionType;

  wakeMonitor(): Promise<boolean>;
  wakeMonitorX11(): Promise<boolean>;
  wakeMonitorGnomeDBus(): Promise<boolean>;

  getCurrentVolume(): Promise<number>;
  setVolume(volume: number): Promise<boolean>;
  unmute(): Promise<boolean>;
  isMuted(): Promise<boolean | null>;
  forceVolume(): Promise<boolean>;
  forceVolumeIfNeeded(threshold?: number): Promise<boolean>;

  pulse: VolumeControlBackend;
  alsa: VolumeControlBackend;

  playAudioFile(filePath: string, loops?: number): Promise<boolean>;
  playAudioPulse(filePath: string): Promise<boolean>;
  playAudioAlsa(filePath: string): Promise<boolean>;
}
