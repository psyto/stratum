import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { basicAuth } from '../middleware/basic-auth';
import { provisionRateLimit } from '../middleware/rate-limit';
import { getDatabase } from '../db/database';
import { Instance } from '../db/models';
import {
  QuickNodeProvisionRequest,
  QuickNodeUpdateRequest,
  QuickNodeDeprovisionRequest,
  QuickNodeDeactivateRequest,
} from '../types/quicknode';

export const provisionRouter = Router();

// All provision routes require basic auth and rate limiting
provisionRouter.use('/provision', provisionRateLimit, basicAuth);

// PROVISION — create a new instance
provisionRouter.post('/provision', (req: Request, res: Response) => {
  const body = req.body as QuickNodeProvisionRequest;
  const quicknodeId = body['quicknode-id'];
  const endpointId = body['endpoint-id'];
  const plan = body.plan;

  if (!quicknodeId || !plan) {
    res.status(400).json({ error: 'Missing required fields: quicknode-id, plan' });
    return;
  }

  const db = getDatabase();

  // Check if instance already exists
  const existing = db
    .prepare('SELECT * FROM instances WHERE quicknode_id = ?')
    .get(quicknodeId) as Instance | undefined;

  if (existing) {
    // Reactivate if previously deactivated
    if (existing.status !== 'active') {
      db.prepare(
        "UPDATE instances SET status = 'active', plan = ?, deactivated_at = NULL, updated_at = datetime('now') WHERE quicknode_id = ?"
      ).run(plan, quicknodeId);
    }

    res.status(200).json({
      status: 'success',
      'dashboard-url': `https://stratum.dev/dashboard/${existing.id}`,
      'access-url': `https://stratum.dev/api/${existing.id}`,
    });
    return;
  }

  const id = crypto.randomUUID();

  db.prepare(
    `INSERT INTO instances (id, quicknode_id, plan, endpoint_id, chain, network, wss_url, http_url, referers, contract_addresses, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`
  ).run(
    id,
    quicknodeId,
    plan,
    endpointId || null,
    body.chain || null,
    body.network || null,
    body['wss-url'] || null,
    body['http-url'] || null,
    JSON.stringify(body.referers || []),
    JSON.stringify(body['contract-addresses'] || [])
  );

  res.status(200).json({
    status: 'success',
    'dashboard-url': `https://stratum.dev/dashboard/${id}`,
    'access-url': `https://stratum.dev/api/${id}`,
  });
});

// UPDATE — update an existing instance
provisionRouter.put('/provision', (req: Request, res: Response) => {
  const body = req.body as QuickNodeUpdateRequest;
  const quicknodeId = body['quicknode-id'];

  if (!quicknodeId) {
    res.status(400).json({ error: 'Missing required field: quicknode-id' });
    return;
  }

  const db = getDatabase();
  const existing = db
    .prepare('SELECT * FROM instances WHERE quicknode_id = ?')
    .get(quicknodeId) as Instance | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  db.prepare(
    `UPDATE instances
     SET plan = ?, endpoint_id = ?, chain = ?, network = ?, wss_url = ?, http_url = ?,
         referers = ?, contract_addresses = ?, updated_at = datetime('now')
     WHERE quicknode_id = ?`
  ).run(
    body.plan || existing.plan,
    body['endpoint-id'] || existing.endpoint_id,
    body.chain || existing.chain,
    body.network || existing.network,
    body['wss-url'] || existing.wss_url,
    body['http-url'] || existing.http_url,
    JSON.stringify(body.referers || JSON.parse(existing.referers)),
    JSON.stringify(body['contract-addresses'] || JSON.parse(existing.contract_addresses)),
    quicknodeId
  );

  res.status(200).json({ status: 'success' });
});

// DEACTIVATE — soft-delete an instance
provisionRouter.delete('/provision/deactivate', (req: Request, res: Response) => {
  const body = req.body as QuickNodeDeactivateRequest;
  const quicknodeId = body['quicknode-id'];

  if (!quicknodeId) {
    res.status(400).json({ error: 'Missing required field: quicknode-id' });
    return;
  }

  const db = getDatabase();
  const existing = db
    .prepare('SELECT * FROM instances WHERE quicknode_id = ?')
    .get(quicknodeId) as Instance | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  db.prepare(
    "UPDATE instances SET status = 'deactivated', deactivated_at = datetime('now'), updated_at = datetime('now') WHERE quicknode_id = ?"
  ).run(quicknodeId);

  res.status(200).json({ status: 'success' });
});

// DEPROVISION — permanently delete an instance
provisionRouter.delete('/provision', (req: Request, res: Response) => {
  const body = req.body as QuickNodeDeprovisionRequest;
  const quicknodeId = body['quicknode-id'];

  if (!quicknodeId) {
    res.status(400).json({ error: 'Missing required field: quicknode-id' });
    return;
  }

  const db = getDatabase();
  const existing = db
    .prepare('SELECT * FROM instances WHERE quicknode_id = ?')
    .get(quicknodeId) as Instance | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Instance not found' });
    return;
  }

  db.prepare('DELETE FROM instances WHERE quicknode_id = ?').run(quicknodeId);

  res.status(200).json({ status: 'success' });
});
