import fs from 'fs';
import os from 'os';
import path from 'path';

import type { NotificationEventType } from '../types/config.js';
import type {
  DiscordEmbed,
  DiscordEmbedField,
  DiscordWebhookPayload,
  NotificationResult,
  RateLimitState,
  WebhookNotifyOptions,
  WebhookQueueItem,
} from '../types/notification.js';

/**
 * Webhook Module for OpenCode Smart Voice Notify
 *
 * Provides Discord webhook integration for remote notifications.
 * Sends formatted notifications to Discord channels when the agent
 * needs attention (idle, permission, error, question events).
 *
 * Features:
 * - Discord webhook format with rich embeds
 * - Rate limiting with automatic retry
 * - In-memory queue for reliability
 * - Fire-and-forget operation (non-blocking)
 * - Debug logging
 *
 * @module util/webhook
 * @see docs/ARCHITECT_PLAN.md - Phase 4, Task 4.1
 */

type EventTypeKey = NotificationEventType | 'default' | (string & {});

interface WebhookValidationResult {
  valid: boolean;
  reason?: string;
}

interface EmbedExtra {
  fields?: DiscordEmbedField[];
  [key: string]: unknown;
}

interface DiscordEmbedOptions {
  eventType?: EventTypeKey;
  title?: string;
  message?: string;
  projectName?: string;
  sessionId?: string;
  count?: number;
  extra?: EmbedExtra;
}

interface WebhookPayloadOptions {
  username?: string;
  avatarUrl?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

interface WebhookSendOptions {
  retryCount?: number;
  debugLog?: boolean;
  timeout?: number;
}

interface WebhookNotificationInput {
  eventType: NotificationEventType | string;
  title: string;
  message: string;
  projectName?: string;
  sessionId?: string;
  count?: number;
  extra?: EmbedExtra;
}

type QueueInput = Omit<WebhookQueueItem, 'queuedAt'>;

const getErrorMessage = (error: unknown): string => {
  const maybeError = error as { message?: unknown };
  return String(maybeError?.message);
};

// ========================================
// QUEUE CONFIGURATION
// ========================================

/**
 * In-memory queue for webhook messages.
 * Provides basic reliability - if a send fails, it can be retried.
 * Note: This is not persistent; queue is lost on process restart.
 */
const webhookQueue: WebhookQueueItem[] = [];

/**
 * Maximum queue size to prevent memory issues.
 */
const MAX_QUEUE_SIZE = 100;

/**
 * Flag to indicate if queue processing is running.
 */
let isProcessingQueue = false;

// ========================================
// RATE LIMITING
// ========================================

/**
 * Rate limit state tracking.
 * Discord rate limits webhooks, so we need to handle 429 responses.
 */
let rateLimitState: RateLimitState = {
  isRateLimited: false,
  retryAfter: 0,
  retryTimestamp: 0,
};

/**
 * Default retry delay in milliseconds when rate limited without Retry-After header.
 */
const DEFAULT_RETRY_DELAY_MS = 1000;

/**
 * Maximum number of retry attempts for a single message.
 */
const MAX_RETRIES = 3;

// ========================================
// DEBUG LOGGING
// ========================================

/**
 * Debug logging to file.
 * Only logs when enabled.
 * Writes to ~/.config/opencode/logs/smart-voice-notify-debug.log
 *
 * @param message - Message to log
 * @param enabled - Whether debug logging is enabled
 */
const debugLog = (message: string, enabled = false): void => {
  if (!enabled) return;

  try {
    const configDir = process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), '.config', 'opencode');
    const logsDir = path.join(configDir, 'logs');

    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, 'smart-voice-notify-debug.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logFile, `[${timestamp}] [webhook] ${message}\n`);
  } catch {
    // Silently fail - logging should never break the plugin
  }
};

// ========================================
// DISCORD EMBED COLORS
// ========================================

/**
 * Discord embed colors for different event types.
 * Colors are specified as decimal integers.
 */
export const EMBED_COLORS: Record<NotificationEventType | 'default', number> = {
  idle: 0x00ff00, // Green - task complete
  permission: 0xffaa00, // Orange/Amber - needs attention
  error: 0xff0000, // Red - error
  question: 0x0099ff, // Blue - question
  default: 0x7289da, // Discord blurple
};

/**
 * Emoji prefixes for different event types.
 */
const EVENT_EMOJIS: Record<NotificationEventType | 'default', string> = {
  idle: '✅',
  permission: '⚠️',
  error: '❌',
  question: '❓',
  default: '🔔',
};

// ========================================
// CORE FUNCTIONS
// ========================================

