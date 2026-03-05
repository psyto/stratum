import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { requestId } from './middleware/request-id';
import { errorHandler } from './middleware/error-handler';
import { healthcheckRouter } from './routes/healthcheck';
import { provisionRouter } from './routes/provision';
import { merkleRouter } from './routes/merkle';
import { bitfieldRouter } from './routes/bitfield';

export function createApp(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(morgan('combined'));
  app.use(requestId);

  // Routes
  app.use(healthcheckRouter);
  app.use(provisionRouter);
  app.use(merkleRouter);
  app.use(bitfieldRouter);

  // Error handler (must be last)
  app.use(errorHandler);

  return app;
}
