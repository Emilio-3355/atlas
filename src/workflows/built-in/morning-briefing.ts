import type { WorkflowDefinition } from '../../types/index.js';

export const morningBriefingWorkflow: WorkflowDefinition = {
  id: 'built-in-morning-briefing',
  name: 'Morning Briefing',
  description: 'Compile calendar events, unread emails, weather, and reminders into a morning summary.',
  triggerPattern: 'morning briefing',
  steps: [
    {
      id: 'calendar',
      tool: 'calendar_read',
      input: {
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + 86400000).toISOString(),
      },
      requiresApproval: false,
      onError: 'skip',
      playByPlay: 'Checking your calendar...',
    },
    {
      id: 'emails',
      tool: 'read_email',
      input: { query: 'is:unread', maxResults: 5 },
      requiresApproval: false,
      onError: 'skip',
      playByPlay: 'Checking your inbox...',
    },
    {
      id: 'reminders',
      tool: 'recall',
      input: { query: 'today reminders schedule' },
      requiresApproval: false,
      onError: 'skip',
      playByPlay: 'Compiling your briefing...',
    },
  ],
  status: 'active',
  usageCount: 0,
  createdAt: new Date(),
};
