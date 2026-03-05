import { Router, Request, Response } from 'express';

export const healthcheckRouter = Router();

healthcheckRouter.get('/healthcheck', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'stratum-data-optimizer',
    timestamp: new Date().toISOString(),
  });
});
