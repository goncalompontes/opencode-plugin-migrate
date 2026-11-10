declare module 'msedge-tts' {
  export const OUTPUT_FORMAT: {
    AUDIO_24KHZ_48KBITRATE_MONO_MP3: string;
  };

  export class MsEdgeTTS {
    setMetadata(voice: string, format: string): Promise<void>;
    toFile(
      directory: string,
      text: string,
      options?: {
        pitch?: string;
        rate?: string;
        volume?: string;
      },
    ): Promise<{ audioFilePath: string }>;
  }
}
