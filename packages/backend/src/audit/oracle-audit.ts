export interface AuditEvent {
  id: string;
  eventType: string;
  actor: string;
  timestamp: number;
  metadata: Record<string, any>;
  signature?: string;
}

export class OracleAudit {
  private events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push({
      ...event,
      timestamp: event.timestamp || Date.now(),
    });
  }

  getEvents(): AuditEvent[] {
    return [...this.events];
  }

  getEventsByActor(actor: string): AuditEvent[] {
    return this.events.filter((e) => e.actor === actor);
  }

  getEventsByType(eventType: string): AuditEvent[] {
    return this.events.filter((e) => e.eventType === eventType);
  }

  clear(): void {
    this.events = [];
  }
}
