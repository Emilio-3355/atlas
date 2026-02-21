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
  ]);

  const toolKeys = [
    'webSearchTool', 'browseTool', 'screenshotTool', 'readEmailTool',
    'calendarReadTool', 'recallTool', 'readPdfTool', 'reflectTool',
    'rememberTool', 'remindTool', 'sendEmailTool', 'calendarCreateTool',
    'fillFormTool', 'bookReservationTool', 'generateImageTool', 'scheduleTaskTool',
    'proposeToolTool', 'proposeWorkflowTool',
    'spawnAgentTool', 'codeForgeTool', 'projectMemoryTool',
    'stockPriceTool', 'secFilingsTool', 'financialDataTool', 'earningsAnalysisTool',
  ];

  for (let i = 0; i < modules.length; i++) {
    const tool = (modules[i] as any)[toolKeys[i]] as ToolDefinition;
    if (tool) reg.register(tool);
  }

  logger.info(`Registered ${reg.getAll().length} built-in tools`);
}
