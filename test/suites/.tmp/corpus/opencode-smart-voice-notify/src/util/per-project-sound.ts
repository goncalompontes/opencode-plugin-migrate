import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { PluginConfig } from '../types/config.js';
import type { Project } from '../types/opencode-sdk.js';

/**
 * Per-Project Sound Module
 *
 * Provides logic for assigning unique sounds to different projects.
 * Hashes project directory + seed to pick a consistent sound from assets.
 */

const projectSoundCache = new Map<string, string>();

const getErrorMessage = (error: unknown): string => {
  const maybeError = error as { message?: unknown };
  return String(maybeError?.message);
};

/**
 * Internal debug logger
 * @param message
 * @param config
 */
const debugLog = (message: string, config?: PluginConfig | null): void => {
  if (!config || !config.debugLog) {
    return;
  }

  const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
  const logsDir = path.join(configDir, 'logs');
  const logFile = path.join(logsDir, 'smart-voice-notify-debug.log');

  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [per-project-sound] ${message}\n`);
  } catch {
    // Silently fail - logging is optional
  }
};

/**
 * Get a unique sound for a project by hashing its path.
 * @param project - The project object (should contain directory)
 * @param config - Plugin configuration
 * @returns Relative path to the project-specific sound, or null if disabled/unavailable
 */
export const getProjectSound = (
  project: Project | null | undefined,
  config: PluginConfig | null | undefined,
): string | null => {
  if (!config || !config.perProjectSounds || !project?.directory) {
    return null;
  }

  const projectPath = project.directory;

  // Use cache to ensure consistency within session
  if (projectSoundCache.has(projectPath)) {
    const cachedSound = projectSoundCache.get(projectPath)!;
    debugLog(`Returning cached sound for project: ${projectPath} -> ${cachedSound}`, config);
    return cachedSound;
  }

  try {
    // Hash the path + seed
    const seed = config.projectSoundSeed || 0;
    // We use MD5 because it's fast and sufficient for this purpose
    const hash = crypto.createHash('md5').update(projectPath + seed).digest('hex');

    // Map hash to 1-6 (opencode-notificator pattern)
    // Using first 8 chars of hash for a stable number
    const soundIndex = (parseInt(hash.substring(0, 8), 16) % 6) + 1;
    const soundFile = `assets/ding${soundIndex}.mp3`;

    debugLog(`Assigned new sound for project: ${projectPath} (seed: ${seed}) -> ${soundFile}`, config);

    // Cache and return
    projectSoundCache.set(projectPath, soundFile);
    return soundFile;
  } catch (error) {
    debugLog(`Error assigning project sound: ${getErrorMessage(error)}`, config);
    return null;
  }
};

/**
 * Clear the project sound cache (used for testing)
 */
export const clearProjectSoundCache = (): void => {
  projectSoundCache.clear();
};

export default {
  getProjectSound,
  clearProjectSoundCache,
};
