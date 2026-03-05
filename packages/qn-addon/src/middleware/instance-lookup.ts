import { Request, Response, NextFunction } from 'express';
import { getDatabase } from '../db/database';
import { Instance } from '../db/models';

export function instanceLookup(req: Request, res: Response, next: NextFunction): void {
  const quicknodeId = req.headers['x-quicknode-id'] as string;

  if (!quicknodeId) {
    res.status(401).json({ error: 'Missing x-quicknode-id header' });
    return;
  }

  const db = getDatabase();
  const instance = db
    .prepare('SELECT * FROM instances WHERE quicknode_id = ? AND status = ?')
    .get(quicknodeId, 'active') as Instance | undefined;

  if (!instance) {
    res.status(404).json({ error: 'Instance not found or inactive' });
    return;
  }

  (req as any).instance = instance;
  next();
}
