import type { ToolDefinition } from '../types/index.js';
import logger from '../utils/logger.js';

class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    if (this.tools.has(tool.name)) {
      logger.warn(`Tool ${tool.name} already registered — overwriting`);
    }
    this.tools.set(tool.name, tool);
    logger.debug(`Tool registered: ${tool.name}`);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => t.enabled);
  }

  getNames(): string[] {
    return this.getAll().map((t) => t.name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  disable(name: string): void {
    const tool = this.tools.get(name);
    if (tool) tool.enabled = false;
  }

  enable(name: string): void {
    const tool = this.tools.get(name);
    if (tool) tool.enabled = true;
  }

  // Count all registered tools
  count(): number {
    return this.tools.size;
  }
}

let registry: ToolRegistry | null = null;

export function getToolRegistry(): ToolRegistry {
  if (!registry) {
    registry = new ToolRegistry();
  }
  return registry;
}

export function registerBuiltInTools(): void {
  const reg = getToolRegistry();

  // Dynamically import and register all built-in tools
  const tools: ToolDefinition[] = [];

  // We'll register them synchronously since they're static definitions
  import('./built-in/web-search.js').then((m) => reg.register(m.webSearchTool));
  import('./built-in/browse.js').then((m) => reg.register(m.browseTool));
  import('./built-in/screenshot.js').then((m) => reg.register(m.screenshotTool));
  import('./built-in/read-email.js').then((m) => reg.register(m.readEmailTool));
  import('./built-in/calendar-read.js').then((m) => reg.register(m.calendarReadTool));
  import('./built-in/recall.js').then((m) => reg.register(m.recallTool));
  import('./built-in/read-pdf.js').then((m) => reg.register(m.readPdfTool));
  import('./built-in/reflect.js').then((m) => reg.register(m.reflectTool));
  import('./built-in/remember.js').then((m) => reg.register(m.rememberTool));
  import('./built-in/remind.js').then((m) => reg.register(m.remindTool));
  import('./built-in/send-email.js').then((m) => reg.register(m.sendEmailTool));
  import('./built-in/calendar-create.js').then((m) => reg.register(m.calendarCreateTool));
  import('./built-in/fill-form.js').then((m) => reg.register(m.fillFormTool));
  import('./built-in/book-reservation.js').then((m) => reg.register(m.bookReservationTool));
  import('./built-in/generate-image.js').then((m) => reg.register(m.generateImageTool));
  import('./built-in/schedule-task.js').then((m) => reg.register(m.scheduleTaskTool));
  import('./built-in/propose-tool.js').then((m) => reg.register(m.proposeToolTool));
  import('./built-in/propose-workflow.js').then((m) => reg.register(m.proposeWorkflowTool));

  logger.info('Registering 18 built-in tools');
}

export async function registerBuiltInToolsAsync(): Promise<void> {
  const reg = getToolRegistry();

  const modules = await Promise.all([
    import('./built-in/web-search.js'),
    import('./built-in/browse.js'),
    import('./built-in/screenshot.js'),
    import('./built-in/read-email.js'),
    import('./built-in/calendar-read.js'),
    import('./built-in/recall.js'),
    import('./built-in/read-pdf.js'),
    import('./built-in/reflect.js'),
    import('./built-in/remember.js'),
    import('./built-in/remind.js'),
    import('./built-in/send-email.js'),
    import('./built-in/calendar-create.js'),
    import('./built-in/fill-form.js'),
    import('./built-in/book-reservation.js'),
    import('./built-in/generate-image.js'),
    import('./built-in/schedule-task.js'),
    import('./built-in/propose-tool.js'),
    import('./built-in/propose-workflow.js'),
    import('./built-in/spawn-agent.js'),
    import('./built-in/code-forge.js'),
    import('./built-in/project-memory.js'),
    import('./built-in/stock-price.js'),
    import('./built-in/sec-filings.js'),
    import('./built-in/financial-data.js'),
    import('./built-in/earnings-analysis.js'),
    import('./built-in/server-shell.js'),
    import('./built-in/local-exec.js'),
  ]);

  const toolKeys = [
    'webSearchTool', 'browseTool', 'screenshotTool', 'readEmailTool',
    'calendarReadTool', 'recallTool', 'readPdfTool', 'reflectTool',
    'rememberTool', 'remindTool', 'sendEmailTool', 'calendarCreateTool',
    'fillFormTool', 'bookReservationTool', 'generateImageTool', 'scheduleTaskTool',
    'proposeToolTool', 'proposeWorkflowTool',
    'spawnAgentTool', 'codeForgeTool', 'projectMemoryTool',
    'stockPriceTool', 'secFilingsTool', 'financialDataTool', 'earningsAnalysisTool',
    'serverShellTool', 'localExecTool',
  ];

  for (let i = 0; i < modules.length; i++) {
    const tool = (modules[i] as any)[toolKeys[i]] as ToolDefinition;
    if (tool) reg.register(tool);
  }

  // Register browser network tools (multiple exports from one module)
  try {
    const browserNetMod = await import('./built-in/browser-network.js');
    if (browserNetMod.browserNetworkTool) reg.register(browserNetMod.browserNetworkTool);
    if (browserNetMod.browserNetworkInterceptTool) reg.register(browserNetMod.browserNetworkInterceptTool);
    if (browserNetMod.browserNetworkClearTool) reg.register(browserNetMod.browserNetworkClearTool);
  } catch (err) {
    logger.warn('Failed to load browser network tools', { error: err });
  }

  // Register voice reply tool
  try {
    const voiceMod = await import('./built-in/voice-reply.js');
    if (voiceMod.voiceReplyTool) reg.register(voiceMod.voiceReplyTool);
  } catch (err) {
    logger.warn('Failed to load voice reply tool', { error: err });
  }

  // Register filesystem tool
  try {
    const fsMod = await import('./built-in/filesystem.js');
    if (fsMod.filesystemTool) reg.register(fsMod.filesystemTool);
  } catch (err) {
    logger.warn('Failed to load filesystem tool', { error: err });
  }

  // Register video summarization tool
  try {
    const videoMod = await import('./built-in/summarize-video.js');
    if (videoMod.summarizeVideoTool) reg.register(videoMod.summarizeVideoTool);
  } catch (err) {
    logger.warn('Failed to load video summarize tool', { error: err });
  }

  logger.info(`Registered ${reg.getAll().length} built-in tools`);
}

/**
 * Load dynamically-generated tools from the database (code_forge output).
 * Called at startup to restore tools that were forged in previous sessions.
 */
export async function loadDynamicTools(): Promise<void> {
  try {
    const { query } = await import('../config/database.js');
    const result = await query(
      `SELECT name, implementation FROM tool_definitions WHERE status = 'active' AND implementation_type = 'generated_code'`
    );

    const reg = getToolRegistry();
    let loaded = 0;

    for (const row of result.rows) {
      try {
        const impl = typeof row.implementation === 'string' ? JSON.parse(row.implementation) : row.implementation;
        const code = impl.code;
        if (!code) continue;

        const dataUrl = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
        const module = await import(dataUrl);
        const tool = module.tool;

        if (tool && tool.name && typeof tool.execute === 'function') {
          reg.register(tool);
          loaded++;
        }
      } catch (err) {
        logger.warn(`Failed to load dynamic tool: ${row.name}`, { error: err });
      }
    }

    if (loaded > 0) {
      logger.info(`Loaded ${loaded} dynamic tools from database`);
    }
  } catch (err) {
    logger.warn('Could not load dynamic tools (DB may not be ready)', { error: err });
  }
}
