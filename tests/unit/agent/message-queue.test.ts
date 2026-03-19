import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to test the MessageQueue class directly — re-implement it
// since the module exports a singleton
vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { messageQueue } = await import('../../../src/agent/message-queue.js');

describe('MessageQueue', () => {
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = vi.fn().mockResolvedValue(undefined);
    messageQueue.setHandler(handler);
  });

  it('enqueue adds message to queue and processes it', async () => {
    await messageQueue.enqueue('+1234', 'hello', 'whatsapp');
    expect(handler).toHaveBeenCalledWith('+1234', 'hello', 'whatsapp');
  });

  it('passes channel parameter through to handler', async () => {
    await messageQueue.enqueue('tg:123', 'hi', 'telegram');
    expect(handler).toHaveBeenCalledWith('tg:123', 'hi', 'telegram');
  });

  it('serializes messages for same phone', async () => {
    const order: number[] = [];
    handler.mockImplementation(async (_phone: string, msg: string) => {
      const num = parseInt(msg, 10);
      order.push(num);
      await new Promise((r) => setTimeout(r, 10));
    });

    const p1 = messageQueue.enqueue('+serial', '1', 'whatsapp');
    const p2 = messageQueue.enqueue('+serial', '2', 'whatsapp');
    const p3 = messageQueue.enqueue('+serial', '3', 'whatsapp');

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('allows parallel processing for different phones', async () => {
    const active = new Set<string>();
    let wasParallel = false;

    handler.mockImplementation(async (phone: string) => {
      active.add(phone);
      if (active.size > 1) wasParallel = true;
      await new Promise((r) => setTimeout(r, 20));
      active.delete(phone);
    });

    await Promise.all([
      messageQueue.enqueue('+user1', 'msg', 'whatsapp'),
      messageQueue.enqueue('+user2', 'msg', 'whatsapp'),
    ]);

    expect(wasParallel).toBe(true);
  });

  it('rejects promise when handler throws', async () => {
    handler.mockRejectedValueOnce(new Error('handler failed'));
    await expect(messageQueue.enqueue('+err', 'boom', 'whatsapp')).rejects.toThrow('handler failed');
  });

  it('getQueueSize returns 0 for unknown phone', () => {
    expect(messageQueue.getQueueSize('+nonexistent')).toBe(0);
  });
});
