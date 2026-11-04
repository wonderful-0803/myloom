/**
 * Watchdog - Detects stuck assignments and dead router loops
 * Records healing events
 */

import type { LoomDB } from './db.js';

export interface WatchdogOptions {
  db: LoomDB;
  onEvent: (event: any) => void;
  checkInterval?: number; // ms
  stuckThreshold?: number; // ms
}

export class Watchdog {
  private db: LoomDB;
  private onEvent: (event: any) => void;
  private checkInterval: number;
  private stuckThreshold: number;
  private timer: NodeJS.Timeout | null = null;
  private lastRouterActivity = Date.now();

  constructor(options: WatchdogOptions) {
    this.db = options.db;
    this.onEvent = options.onEvent;
    this.checkInterval = options.checkInterval || 5000; // 5 seconds
    this.stuckThreshold = options.stuckThreshold || 30000; // 30 seconds
  }

  start(): void {
    this.timer = setInterval(() => {
      this.check();
    }, this.checkInterval);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Record router activity heartbeat
   */
  recordRouterActivity(): void {
    this.lastRouterActivity = Date.now();
  }

  /**
   * Check for stuck assignments and dead router
   */
  private check(): void {
    this.checkStuckAssignments();
    this.checkDeadRouter();
  }

  /**
   * Check for assignments that haven't updated in a while
   */
  private checkStuckAssignments(): void {
    const assignments = this.db.getActiveAssignments();
    const now = Date.now();

    for (const assignment of assignments) {
      const timeSinceUpdate = now - assignment.updatedAt;

      if (timeSinceUpdate > this.stuckThreshold) {
        // Assignment is stuck
        const log = this.db.addWatchdogLog({
          event: 'stuck_assignment',
          details: `Assignment ${assignment.id} for ticket ${assignment.ticketId} stuck for ${Math.floor(timeSinceUpdate / 1000)}s`,
        });

        this.onEvent({ type: 'watchdog_log', data: log });

        // Attempt healing: mark as failed
        this.db.updateAssignment(assignment.id, {
          status: 'ended',
          report: 'failed',
          reportMessage: 'Watchdog detected stuck worker',
        });

        const healLog = this.db.addWatchdogLog({
          event: 'healed',
          details: `Marked stuck assignment ${assignment.id} as failed`,
        });

        this.onEvent({ type: 'watchdog_log', data: healLog });
      }
    }
  }

  /**
   * Check if router is alive
   */
  private checkDeadRouter(): void {
    const now = Date.now();
    const timeSinceActivity = now - this.lastRouterActivity;

    if (timeSinceActivity > this.stuckThreshold * 2) {
      // Router might be dead
      const log = this.db.addWatchdogLog({
        event: 'dead_router',
        details: `No router activity for ${Math.floor(timeSinceActivity / 1000)}s`,
      });

      this.onEvent({ type: 'watchdog_log', data: log });

      // In production, would attempt to restart router
      // For demo, just log
      this.lastRouterActivity = now; // Reset to avoid spam
    }
  }
}
