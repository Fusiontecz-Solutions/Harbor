/**
 * Admin surface for the sender registry.
 *
 * Senders are the numbers messages go out from. An admin curates the list and
 * assigns one per user; anyone unassigned falls back to INFOBIP_SENDER, so
 * this can be rolled out without interrupting existing users.
 *
 * Every route here is admin-only: assigning a sender also decides which
 * conversations a user can see, so it is an access-control change, not a
 * cosmetic preference.
 */
import type { Request, Response } from 'express';
import {
  assignSenderToUser,
  deleteSender,
  isPrivilegedMessagingRole,
  listSenders,
  listUsersWithSenders,
  upsertSender,
} from '../services/messaging/sender.service';

function requireAdmin(req: Request, res: Response): boolean {
  if (isPrivilegedMessagingRole(req.user?.role)) return true;
  res.status(403).json({ success: false, message: 'Forbidden: admins only' });
  return false;
}

class MessagingSenderController {
  /** GET /messaging/senders */
  async list(req: Request, res: Response): Promise<void> {
    try {
      if (!requireAdmin(req, res)) return;
      res.json({ success: true, data: await listSenders() });
    } catch (err) {
      console.error('[messaging:senders] list failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to load senders' });
    }
  }

  /** POST /messaging/senders */
  async create(req: Request, res: Response): Promise<void> {
    try {
      if (!requireAdmin(req, res)) return;
      const sender = await upsertSender({
        phoneNumber: String(req.body?.phoneNumber ?? ''),
        label: req.body?.label ?? null,
        isActive: req.body?.isActive ?? true,
      });
      res.status(201).json({ success: true, data: sender });
    } catch (err) {
      console.error('[messaging:senders] create failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to save sender' });
    }
  }

  /** PATCH /messaging/senders/:id */
  async update(req: Request, res: Response): Promise<void> {
    try {
      if (!requireAdmin(req, res)) return;
      const sender = await upsertSender({
        id: String(req.params.id),
        phoneNumber: String(req.body?.phoneNumber ?? ''),
        label: req.body?.label ?? null,
        isActive: req.body?.isActive ?? true,
      });
      res.json({ success: true, data: sender });
    } catch (err) {
      console.error('[messaging:senders] update failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to update sender' });
    }
  }

  /** DELETE /messaging/senders/:id */
  async remove(req: Request, res: Response): Promise<void> {
    try {
      if (!requireAdmin(req, res)) return;
      await deleteSender(String(req.params.id));
      // Assigned users fall back to the env default via ON DELETE SET NULL.
      res.json({ success: true, data: { id: String(req.params.id) } });
    } catch (err) {
      console.error('[messaging:senders] delete failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to delete sender' });
    }
  }

  /** GET /messaging/senders/assignments — users and the sender each one uses. */
  async assignments(req: Request, res: Response): Promise<void> {
    try {
      if (!requireAdmin(req, res)) return;
      res.json({ success: true, data: await listUsersWithSenders() });
    } catch (err) {
      console.error('[messaging:senders] assignments failed:', err);
      res.status(500).json({ success: false, message: (err as Error)?.message || 'Failed to load assignments' });
    }
  }

  /** PATCH /messaging/senders/assignments/:userId — body { senderId: string | null } */
  async assign(req: Request, res: Response): Promise<void> {
    try {
      if (!requireAdmin(req, res)) return;
      const raw = req.body?.senderId;
      const senderId = raw === null || raw === '' || raw === undefined ? null : String(raw);
      const user = await assignSenderToUser(String(req.params.userId), senderId);
      res.json({ success: true, data: user });
    } catch (err) {
      console.error('[messaging:senders] assign failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to assign sender' });
    }
  }
}

export default new MessagingSenderController();
