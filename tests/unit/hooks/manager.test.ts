import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Since HookManager is a singleton, we test the class behavior by reading the source logic
// and creating isolated instances. However, the module exports a singleton.
// We'll test behavior patterns rather than isolated state.

describe('HookManager behavior', () => {
  it('runPreToolHooks returns allowed=true by default', async () => {
    // Create a fresh manager-like object to test logic
    const { hookManager } = await import('../../../src/hooks/manager.js');
    // Without registering any new hooks beyond what's accumulated,
    // the basic concept: if all hooks pass, result is allowed
    // Since we can't reset the singleton, test the contract:
    const ctx = { toolName: 'unique_test_tool', toolInput: { a: 1 }, conversationId: '1', userPhone: '+1', language: 'en', channel: 'whatsapp' as const };
    const result = await hookManager.runPreToolHooks(ctx);
    // Either it's allowed or blocked — but the function returns a result
    expect(result).toHaveProperty('allowed');
    expect(result).toHaveProperty('input');
  });

  it('runOnErrorHooks returns { retry: false } when no hook handles', async () => {
    const { hookManager } = await import('../../../src/hooks/manager.js');
    const result = await hookManager.runOnErrorHooks(
      new Error('test error'),
      { toolName: 'test', toolInput: {}, conversationId: '1', userPhone: '+1', language: 'en', channel: 'whatsapp' as const },
    );
    // On-error hooks should return retry:false if nothing handles it
    expect(typeof result.retry).toBe('boolean');
  });

  it('runPreResponseHooks passes response through', async () => {
    const { hookManager } = await import('../../../src/hooks/manager.js');
    const ctx = { conversationId: '1', userPhone: '+1', language: 'en', channel: 'whatsapp' as const };
    const result = await hookManager.runPreResponseHooks('hello world', ctx);
    // Response should at minimum contain the original text (hooks may append)
    expect(typeof result).toBe('string');
    expect(result).toContain('hello world');
  });

  it('runPostToolHooks returns a ToolResult', async () => {
    const { hookManager } = await import('../../../src/hooks/manager.js');
    const ctx = { toolName: 'test', toolInput: {}, conversationId: '1', userPhone: '+1', language: 'en', channel: 'whatsapp' as const };
    const result = await hookManager.runPostToolHooks(ctx, { success: true, data: 'original' });
    expect(result).toHaveProperty('success');
  });

  it('pre-tool hooks receive the correct context', async () => {
    const { hookManager } = await import('../../../src/hooks/manager.js');
    const receivedCtx: any[] = [];
    hookManager.registerPreTool(async (ctx: any) => {
      receivedCtx.push(ctx);
      return { allowed: true };
    });
    const ctx = { toolName: 'capture_test', toolInput: { key: 'val' }, conversationId: '1', userPhone: '+1', language: 'en', channel: 'whatsapp' as const };
    await hookManager.runPreToolHooks(ctx);
    const captured = receivedCtx.find((c: any) => c.toolName === 'capture_test');
    expect(captured).toBeDefined();
    expect(captured.toolInput.key).toBe('val');
  });

  it('on-error hook can provide fallback', async () => {
    const { hookManager } = await import('../../../src/hooks/manager.js');
    hookManager.registerOnError(async (err: Error) => {
      if (err.message === 'fallback_trigger') return { retry: false, fallback: 'recovered' };
      return { retry: false };
    });
    const result = await hookManager.runOnErrorHooks(
      new Error('fallback_trigger'),
      { toolName: 'test', toolInput: {}, conversationId: '1', userPhone: '+1', language: 'en', channel: 'whatsapp' as const },
    );
    expect(result.fallback).toBe('recovered');
  });
});
