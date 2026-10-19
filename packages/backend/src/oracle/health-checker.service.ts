import { Injectable, Logger } from '@nestjs/common';

export interface HealthCheck {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  latency: number;
  timestamp: number;
  message?: string;
}

@Injectable()
export class HealthCheckerService {
  private readonly logger = new Logger(HealthCheckerService.name);
  private checks: Map<string, HealthCheck> = new Map();

  checkService(service: string): Promise<HealthCheck> {
    const start = Date.now();
    // Simulate health check
    const status =
      Math.random() > 0.1 ? ('healthy' as const) : ('degraded' as const);
    const latency = Date.now() - start;
    const check: HealthCheck = {
      service,
      status,
      latency,
      timestamp: Date.now(),
      message:
        status === 'healthy'
          ? 'Service is operational'
          : 'Service experiencing high latency',
    };
    this.checks.set(service, check);
    this.logger.log(`Health check for ${service}: ${status} (${latency}ms)`);
    return Promise.resolve(check);
  }

  getHealth(service: string): HealthCheck | null {
    return this.checks.get(service) || null;
  }

  getAllHealth(): HealthCheck[] {
    return Array.from(this.checks.values());
  }

  isSystemHealthy(): boolean {
    const all = this.getAllHealth();
    if (all.length === 0) return true;
    return all.every((c) => c.status !== 'unhealthy');
  }
}
