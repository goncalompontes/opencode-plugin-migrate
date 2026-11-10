import type { LinuxPlatformAPI, LinuxPlatformParams, LinuxSessionType } from '../types/linux.js';
import type { ShellRunner } from '../types/opencode-sdk.js';

/**
 * Linux Platform Compatibility Module
 *
 * Provides Linux-specific implementations for:
 * - Wake monitor from sleep (X11 and Wayland)
 * - Get current system volume (PulseAudio/PipeWire and ALSA)
 * - Force system volume up (PulseAudio/PipeWire and ALSA)
 * - Play audio files (PulseAudio and ALSA)
 *
 * Dependencies (optional - graceful fallback if missing):
 * - x11-xserver-utils (for xset on X11)
 * - pulseaudio-utils or pipewire-pulse (for pactl)
 * - alsa-utils (for amixer, aplay, paplay)
 *
 * @module util/linux
 */

const getErrorMessage = (error: unknown): string => {
  const maybeError = error as { message?: unknown };
  return String(maybeError?.message);
};

/**
 * Creates a Linux platform utilities instance
 * @param params - { $: shell runner, debugLog: logging function }
 * @returns Linux platform API
 */
export const createLinuxPlatform = ({ $, debugLog = () => {} }: LinuxPlatformParams): LinuxPlatformAPI => {
  const shell: ShellRunner | undefined = $;

  // ============================================================
  // DISPLAY SESSION DETECTION
  // ============================================================

  /**
   * Detect if running under Wayland
   * @returns
   */
  const isWayland = (): boolean => {
    return !!process.env.WAYLAND_DISPLAY;
  };

  /**
   * Detect if running under X11
   * @returns
   */
  const isX11 = (): boolean => {
    return !!process.env.DISPLAY && !isWayland();
  };

  /**
   * Get the current session type
   * @returns
   */
  const getSessionType = (): LinuxSessionType => {
    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11' || sessionType === 'wayland' || sessionType === 'tty') {
      return sessionType;
    }
    if (isWayland()) {
      return 'wayland';
    }
    if (isX11()) {
      return 'x11';
    }
    return 'unknown';
  };

  // ============================================================
  // WAKE MONITOR
  // ============================================================

  /**
   * Wake monitor using X11 DPMS (works on X11 and often XWayland)
   * @returns Success status
   */
  const wakeMonitorX11 = async (): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      await shell`xset dpms force on`.quiet();
      debugLog('wakeMonitor: X11 xset dpms force on succeeded');
      return true;
    } catch (error) {
      debugLog(`wakeMonitor: X11 xset failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Wake monitor using GNOME D-Bus (for GNOME on Wayland)
   * Triggers a brightness step which wakes the display
   * @returns Success status
   */
  const wakeMonitorGnomeDBus = async (): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      await shell`gdbus call --session --dest org.gnome.SettingsDaemon.Power --object-path /org/gnome/SettingsDaemon/Power --method org.gnome.SettingsDaemon.Power.Screen.StepUp`.quiet();
      debugLog('wakeMonitor: GNOME D-Bus StepUp succeeded');
      return true;
    } catch (error) {
      debugLog(`wakeMonitor: GNOME D-Bus failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Wake monitor from sleep/DPMS standby
   * Tries multiple methods with graceful fallback:
   * 1. X11 xset (works on X11 and XWayland)
   * 2. GNOME D-Bus (works on GNOME Wayland)
   *
   * @returns True if any method succeeded
   */
  const wakeMonitor = async (): Promise<boolean> => {
    // Try X11 method first (most compatible, works on XWayland too)
    if (await wakeMonitorX11()) {
      return true;
    }

    // Try GNOME Wayland D-Bus method
    if (await wakeMonitorGnomeDBus()) {
      return true;
    }

    debugLog('wakeMonitor: all methods failed');
    return false;
  };

  // ============================================================
  // VOLUME CONTROL - PULSEAUDIO / PIPEWIRE
  // ============================================================

  /**
   * Get current volume using PulseAudio/PipeWire (pactl)
   * @returns Volume percentage (0-100) or -1 if failed
   */
  const getVolumePulse = async (): Promise<number> => {
    if (!shell) {
      return -1;
    }
    try {
      const result = await shell`pactl get-sink-volume @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Volume: front-left: 65536 / 100% / 0.00 dB, ..."
      const match = output.match(/(\d+)%/);
      const percent = match?.[1];
      if (percent) {
        const volume = parseInt(percent, 10);
        debugLog(`getVolume: pactl returned ${volume}%`);
        return volume;
      }
    } catch (error) {
      debugLog(`getVolume: pactl failed: ${getErrorMessage(error)}`);
    }
    return -1;
  };

  /**
   * Set volume using PulseAudio/PipeWire (pactl)
   * @param volume - Volume percentage (0-100)
   * @returns Success status
   */
  const setVolumePulse = async (volume: number): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await shell`pactl set-sink-volume @DEFAULT_SINK@ ${clampedVolume}%`.quiet();
      debugLog(`setVolume: pactl set to ${clampedVolume}%`);
      return true;
    } catch (error) {
      debugLog(`setVolume: pactl failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Unmute using PulseAudio/PipeWire (pactl)
   * @returns Success status
   */
  const unmutePulse = async (): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      await shell`pactl set-sink-mute @DEFAULT_SINK@ 0`.quiet();
      debugLog('unmute: pactl succeeded');
      return true;
    } catch (error) {
      debugLog(`unmute: pactl failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Check if muted using PulseAudio/PipeWire
   * @returns True if muted, false if not, null if failed
   */
  const isMutedPulse = async (): Promise<boolean | null> => {
    if (!shell) {
      return null;
    }
    try {
      const result = await shell`pactl get-sink-mute @DEFAULT_SINK@`.quiet();
      const output = result.stdout?.toString() || '';
      // Output: "Mute: yes" or "Mute: no"
      return /yes|true/i.test(output);
    } catch (error) {
      debugLog(`isMuted: pactl failed: ${getErrorMessage(error)}`);
      return null;
    }
  };

  // ============================================================
  // VOLUME CONTROL - ALSA (FALLBACK)
  // ============================================================

  /**
   * Get current volume using ALSA (amixer)
   * @returns Volume percentage (0-100) or -1 if failed
   */
  const getVolumeAlsa = async (): Promise<number> => {
    if (!shell) {
      return -1;
    }
    try {
      const result = await shell`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Parse output like: "Front Left: Playback 65536 [75%] [on]"
      const match = output.match(/\[(\d+)%\]/);
      const percent = match?.[1];
      if (percent) {
        const volume = parseInt(percent, 10);
        debugLog(`getVolume: amixer returned ${volume}%`);
        return volume;
      }
    } catch (error) {
      debugLog(`getVolume: amixer failed: ${getErrorMessage(error)}`);
    }
    return -1;
  };

  /**
   * Set volume using ALSA (amixer)
   * @param volume - Volume percentage (0-100)
   * @returns Success status
   */
  const setVolumeAlsa = async (volume: number): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      const clampedVolume = Math.max(0, Math.min(100, volume));
      await shell`amixer set Master ${clampedVolume}%`.quiet();
      debugLog(`setVolume: amixer set to ${clampedVolume}%`);
      return true;
    } catch (error) {
      debugLog(`setVolume: amixer failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Unmute using ALSA (amixer)
   * @returns Success status
   */
  const unmuteAlsa = async (): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      await shell`amixer set Master unmute`.quiet();
      debugLog('unmute: amixer succeeded');
      return true;
    } catch (error) {
      debugLog(`unmute: amixer failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Check if muted using ALSA
   * @returns True if muted, false if not, null if failed
   */
  const isMutedAlsa = async (): Promise<boolean | null> => {
    if (!shell) {
      return null;
    }
    try {
      const result = await shell`amixer get Master`.quiet();
      const output = result.stdout?.toString() || '';
      // Look for [off] or [mute] in output
      return /\[off\]|\[mute\]/i.test(output);
    } catch (error) {
      debugLog(`isMuted: amixer failed: ${getErrorMessage(error)}`);
      return null;
    }
  };

  // ============================================================
  // UNIFIED VOLUME CONTROL (AUTO-DETECT BACKEND)
  // ============================================================

  /**
   * Get current system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @returns Volume percentage (0-100) or -1 if failed
   */
  const getCurrentVolume = async (): Promise<number> => {
    // Try PulseAudio/PipeWire first (most common on desktop Linux)
    let volume = await getVolumePulse();
    if (volume >= 0) {
      return volume;
    }

    // Fallback to ALSA
    volume = await getVolumeAlsa();
    return volume;
  };

  /**
   * Set system volume
   * Tries PulseAudio first, then falls back to ALSA
   * @param volume - Volume percentage (0-100)
   * @returns Success status
   */
  const setVolume = async (volume: number): Promise<boolean> => {
    // Try PulseAudio/PipeWire first
    if (await setVolumePulse(volume)) {
      return true;
    }

    // Fallback to ALSA
    return await setVolumeAlsa(volume);
  };

  /**
   * Unmute system audio
   * Tries PulseAudio first, then falls back to ALSA
   * @returns Success status
   */
  const unmute = async (): Promise<boolean> => {
    // Try PulseAudio/PipeWire first
    if (await unmutePulse()) {
      return true;
    }

    // Fallback to ALSA
    return await unmuteAlsa();
  };

  /**
   * Check if system audio is muted
   * Tries PulseAudio first, then falls back to ALSA
   * @returns True if muted, false if not, null if detection failed
   */
  const isMuted = async (): Promise<boolean | null> => {
    // Try PulseAudio/PipeWire first
    let muted = await isMutedPulse();
    if (muted !== null) {
      return muted;
    }

    // Fallback to ALSA
    muted = await isMutedAlsa();
    return muted;
  };

  /**
   * Force volume to maximum (unmute + set to 100%)
   * Used to ensure notifications are audible
   * @returns Success status
   */
  const forceVolume = async (): Promise<boolean> => {
    const unmuted = await unmute();
    const volumeSet = await setVolume(100);
    return unmuted || volumeSet;
  };

  /**
   * Force volume if below threshold
   * @param threshold - Minimum volume threshold (0-100)
   * @returns True if volume was forced, false if already adequate
   */
  const forceVolumeIfNeeded = async (threshold = 50): Promise<boolean> => {
    const currentVolume = await getCurrentVolume();

    // If we couldn't detect volume, force it to be safe
    if (currentVolume < 0) {
      debugLog('forceVolumeIfNeeded: could not detect volume, forcing');
      return await forceVolume();
    }

    // Check if already above threshold
    if (currentVolume >= threshold) {
      debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% >= ${threshold}%, no action needed`);
      return false;
    }

    // Force volume up
    debugLog(`forceVolumeIfNeeded: volume ${currentVolume}% < ${threshold}%, forcing to 100%`);
    return await forceVolume();
  };

  // ============================================================
  // AUDIO PLAYBACK
  // ============================================================

  /**
   * Play an audio file using PulseAudio (paplay)
   * @param filePath - Path to audio file
   * @returns Success status
   */
  const playAudioPulse = async (filePath: string): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      await shell`paplay ${filePath}`.quiet();
      debugLog(`playAudio: paplay succeeded for ${filePath}`);
      return true;
    } catch (error) {
      debugLog(`playAudio: paplay failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Play an audio file using ALSA (aplay)
   * Note: aplay only supports WAV files natively
   * @param filePath - Path to audio file
   * @returns Success status
   */
  const playAudioAlsa = async (filePath: string): Promise<boolean> => {
    if (!shell) {
      return false;
    }
    try {
      await shell`aplay ${filePath}`.quiet();
      debugLog(`playAudio: aplay succeeded for ${filePath}`);
      return true;
    } catch (error) {
      debugLog(`playAudio: aplay failed: ${getErrorMessage(error)}`);
      return false;
    }
  };

  /**
   * Play an audio file
   * Tries PulseAudio (paplay) first, then falls back to ALSA (aplay)
   * @param filePath - Path to audio file
   * @param loops - Number of times to play (default: 1)
   * @returns Success status
   */
  const playAudioFile = async (filePath: string, loops = 1): Promise<boolean> => {
    for (let i = 0; i < loops; i++) {
      // Try PulseAudio first (supports more formats including MP3)
      if (await playAudioPulse(filePath)) {
        continue;
      }

      // Fallback to ALSA
      if (await playAudioAlsa(filePath)) {
        continue;
      }

      // Both failed
      debugLog(`playAudioFile: all methods failed for ${filePath}`);
      return false;
    }
    return true;
  };

  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    // Session detection
    isWayland,
    isX11,
    getSessionType,

    // Wake monitor
    wakeMonitor,
    wakeMonitorX11,
    wakeMonitorGnomeDBus,

    // Volume control (unified)
    getCurrentVolume,
    setVolume,
    unmute,
    isMuted,
    forceVolume,
    forceVolumeIfNeeded,

    // Volume control (specific backends)
    pulse: {
      getVolume: getVolumePulse,
      setVolume: setVolumePulse,
      unmute: unmutePulse,
      isMuted: isMutedPulse,
    },
    alsa: {
      getVolume: getVolumeAlsa,
      setVolume: setVolumeAlsa,
      unmute: unmuteAlsa,
      isMuted: isMutedAlsa,
    },

    // Audio playback
    playAudioFile,
    playAudioPulse,
    playAudioAlsa,
  };
};
