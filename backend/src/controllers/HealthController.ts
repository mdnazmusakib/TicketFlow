import type { Request, Response } from 'express';
import { sendSuccess } from '../shared/http/apiResponse';
import type { HealthService } from '../services/HealthService';

/** HTTP adapter only: delegates to HealthService and maps the result to a status code. */
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  live = (_req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, this.healthService.liveness());
  };

  ready = async (_req: Request, res: Response): Promise<void> => {
    const report = await this.healthService.readiness();
    res.setHeader('Cache-Control', 'no-store');
    sendSuccess(res, report, report.status === 'ok' ? 200 : 503);
  };
}
