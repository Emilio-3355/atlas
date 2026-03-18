import logger from '../utils/logger.js';
import type { MessageChannel } from '../types/index.js';

type MessageHandler = (phone: string, message: string, channel: MessageChannel) => Promise<void>;

interface QueueItem {
  phone: string;
  message: string;
  channel: MessageChannel;
  resolve: () => void;
  reject: (err: Error) => void;
}

// Per-user serial processing queue — prevents race conditions
class MessageQueue {
  private queues = new Map<string, QueueItem[]>();
  private processing = new Set<string>();
  private handler: MessageHandler | null = null;

  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  async enqueue(phone: string, message: string, channel: MessageChannel = 'whatsapp'): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.queues.has(phone)) {
        this.queues.set(phone, []);
      }
      this.queues.get(phone)!.push({ phone, message, channel, resolve, reject });
      this.processQueue(phone);
    });
  }

  private async processQueue(phone: string): Promise<void> {
    if (this.processing.has(phone)) return;
    this.processing.add(phone);

    const queue = this.queues.get(phone);
    if (!queue) {
      this.processing.delete(phone);
      return;
    }

    while (queue.length > 0) {
      const item = queue.shift()!;
      try {
        if (this.handler) {
          await this.handler(item.phone, item.message, item.channel);
        }
        item.resolve();
      } catch (err) {
        logger.error('Message processing error', { phone, error: err });
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.processing.delete(phone);

    // Clean up empty queue
    if (queue.length === 0) {
      this.queues.delete(phone);
    }
  }

  getQueueSize(phone: string): number {
    return this.queues.get(phone)?.length || 0;
  }
}

export const messageQueue = new MessageQueue();