/**
 * Validate a webhook URL.
 * Currently supports Discord webhook URLs.
 *
 * @param url - URL to validate
 * @returns Validation result
 */
export const validateWebhookUrl = (url: string): WebhookValidationResult => {
  if (!url || typeof url !== 'string') {
    return { valid: false, reason: 'URL is required' };
  }

  // Basic URL validation
  try {
    const parsed = new URL(url);

    // Check for Discord webhook pattern
    if (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') {
      if (parsed.pathname.includes('/api/webhooks/')) {
        return { valid: true };
      }
      return { valid: false, reason: 'Invalid Discord webhook URL format' };
    }

    // Allow generic webhooks for future expansion
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return { valid: true };
    }

    return { valid: false, reason: 'Invalid URL protocol' };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
};

/**
 * Build a Discord embed object for a notification.
 *
 * @param options - Embed options
 * @returns Discord embed object
 */
export const buildDiscordEmbed = (options: DiscordEmbedOptions): DiscordEmbed => {
  const {
    eventType = 'default',
    title,
    message,
    projectName,
    sessionId,
    count,
    extra = {},
  } = options;

  const emoji = EVENT_EMOJIS[eventType as keyof typeof EVENT_EMOJIS] || EVENT_EMOJIS.default;
  const color = EMBED_COLORS[eventType as keyof typeof EMBED_COLORS] || EMBED_COLORS.default;

  const embed: DiscordEmbed = {
    title: `${emoji} ${title || 'OpenCode Notification'}`,
    description: message || '',
    color,
    timestamp: new Date().toISOString(),
    footer: {
      text: 'OpenCode Smart Voice Notify',
    },
  };

  // Add fields for additional context
  const fields: DiscordEmbedField[] = [];

  if (projectName) {
    fields.push({
      name: 'Project',
      value: projectName,
      inline: true,
    });
  }

  if (eventType) {
    fields.push({
      name: 'Event',
      value: eventType.charAt(0).toUpperCase() + eventType.slice(1),
      inline: true,
    });
  }

  if (count && count > 1) {
    fields.push({
      name: 'Count',
      value: String(count),
      inline: true,
    });
  }

  if (sessionId) {
    fields.push({
      name: 'Session',
      value: sessionId.substring(0, 8) + '...',
      inline: true,
    });
  }

  // Add any extra fields
  if (extra.fields && Array.isArray(extra.fields)) {
    fields.push(...extra.fields);
  }

  if (fields.length > 0) {
    embed.fields = fields;
  }

  return embed;
};

/**
 * Build a Discord webhook payload.
 *
 * @param options - Payload options
 * @returns Discord webhook payload
 */
export const buildWebhookPayload = (options: WebhookPayloadOptions): DiscordWebhookPayload => {
  const { username = 'OpenCode Notify', avatarUrl, content, embeds = [] } = options;

  const payload: DiscordWebhookPayload = {
    username,
  };

  if (avatarUrl) {
    payload.avatar_url = avatarUrl;
  }

  if (content) {
    payload.content = content;
  }

  if (embeds.length > 0) {
    payload.embeds = embeds;
  }

  return payload;
};

/**
 * Check if we're currently rate limited.
 *
 * @returns True if rate limited
 */
export const isRateLimited = (): boolean => {
  if (!rateLimitState.isRateLimited) {
    return false;
  }

  // Check if rate limit has expired
  if (Date.now() >= rateLimitState.retryTimestamp) {
    rateLimitState.isRateLimited = false;
    return false;
  }

  return true;
};

/**
 * Get the time until rate limit expires.
 *
 * @returns Milliseconds until rate limit expires (0 if not limited)
 */
export const getRateLimitWait = (): number => {
  if (!isRateLimited()) {
    return 0;
  }
  return Math.max(0, rateLimitState.retryTimestamp - Date.now());
};

/**
 * Wait for rate limit to expire.
 *
 * @param debug - Enable debug logging
 */
const waitForRateLimit = async (debug = false): Promise<void> => {
  const waitTime = getRateLimitWait();
  if (waitTime > 0) {
    debugLog(`Rate limited, waiting ${waitTime}ms`, debug);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, waitTime);
    });
  }
};

/**
 * Send a webhook message to Discord.
 * Handles rate limiting and retries automatically.
 *
 * @param url - Webhook URL
 * @param payload - Webhook payload (Discord format)
 * @param options - Send options
 */
