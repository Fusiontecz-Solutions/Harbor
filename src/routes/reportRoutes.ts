import express, { type Request, type Response } from 'express';
import { authenticateToken } from '../middleware/authMiddleware';
import { isPrivilegedMessagingRole } from '../services/messaging/sender.service';
import {
  buildReportSummary,
  buildReportWorkbook,
  parseReportRange,
  parseSections,
} from '../services/reports/harborReport.service';

const router = express.Router();
router.use(authenticateToken);

/** Reports span every user's leads and conversations, so they are admin-only. */
function ensureAdmin(req: Request, res: Response): boolean {
  if (isPrivilegedMessagingRole(req.user?.role)) return true;
  res.status(403).json({ success: false, message: 'Forbidden: reports are available to admins only' });
  return false;
}

function fail(res: Response, err: unknown, what: string): void {
  const status = Number((err as { statusCode?: number })?.statusCode) || 500;
  if (status >= 500) console.error(`[reports] ${what} failed:`, err);
  res.status(status).json({ success: false, message: (err as Error)?.message || `Failed to ${what}` });
}

/** GET /reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD */
router.get('/summary', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const range = parseReportRange(req.query.from, req.query.to);
    res.json({ success: true, data: await buildReportSummary(range) });
  } catch (err) {
    fail(res, err, 'load report');
  }
});

/** GET /reports/export?from=&to=&sections=broadcasts,inbox,agents,applications → .xlsx */
router.get('/export', async (req: Request, res: Response) => {
  if (!ensureAdmin(req, res)) return;
  try {
    const range = parseReportRange(req.query.from, req.query.to);
    const sections = parseSections(req.query.sections);
    const buffer = await buildReportWorkbook(range, sections);
    const lastDay = new Date(range.to.getTime() - 86_400_000).toISOString().slice(0, 10);
    const filename = `harbor-report-${range.from.toISOString().slice(0, 10)}-to-${lastDay}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
    res.send(buffer);
  } catch (err) {
    fail(res, err, 'export report');
  }
});

export default router;
