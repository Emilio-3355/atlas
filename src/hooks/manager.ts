import type { PreToolHook, PostToolHook, PreResponseHook, OnErrorHook, HookContext } from './types.js';
import type { ToolResult, ToolContext } from '../types/index.js';
import logger from '../utils/logger.js';

class HookManager {
  private preToolHooks: PreToolHook[] = [];
  private postToolHooks: PostToolHook[] = [];
  private preResponseHooks: PreResponseHook[] = [];
  private onErrorHooks: OnErrorHook[] = [];

  registerPreTool(hook: PreToolHook): void {
    this.preToolHooks.push(hook);
  }

  registerPostTool(hook: PostToolHook): void {
    this.postToolHooks.push(hook);
  }

  registerPreResponse(hook: PreResponseHook): void {
    this.preResponseHooks.push(hook);
  }

  registerOnError(hook: OnErrorHook): void {
    this.onErrorHooks.push(hook);
  }

  async runPreToolHooks(ctx: HookContext): Promise<{ allowed: boolean; input: Record<string, any>; reason?: string }> {
    let input = { ...ctx.toolInput };

    for (const hook of this.preToolHooks) {
      try {
        const result = await hook({ ...ctx, toolInput: input });
        if (!result.allowed) {
          return { allowed: false, input, reason: result.reason };
        }
        if (result.modifiedInput) {
          input = result.modifiedInput;
        }
      } catch (err) {
        logger.error('Pre-tool hook error', { error: err, tool: ctx.toolName });
      }
    }

    return { allowed: true, input };
  }

  async runPostToolHooks(ctx: HookContext, result: ToolResult): Promise<ToolResult> {
    let currentResult = result;

    for (const hook of this.postToolHooks) {
      try {
        const hookResult = await hook(ctx, currentResult);
        if (hookResult.modifiedResult) {
          currentResult = hookResult.modifiedResult;
        }
      } catch (err) {
        logger.error('Post-tool hook error', { error: err, tool: ctx.toolName });
      }
    }

    return currentResult;
  }

  async runPreResponseHooks(response: string, ctx: ToolContext): Promise<string> {
    let currentResponse = response;

    for (const hook of this.preResponseHooks) {
      try {
        currentResponse = await hook(currentResponse, ctx);
      } catch (err) {
        logger.error('Pre-response hook error', { error: err });
      }
    }

    return currentResponse;
  }

  async runOnErrorHooks(error: Error, ctx: HookContext): Promise<{ retry: boolean; fallback?: string }> {
    for (const hook of this.onErrorHooks) {
      try {
        const result = await hook(error, ctx);
        if (result.retry || result.fallback) return result;
      } catch (err) {
        logger.error('On-error hook error', { error: err });
      }
    }
    return { retry: false };
  }
}

export const hookManager = new HookManager();
