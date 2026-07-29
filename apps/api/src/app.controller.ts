import { Controller, Get } from '@nestjs/common';

import { Public } from './auth/decorators';

export interface HealthResponse {
  status: 'ok';
  service: 'api';
  uptimeSec: number;
}

@Controller()
export class AppController {
  /**
   * Reachable at `/health`, and `/api/health` through the web proxy.
   * Public so a liveness probe doesn't need credentials.
   */
  @Public()
  @Get('health')
  health(): HealthResponse {
    return {
      status: 'ok',
      service: 'api',
      uptimeSec: Math.round(process.uptime()),
    };
  }
}
