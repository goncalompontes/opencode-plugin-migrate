import type { NotificationEventType } from './config.js';

export interface DesktopNotifyOptions {
  timeout?: number;
  sound?: boolean;
  icon?: string;
  subtitle?: string;
  urgency?: 'low' | 'normal' | 'critical';
  debugLog?: boolean;
  projectName?: string;
  count?: number;
}

export interface NotificationResult {
  success: boolean;
  error?: string;
  queued?: boolean;
  statusCode?: number;
}

export interface WebhookNotifyOptions {
  projectName?: string;
  sessionId?: string;
  count?: number;
  username?: string;
  mention?: boolean;
  useQueue?: boolean;
  debugLog?: boolean;
  timeout?: number;
  avatarUrl?: string;
  content?: string;
}

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  timestamp: string;
  footer?: {
    text: string;
  };
  fields?: DiscordEmbedField[];
}

export interface DiscordWebhookPayload {
  username?: string;
  avatar_url?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

export interface RateLimitState {
  isRateLimited: boolean;
  retryAfter: number;
  retryTimestamp: number;
}

export interface WebhookQueueItem {
  url: string;
  payload: DiscordWebhookPayload;
  options?: {
    retryCount?: number;
    timeout?: number;
    debugLog?: boolean;
    eventType?: NotificationEventType;
    [key: string]: unknown;
  };
  queuedAt: number;
}
