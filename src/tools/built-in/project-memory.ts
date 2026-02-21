import type { ToolDefinition, ToolResult, ToolContext } from '../../types/index.js';
import { upsertFact, getFact, getFactsByCategory } from '../../memory/structured.js';
import { storeSemanticMemory, hybridSearch } from '../../memory/semantic.js';
import fs from 'fs';
import path from 'path';
import logger from '../../utils/logger.js';

export const projectMemoryTool: ToolDefinition = {
  name: 'project_memory',
  description: 'Multi-project context manager. Track what JP is working on across different codebases. Store and recall project-specific context: current branch, active files, recent changes, TODOs, architecture notes.',
  category: 'informational',
  requiresApproval: false,
  inputSchema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['switch', 'save', 'recall', 'list', 'scan'],
        description: 'switch: set active project | save: store project context | recall: retrieve project context | list: show all projects | scan: auto-detect project info',
      },
      project: { type: 'string', description: 'Project name or path' },
      key: { type: 'string', description: 'Context key (e.g., "current_task", "architecture", "todos")' },
      value: { type: 'string', description: 'Context value to store (for save action)' },
    },
    required: ['action'],
  },
  enabled: true,
  builtIn: true,

  async execute(
    input: { action: string; project?: string; key?: string; value?: string },
    ctx: ToolContext,
  ): Promise<ToolResult> {
    try {
      switch (input.action) {
        case 'switch':
          return await switchProject(input.project!, ctx);
        case 'save':
          return await saveProjectContext(input.project!, input.key!, input.value!, ctx);
        case 'recall':
          return await recallProjectContext(input.project, input.key, ctx);
        case 'list':
          return await listProjects();
        case 'scan':
          return await scanProject(input.project!);
        default:
          return { success: false, error: `Unknown action: ${input.action}` };
      }
    } catch (err) {
      logger.error('Project memory error', { error: err, action: input.action });
      return { success: false, error: err instanceof Error ? err.message : 'Project memory error' };
    }
  },
};

async function switchProject(project: string, ctx: ToolContext): Promise<ToolResult> {
  await upsertFact('project', 'active_project', project, 'system', 1.0);

  // Load project context
  const facts = await getFactsByCategory('project');
  const projectFacts = facts.filter((f) => f.key.startsWith(`${project}:`));

  const context = projectFacts.map((f) => `• ${f.key.replace(`${project}:`, '')}: ${f.value}`).join('\n');

  return {
    success: true,
    data: {
      project,
      context: context || 'No saved context for this project yet.',
      message: `Switched to project: ${project}${context ? '\n\nSaved context:\n' + context : ''}`,
    },
  };
}

async function saveProjectContext(project: string, key: string, value: string, ctx: ToolContext): Promise<ToolResult> {
  const fullKey = `${project}:${key}`;
  await upsertFact('project', fullKey, value, 'system', 1.0);

  // Also store semantically for search
  await storeSemanticMemory(
    `[Project: ${project}] ${key}: ${value}`,
    'project_context',
    ctx.conversationId,
    { project, key },
  );

  return {
    success: true,
    data: { message: `Saved to ${project} context: ${key} = ${value}` },
  };
}

async function recallProjectContext(project?: string, key?: string, ctx?: ToolContext): Promise<ToolResult> {
  if (project && key) {
    const fact = await getFact('project', `${project}:${key}`);
    return {
      success: true,
      data: {
        found: !!fact,
        value: fact?.value,
        message: fact ? `${key}: ${fact.value}` : `No "${key}" saved for project ${project}`,
      },
    };
  }

  // Search all project context
  const searchQuery = project ? `project ${project}` : 'project context';
  const semanticResults = await hybridSearch(searchQuery, 10);

  const projectResults = project
    ? semanticResults.filter((r) => r.metadata?.project === project || r.content.includes(project))
    : semanticResults;

  return {
    success: true,
    data: {
      results: projectResults.map((r) => r.content),
      message: projectResults.length > 0
        ? projectResults.map((r) => `• ${r.content}`).join('\n')
        : 'No project context found.',
    },
  };
}

async function listProjects(): Promise<ToolResult> {
  const facts = await getFactsByCategory('project');

  // Extract unique project names
  const projects = new Set<string>();
  for (const fact of facts) {
    if (fact.key === 'active_project') continue;
    const projectName = fact.key.split(':')[0];
    if (projectName) projects.add(projectName);
  }

  const activeFact = facts.find((f) => f.key === 'active_project');

  return {
    success: true,
    data: {
      projects: Array.from(projects),
      active: activeFact?.value,
      message: projects.size > 0
        ? `*Projects:*\n${Array.from(projects).map((p) => `• ${p}${p === activeFact?.value ? ' ← active' : ''}`).join('\n')}`
        : 'No projects tracked yet.',
    },
  };
}

async function scanProject(projectPath: string): Promise<ToolResult> {
  const resolved = path.resolve(projectPath);

  if (!fs.existsSync(resolved)) {
    return { success: false, error: `Directory not found: ${resolved}` };
  }

  const info: Record<string, string> = {};
  const projectName = path.basename(resolved);

  // Detect project type
  if (fs.existsSync(path.join(resolved, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf-8'));
      info.type = 'node';
      info.name = pkg.name || projectName;
      info.description = pkg.description || '';
      info.scripts = Object.keys(pkg.scripts || {}).join(', ');
    } catch {}
  }

  if (fs.existsSync(path.join(resolved, 'Cargo.toml'))) info.type = 'rust';
  if (fs.existsSync(path.join(resolved, 'requirements.txt')) || fs.existsSync(path.join(resolved, 'pyproject.toml'))) info.type = 'python';
  if (fs.existsSync(path.join(resolved, 'go.mod'))) info.type = 'go';

  // Check for git
  if (fs.existsSync(path.join(resolved, '.git'))) {
    info.git = 'yes';
  }

  // Check for CLAUDE.md or README
  for (const doc of ['CLAUDE.md', 'README.md', 'readme.md']) {
    if (fs.existsSync(path.join(resolved, doc))) {
      const content = fs.readFileSync(path.join(resolved, doc), 'utf-8').slice(0, 500);
      info[doc] = content;
      break;
    }
  }

  // Count files
  try {
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
    info.directories = dirs.join(', ');
  } catch {}

  // Save scanned info
  for (const [key, value] of Object.entries(info)) {
    await upsertFact('project', `${projectName}:${key}`, value, 'system', 0.9);
  }

  return {
    success: true,
    data: {
      project: projectName,
      path: resolved,
      info,
      message: `Scanned *${projectName}*:\n${Object.entries(info).map(([k, v]) => `• ${k}: ${v.slice(0, 100)}`).join('\n')}`,
    },
  };
}
