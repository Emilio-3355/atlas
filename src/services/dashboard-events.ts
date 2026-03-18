import { EventEmitter } from 'events';

export interface DashboardEvent {
  type:
    | 'tool_call'
    | 'tool_result'
    | 'message_in'
    | 'message_out'
    | 'cron_fired'
    | 'task_fired'
    | 'approval_created'
    | 'foundry_proposals'
    | 'error'
    | 'heartbeat'
    | 'sub_agent_start'
    | 'sub_agent_done';
  ts: number;
  data: Record<string, any>;
}

class DashboardEventBus extends EventEmitter {
  publish(event: Omit<DashboardEvent, 'ts'>): void {
    const full: DashboardEvent = { ...event, ts: Date.now() };
    this.emit('event', full);
  }
}

export const dashboardBus = new DashboardEventBus();
dashboardBus.setMaxListeners(50);
