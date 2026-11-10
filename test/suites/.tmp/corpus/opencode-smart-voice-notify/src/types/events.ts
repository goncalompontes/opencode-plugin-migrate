import type { AIContext, NotificationEventType } from './config.js';

export interface PendingReminder {
  timeoutId: ReturnType<typeof setTimeout>;
  scheduledAt: number;
  followUpCount: number;
  itemCount: number;
  aiContext: AIContext;
}

export interface QuestionBatchItem {
  id: string;
  questionCount: number;
}

export interface PluginState {
  pendingReminders: Map<NotificationEventType, PendingReminder>;
  lastUserActivityTime: number;
  lastSessionIdleTime: number;
  activePermissionId: string | null | undefined;
  activeQuestionId: string | null | undefined;
  pendingPermissionBatch: string[];
  pendingQuestionBatch: QuestionBatchItem[];
  permissionBatchTimeout: ReturnType<typeof setTimeout> | null;
  questionBatchTimeout: ReturnType<typeof setTimeout> | null;
  lastIdleNotificationTime: Map<string, number>;
  seenUserMessageIds: Set<string>;
}

export interface SmartNotifyOptions {
  soundFile?: string;
  soundLoops?: number;
  ttsMessage?: string | null;
  fallbackSound?: string;
  permissionCount?: number;
  questionCount?: number;
  errorCount?: number;
  aiContext?: AIContext;
}

export interface ScheduleReminderOptions {
  fallbackSound?: string;
  permissionCount?: number;
  questionCount?: number;
  errorCount?: number;
  aiContext?: AIContext;
}