export const sendWebhookRequest = async (
  url: string,
  payload: DiscordWebhookPayload,
  options: WebhookSendOptions = {},
): Promise<NotificationResult> => {
  const { retryCount = 0, debugLog: debug = false, timeout = 10000 } = options;

  try {
    // Validate URL
    const validation = validateWebhookUrl(url);
    if (!validation.valid) {
      debugLog(`Invalid webhook URL: ${validation.reason}`, debug);
      return { success: false, error: validation.reason };
    }

    // Wait for rate limit if necessary
    await waitForRateLimit(debug);

    debugLog(`Sending webhook request (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`, debug);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Handle rate limiting (429)
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const retryMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : DEFAULT_RETRY_DELAY_MS;

        rateLimitState.isRateLimited = true;
        rateLimitState.retryAfter = retryMs;
        rateLimitState.retryTimestamp = Date.now() + retryMs;

        debugLog(`Rate limited (429), retry after ${retryMs}ms`, debug);

        // Retry if we haven't exceeded max retries
        if (retryCount < MAX_RETRIES) {
          await waitForRateLimit(debug);
          return sendWebhookRequest(url, payload, {
            ...options,
            retryCount: retryCount + 1,
          });
        }

        return {
          success: false,
          error: 'Rate limited, max retries exceeded',
          statusCode: 429,
        };
      }

      // Success cases
      if (response.status === 204 || response.status === 200) {
        debugLog('Webhook sent successfully', debug);
        return { success: true, statusCode: response.status };
      }

      // Other error cases
      const errorBody = await response.text().catch(() => 'Unknown error');
      debugLog(`Webhook failed: ${response.status} - ${errorBody}`, debug);

      // Retry on 5xx errors
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        debugLog(`Server error (${response.status}), retrying...`, debug);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, DEFAULT_RETRY_DELAY_MS);
        });
        return sendWebhookRequest(url, payload, {
          ...options,
          retryCount: retryCount + 1,
        });
      }

      return {
        success: false,
        error: `HTTP ${response.status}: ${errorBody}`,
        statusCode: response.status,
      };
    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }
  } catch (error) {
    // Handle timeout/abort
    const maybeAbortError = error as { name?: unknown };
    if (maybeAbortError?.name === 'AbortError') {
      debugLog(`Webhook request timed out after ${timeout}ms`, debug);

      // Retry on timeout
      if (retryCount < MAX_RETRIES) {
        return sendWebhookRequest(url, payload, {
          ...options,
          retryCount: retryCount + 1,
        });
      }

      return { success: false, error: 'Request timed out' };
    }

    const errorMessage = getErrorMessage(error);
    debugLog(`Webhook exception: ${errorMessage}`, debug);
    return { success: false, error: errorMessage };
  }
};

// ========================================
// QUEUE FUNCTIONS
// ========================================

/**
 * Add a message to the webhook queue.
 *
 * @param item - Queue item
 * @returns True if added, false if queue is full
 */
export const enqueueWebhook = (item: QueueInput): boolean => {
  if (webhookQueue.length >= MAX_QUEUE_SIZE) {
    // Remove oldest item to make room
    webhookQueue.shift();
  }

  webhookQueue.push({
    ...item,
    queuedAt: Date.now(),
  });

  // Start processing if not already running
  if (!isProcessingQueue) {
    void processQueue();
  }

  return true;
};

/**
 * Process the webhook queue.
 * Sends queued messages one at a time, respecting rate limits.
 */
const processQueue = async (): Promise<void> => {
  if (isProcessingQueue || webhookQueue.length === 0) {
    return;
  }

  isProcessingQueue = true;

  while (webhookQueue.length > 0) {
    const item = webhookQueue.shift();

    if (!item) continue;

    await sendWebhookRequest(item.url, item.payload, item.options);

    // Small delay between messages to avoid hitting rate limits
    if (webhookQueue.length > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250);
      });
    }
  }

  isProcessingQueue = false;
};

/**
 * Get the current queue size.
 *
 * @returns Number of items in queue
 */
export const getQueueSize = (): number => webhookQueue.length;

/**
 * Clear the webhook queue.
 *
 * @returns Number of items cleared
 */
export const clearQueue = (): number => {
  const count = webhookQueue.length;
  webhookQueue.length = 0;
  return count;
};

// ========================================
// HIGH-LEVEL API
// ========================================

/**
 * Send a webhook notification.
 * This is the main function for sending notifications via webhook.
 * Uses the queue for reliability and handles formatting automatically.
 *
 * @param url - Webhook URL
 * @param notification - Notification details
 * @param options - Additional options
 */
