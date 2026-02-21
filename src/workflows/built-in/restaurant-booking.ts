import type { WorkflowDefinition } from '../../types/index.js';

export const restaurantBookingWorkflow: WorkflowDefinition = {
  id: 'built-in-restaurant-booking',
  name: 'Restaurant Booking',
  description: 'Search for restaurants, compare options with screenshots, and book a table with approval at every step.',
  triggerPattern: 'book a table',
  steps: [
    {
      id: 'search',
      tool: 'web_search',
      input: { query: '$input.query' },
      requiresApproval: false,
      onError: 'stop',
      playByPlay: 'Searching for restaurants...',
    },
    {
      id: 'browse_top',
      tool: 'browse',
      input: { url: '$step[search].result.results[0].url' },
      requiresApproval: false,
      onError: 'skip',
      playByPlay: 'Checking out the top result...',
    },
    {
      id: 'screenshot_options',
      tool: 'screenshot',
      input: { url: '$step[search].result.results[0].url', caption: 'Option 1' },
      requiresApproval: false,
      onError: 'skip',
      playByPlay: 'Taking screenshots of options...',
    },
    {
      id: 'present_options',
      tool: 'recall',
      input: { query: 'restaurant preferences' },
      requiresApproval: true,
      onError: 'stop',
      playByPlay: 'Here are your options — which one?',
    },
  ],
  status: 'active',
  usageCount: 0,
  createdAt: new Date(),
};
