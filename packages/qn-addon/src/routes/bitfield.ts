import { Router, Request, Response, NextFunction } from 'express';
import { apiRateLimit } from '../middleware/rate-limit';
import { instanceLookup } from '../middleware/instance-lookup';
import { decodeBase64 } from '../utils/validation';
import * as bitfieldService from '../services/bitfield-service';

export const bitfieldRouter = Router();

bitfieldRouter.use('/v1/bitfield', apiRateLimit, instanceLookup);

// POST /v1/bitfield/create
bitfieldRouter.post('/v1/bitfield/create', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { capacity } = req.body;

    if (typeof capacity !== 'number' || capacity <= 0 || !Number.isInteger(capacity)) {
      res.status(400).json({ error: 'capacity must be a positive integer' });
      return;
    }

    const bytes = bitfieldService.create(capacity);

    res.status(200).json({
      bytes: Buffer.from(bytes).toString('base64'),
      capacity,
      setCount: 0,
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/bitfield/set
bitfieldRouter.post('/v1/bitfield/set', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bytes, index } = req.body;

    if (typeof bytes !== 'string') {
      res.status(400).json({ error: 'bytes must be a base64 string' });
      return;
    }

    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      res.status(400).json({ error: 'index must be a non-negative integer' });
      return;
    }

    const inputBytes = decodeBase64(bytes);
    const result = bitfieldService.set(inputBytes, index);

    res.status(200).json({
      bytes: Buffer.from(result.bytes).toString('base64'),
      wasNewlySet: result.wasNewlySet,
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/bitfield/check
bitfieldRouter.post('/v1/bitfield/check', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bytes, index } = req.body;

    if (typeof bytes !== 'string') {
      res.status(400).json({ error: 'bytes must be a base64 string' });
      return;
    }

    if (typeof index !== 'number' || index < 0 || !Number.isInteger(index)) {
      res.status(400).json({ error: 'index must be a non-negative integer' });
      return;
    }

    const inputBytes = decodeBase64(bytes);
    const isSet = bitfieldService.check(inputBytes, index);

    res.status(200).json({ isSet });
  } catch (err) {
    next(err);
  }
});

// POST /v1/bitfield/stats
bitfieldRouter.post('/v1/bitfield/stats', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { bytes } = req.body;

    if (typeof bytes !== 'string') {
      res.status(400).json({ error: 'bytes must be a base64 string' });
      return;
    }

    const inputBytes = decodeBase64(bytes);
    const result = bitfieldService.stats(inputBytes);

    res.status(200).json(result);
  } catch (err) {
    next(err);
  }
});