export const sendWebhookNotification = async (
  url: string,
  notification: WebhookNotificationInput,
  options: WebhookNotifyOptions = {},
): Promise<NotificationResult> => {
  const { username = 'OpenCode Notify', mention = false, useQueue = true, debugLog: debug = false } = options;

  try {
    // Build embed
    const embed = buildDiscordEmbed(notification);

    // Build payload
    const payload = buildWebhookPayload({
      username,
      content: mention ? '@everyone' : undefined,
      embeds: [embed],
    });

    debugLog(`Preparing webhook: ${notification.eventType} - ${notification.title}`, debug);

    // Use queue or send directly
    if (useQueue) {
      enqueueWebhook({
        url,
        payload,
        options: { debugLog: debug },
      });

      debugLog('Webhook queued for delivery', debug);
      return { success: true, queued: true };
    }

    return await sendWebhookRequest(url, payload, { debugLog: debug });
  } catch (error) {
    const errorMessage = getErrorMessage(error);
    debugLog(`Webhook notification error: ${errorMessage}`, debug);
    return { success: false, error: errorMessage };
  }
};

/**
 * Send an idle notification webhook.
 * Pre-configured for task completion notifications.
 *
 * @param url - Webhook URL
 * @param message - Notification message
 * @param options - Additional options
 */
export const notifyWebhookIdle = async (
  url: string,
  message: string,
  options: WebhookNotifyOptions = {},
): Promise<NotificationResult> => {
  return sendWebhookNotification(
    url,
    {
      eventType: 'idle',
      title: options.projectName ? `${options.projectName} - Task Complete` : 'Task Complete',
      message,
      projectName: options.projectName,
      sessionId: options.sessionId,
    },
    options,
  );
};

/**
 * Send a permission notification webhook.
 * Pre-configured for permission request notifications.
 *
 * @param url - Webhook URL
 * @param message - Notification message
 * @param options - Additional options
 */
export const notifyWebhookPermission = async (
  url: string,
  message: string,
  options: WebhookNotifyOptions = {},
): Promise<NotificationResult> => {
  return sendWebhookNotification(
    url,
    {
      eventType: 'permission',
      title: options.count && options.count > 1 ? `${options.count} Permissions Required` : 'Permission Required',
      message,
      projectName: options.projectName,
      sessionId: options.sessionId,
      count: options.count,
    },
    {
      ...options,
      mention: options.mention !== undefined ? options.mention : true, // Default to mention for permissions
    },
  );
};

/**
 * Send an error notification webhook.
 * Pre-configured for error notifications.
 *
 * @param url - Webhook URL
 * @param message - Notification message
 * @param options - Additional options
 */
export const notifyWebhookError = async (
  url: string,
  message: string,
  options: WebhookNotifyOptions = {},
): Promise<NotificationResult> => {
  return sendWebhookNotification(
    url,
    {
      eventType: 'error',
      title: options.projectName ? `${options.projectName} - Error` : 'Agent Error',
      message,
      projectName: options.projectName,
      sessionId: options.sessionId,
    },
    {
      ...options,
      mention: options.mention !== undefined ? options.mention : true, // Default to mention for errors
    },
  );
};

/**
 * Send a question notification webhook.
 * Pre-configured for question notifications.
 *
 * @param url - Webhook URL
 * @param message - Notification message
 * @param options - Additional options
 */
export const notifyWebhookQuestion = async (
  url: string,
  message: string,
  options: WebhookNotifyOptions = {},
): Promise<NotificationResult> => {
  return sendWebhookNotification(
    url,
    {
      eventType: 'question',
      title: options.count && options.count > 1 ? `${options.count} Questions Need Your Input` : 'Question',
      message,
      projectName: options.projectName,
      sessionId: options.sessionId,
      count: options.count,
    },
    options,
  );
};

// ========================================
// TESTING UTILITIES
// ========================================

/**
 * Reset rate limit state.
 * Used for testing.
 */
export const resetRateLimitState = (): void => {
  rateLimitState.isRateLimited = false;
  rateLimitState.retryAfter = 0;
  rateLimitState.retryTimestamp = 0;
};

/**
 * Get rate limit state.
 * Used for testing and debugging.
 *
 * @returns Current rate limit state
 */
export const getRateLimitState = (): RateLimitState => ({ ...rateLimitState });

// Default export for convenience
export default {
  // Core functions
  sendWebhookRequest,
  sendWebhookNotification,
  validateWebhookUrl,
  buildDiscordEmbed,
  buildWebhookPayload,

  // Rate limiting
  isRateLimited,
  getRateLimitWait,
  resetRateLimitState,
  getRateLimitState,

  // Queue functions
  enqueueWebhook,
  getQueueSize,
  clearQueue,

  // High-level helpers
  notifyWebhookIdle,
  notifyWebhookPermission,
  notifyWebhookError,
  notifyWebhookQuestion,

  // Constants
  EMBED_COLORS,
};
