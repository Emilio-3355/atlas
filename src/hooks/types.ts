import type { ToolResult, ToolContext } from '../types/index.js';

export interface HookContext extends ToolContext {
  toolName: string;
  toolInput: Record<string, any>;
}

export interface PreToolHookResult {
  allowed: boolean;
  modifiedInput?: Record<string, any>;
  reason?: string;
}

export interface PostToolHookResult {
  modifiedResult?: ToolResult;
  patterns?: string[];
}

export type PreToolHook = (ctx: HookContext) => Promise<PreToolHookResult>;
export type PostToolHook = (ctx: HookContext, result: ToolResult) => Promise<PostToolHookResult>;
export type PreResponseHook = (response: string, ctx: ToolContext) => Promise<string>;
export type OnErrorHook = (error: Error, ctx: HookContext) => Promise<{ retry: boolean; fallback?: string }>;
