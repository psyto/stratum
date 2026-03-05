import { Router, Request, Response, NextFunction } from 'express';
import { apiRateLimit } from '../middleware/rate-limit';
import { instanceLookup } from '../middleware/instance-lookup';
import { decodeBase64 } from '../utils/validation';
import * as merkleService from '../services/merkle-service';

export const merkleRouter = Router();

merkleRouter.use('/v1/merkle', apiRateLimit, instanceLookup);

// POST /v1/merkle/build
merkleRouter.post('/v1/merkle/build', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leaves } = req.body;

    if (!Array.isArray(leaves) || leaves.length === 0) {
      res.status(400).json({ error: 'leaves must be a non-empty array of hex strings' });
      return;
    }

    const result = merkleService.buildTree(leaves);
    const rootHex = '0x' + Buffer.from(result.root).toString('hex');
    const rootBase64 = Buffer.from(result.root).toString('base64');

    res.status(200).json({
      root: rootHex,
      rootBase64,
      leafCount: result.leafCount,
      depth: result.depth,
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/merkle/proof
merkleRouter.post('/v1/merkle/proof', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { leaves, index } = req.body;

    if (!Array.isArray(leaves) || leaves.length === 0) {
      res.status(400).json({ error: 'leaves must be a non-empty array of hex strings' });
      return;
    }

    if (typeof index !== 'number' || index < 0 || index >= leaves.length) {
      res.status(400).json({ error: 'index must be a valid leaf index' });
      return;
    }

    const result = merkleService.getProof(leaves, index);
    const proof = result.proof.map((p) => Buffer.from(p).toString('base64'));

    res.status(200).json({ proof });
  } catch (err) {
    next(err);
  }
});

// POST /v1/merkle/verify
merkleRouter.post('/v1/merkle/verify', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { proof, root, leaf, index } = req.body;

    if (!Array.isArray(proof)) {
      res.status(400).json({ error: 'proof must be an array of base64 strings' });
      return;
    }

    if (typeof root !== 'string' || typeof leaf !== 'string') {
      res.status(400).json({ error: 'root and leaf must be base64 strings' });
      return;
    }

    if (typeof index !== 'number' || index < 0) {
      res.status(400).json({ error: 'index must be a non-negative number' });
      return;
    }

    const proofBuffers = proof.map((p: string) => decodeBase64(p));
    const rootBuffer = decodeBase64(root);
    const leafBuffer = decodeBase64(leaf);

    const valid = merkleService.verifyProof(proofBuffers, rootBuffer, leafBuffer, index);

    res.status(200).json({ valid });
  } catch (err) {
    next(err);
  }
});

// POST /v1/merkle/hash
merkleRouter.post('/v1/merkle/hash', (req: Request, res: Response, next: NextFunction) => {
  try {
    const { data } = req.body;

    if (typeof data !== 'string') {
      res.status(400).json({ error: 'data must be a base64 string' });
      return;
    }

    const input = decodeBase64(data);
    const hash = merkleService.hashLeafData(input);

    res.status(200).json({
      hash: '0x' + Buffer.from(hash).toString('hex'),
      hashBase64: Buffer.from(hash).toString('base64'),
    });
  } catch (err) {
    next(err);
  }
});
