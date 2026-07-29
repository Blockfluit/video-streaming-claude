import { Controller, Get } from '@nestjs/common';

export interface HealthResponse {
  status: 'ok';
  service: 'api';
  uptimeSec: number;
}

@Controller()
export class AppController {
  /** Scaffolding smoke test: reachable at `/health`, and `/api/health` through the web proxy. */
  @Get('health')
  health(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      uptimeSec: Math.round(process.uptime()),
    };
  }
}
