import { Router, type Request, type Response } from 'express';
import { verifyTenantControlSignature } from '../middleware/verifyTenantControlSignature';
import { collectStatus } from '../services/tenantControl/status';
import { setSendingState } from '../services/tenantControl/state';

/**
 * Tenant Control API v1 — called only by the central Tenant Console, never by
 * Harbor users. Mounted before the user JWT chain; the HMAC signature is the
 * credential.
 */
const router = Router();

router.use(verifyTenantControlSignature);

router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json(await collectStatus());
  } catch (err) {
    console.error('[tenant-control] status failed:', (err as Error)?.message);
    res.status(500).json({ success: false, message: 'Could not collect tenant status.' });
  }
});

router.put('/sending', async (req: Request, res: Response) => {
  const { enabled, reason, actor } = (req.body ?? {}) as { enabled?: unknown; reason?: unknown; actor?: unknown };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ success: false, message: '`enabled` must be a boolean.' });
    return;
  }
  try {
    const sending = await setSendingState({
      enabled,
      reason: typeof reason === 'string' ? reason : null,
      updatedBy: typeof actor === 'string' ? actor : null,
    });
    console.log(`[tenant-control] SMS sending ${enabled ? 'resumed' : 'paused'} by ${sending.updatedBy ?? 'console'}`);
    res.json({ sending });
  } catch (err) {
    console.error('[tenant-control] set sending failed:', (err as Error)?.message);
    res.status(500).json({
      success: false,
      message: 'Could not save the sending state. Is the TenantControl migration applied?',
    });
  }
});

export default router;
