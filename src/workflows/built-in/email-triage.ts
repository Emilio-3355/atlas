import type { WorkflowDefinition } from '../../types/index.js';

export const emailTriageWorkflow: WorkflowDefinition = {
  id: 'built-in-email-triage',
  name: 'Email Triage',
  description: 'Read unread emails, categorize by urgency, and draft replies for JP to approve.',
  triggerPattern: 'triage my email',
  steps: [
    {
      id: 'read_unread',
      tool: 'read_email',
      input: { query: 'is:unread', maxResults: 10 },
      requiresApproval: false,
      onError: 'stop',
      playByPlay: 'Reading your unread emails...',
    },
    {
      id: 'present_summary',
      tool: 'recall',
      input: { query: 'email contacts and priorities' },
      requiresApproval: true,
      onError: 'stop',
      playByPlay: 'Here\'s a summary — which ones need replies?',
    },
  ],
  status: 'active',
  usageCount: 0,
  createdAt: new Date(),
};
