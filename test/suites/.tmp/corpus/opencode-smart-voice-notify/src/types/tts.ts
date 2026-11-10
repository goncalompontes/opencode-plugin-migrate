import type { PluginConfig, TTSEngine } from './config.js';
import type { OpenCodeClient, ShellRunner } from './opencode-sdk.js';

export interface SpeakOptions {
  enableTTS?: boolean;
  enableSound?: boolean;
  ttsEngine?: TTSEngine;
  fallbackSound?: string;
  loops?: number;
  [key: string]: unknown;
}

export interface TTSAPI {
  speak(message: string, options?: SpeakOptions): Promise<boolean>;
  announce(message: string, options?: SpeakOptions): Promise<boolean>;
  wakeMonitor(force?: boolean): Promise<void>;
  forceVolume(force?: boolean): Promise<void>;
  playAudioFile(filePath: string, loops?: number): Promise<void>;
  config: PluginConfig;
}

export interface TTSFactoryParams {
  $?: ShellRunner;
  client?: OpenCodeClient;
}

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
}
