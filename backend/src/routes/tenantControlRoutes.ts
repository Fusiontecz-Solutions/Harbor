import { Router, type Request, type Response } from 'express';
import { verifyTenantControlSignature } from '../middleware/verifyTenantControlSignature';
import { collectStatus } from '../services/tenantControl/status';
import { setQuotaConfig, setSendingState } from '../services/tenantControl/state';
import { computeLimitState, resetQuotaCache } from '../services/tenantControl/quota';
import { setPrepaidState } from '../services/tenantControl/prepaid';
import { BadRequest, collectBroadcasts, collectReps, collectUsage } from '../services/tenantControl/reports';

/**
 * Tenant Control API (v2, a superset of v1) — called only by the central
 * Tenant Console, never by Harbor users. Mounted before the user JWT chain;
 * the HMAC signature is the credential.
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

const report =
  (name: string, collect: (query: Record<string, unknown>) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      res.json(await collect(req.query as Record<string, unknown>));
    } catch (err) {
      if (err instanceof BadRequest) {
        res.status(400).json({ error: err.message });
        return;
      }
      console.error(`[tenant-control] ${name} failed:`, (err as Error)?.message);
      res.status(500).json({ error: `Could not collect ${name}.` });
    }
  };

router.get('/usage', report('usage', collectUsage));
router.get('/broadcasts', report('broadcasts', collectBroadcasts));
router.get('/reps', report('reps', collectReps));

router.put('/limit', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { limit, countBy = 'messages', scope = 'monthly', resetDay, actor } = body;
  if (!('limit' in body) || (limit !== null && (!Number.isInteger(limit) || (limit as number) < 0))) {
    res.status(400).json({ error: 'limit must be a non-negative integer or null' });
    return;
  }
  if (countBy !== 'messages' && countBy !== 'segments') {
    res.status(400).json({ error: 'countBy must be messages or segments' });
    return;
  }
  if (scope !== 'monthly' && scope !== 'daily' && scope !== 'total') {
    res.status(400).json({ error: 'scope must be monthly, daily or total' });
    return;
  }
  if (resetDay != null && (!Number.isInteger(resetDay) || (resetDay as number) < 1 || (resetDay as number) > 28)) {
    res.status(400).json({ error: 'resetDay must be an integer from 1 to 28' });
    return;
  }
  try {
    const config = await setQuotaConfig({
      limit: limit as number | null,
      countBy,
      scope,
      resetDay: (resetDay as number | null | undefined) ?? 1,
      updatedBy: typeof actor === 'string' ? actor : null,
    });
    resetQuotaCache();
    console.log(
      `[tenant-control] quota set to ${config.limit ?? 'none'} ${config.countBy} (${config.scope}) by ${typeof actor === 'string' ? actor : 'console'}`,
    );
    res.json({ limit: await computeLimitState(config) });
  } catch (err) {
    console.error('[tenant-control] set limit failed:', (err as Error)?.message);
    res.status(500).json({ error: 'Could not save the limit. Is the TenantControl quota migration applied?' });
  }
});

router.put('/prepaid', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const { balance, pricePerUnit, inboundPricePerUnit, currency, chargeBy, actor } = body;
  if (typeof balance !== 'number' || !Number.isFinite(balance) || balance < 0) {
    res.status(400).json({ error: 'balance must be a non-negative number' });
    return;
  }
  if (typeof pricePerUnit !== 'number' || !Number.isFinite(pricePerUnit) || pricePerUnit < 0) {
    res.status(400).json({ error: 'pricePerUnit must be a non-negative number' });
    return;
  }
  if (chargeBy !== undefined && chargeBy !== 'messages' && chargeBy !== 'segments') {
    res.status(400).json({ error: 'chargeBy must be messages or segments' });
    return;
  }
  if (
    inboundPricePerUnit !== undefined &&
    inboundPricePerUnit !== null &&
    (typeof inboundPricePerUnit !== 'number' || !Number.isFinite(inboundPricePerUnit) || inboundPricePerUnit < 0)
  ) {
    res.status(400).json({ error: 'inboundPricePerUnit must be a non-negative number or null' });
    return;
  }
  try {
    const prepaid = await setPrepaidState({
      balance,
      pricePerUnit,
      inboundPricePerUnit:
        inboundPricePerUnit === undefined
          ? undefined
          : inboundPricePerUnit === null
            ? null
            : inboundPricePerUnit,
      currency: typeof currency === 'string' ? currency : 'USD',
      chargeBy: chargeBy === 'segments' ? 'segments' : 'messages',
      updatedBy: typeof actor === 'string' ? actor : null,
    });
    console.log(
      `[tenant-control] prepaid set to ${prepaid.balance} ${prepaid.currency} @ ${prepaid.pricePerUnit} by ${typeof actor === 'string' ? actor : 'console'}`,
    );
    res.json({ prepaid });
  } catch (err) {
    console.error('[tenant-control] set prepaid failed:', (err as Error)?.message);
    res.status(500).json({ error: 'Could not save prepaid balance. Is the prepaid migration applied?' });
  }
});

export default router;
