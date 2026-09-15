/**
 * Messaging contacts: listing, manual creation, spreadsheet import, and the
 * block / unblock controls.
 */
import type { Request, Response } from 'express';
import prisma from '../config/prismaClient';
import {
  createContact,
  importContacts,
  listContacts,
} from '../services/messaging/contact.service';
import { findClientByPhone, listClientRecipients } from '../services/messaging/clientRecipients.service';
import { normalizePhoneNumber } from '../services/messaging/phone';
import {
  blockContact,
  checkSuppression,
  unblockContact,
} from '../services/messaging/suppression.service';
import { emitConversationUpdate } from '../socket/messagingEvents';
import { cleanupUploadedTempFiles, readUploadedFile } from '../utils/readUploadedFile';

const actorId = (req: Request): string | null => req.user?.id ?? null;

class MessagingContactController {
  /** GET /messaging/contacts?page=&search=&status= */
  async list(req: Request, res: Response): Promise<void> {
    try {
      const status = req.query.status ? String(req.query.status).toUpperCase() : undefined;
      const result = await listContacts({
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 50,
        search: String(req.query.search ?? ''),
        status: status === 'BLOCKED' || status === 'ACTIVE' ? status : undefined,
      });

      res.json({
        success: true,
        data: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          hasMore: result.hasMore,
        },
      });
    } catch (err) {
      console.error('[messaging:contacts] list failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load contacts' });
    }
  }

  /** POST /messaging/contacts */
  async create(req: Request, res: Response): Promise<void> {
    try {
      const contact = await createContact({
        phoneNumber: String(req.body?.phoneNumber ?? ''),
        firstName: req.body?.firstName ?? null,
        lastName: req.body?.lastName ?? null,
        emailAddress: req.body?.emailAddress ?? null,
        company: req.body?.company ?? null,
        street: req.body?.street ?? null,
        city: req.body?.city ?? null,
        state: req.body?.state ?? null,
        zip: req.body?.zip ?? null,
        tags: Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [],
        ownerUserId: actorId(req),
        clientId: req.body?.clientId ?? null,
      });

      res.status(201).json({ success: true, data: contact });
    } catch (err) {
      console.error('[messaging:contacts] create failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to create contact' });
    }
  }

  /**
   * POST /messaging/contacts/import
   * Accepts .xlsx / .xls / .csv as multipart `file`, or `fileBase64` in JSON.
   */
  async import(req: Request, res: Response): Promise<void> {
    try {
      const upload = readUploadedFile(req);
      if (!upload) {
        res.status(400).json({
          success: false,
          message: 'Upload a spreadsheet in the "file" field (.xlsx, .xls or .csv)',
        });
        return;
      }

      const summary = await importContacts({
        buffer: upload.buffer,
        ownerUserId: actorId(req),
        defaultTags: Array.isArray(req.body?.tags)
          ? req.body.tags.map(String)
          : String(req.body?.tags ?? '')
              .split(',')
              .map((tag) => tag.trim())
              .filter(Boolean),
      });

      res.json({ success: true, data: summary });
    } catch (err) {
      console.error('[messaging:contacts] import failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Import failed' });
    } finally {
      cleanupUploadedTempFiles(req);
    }
  }

  /** PATCH /messaging/contacts/:id */
  async update(req: Request, res: Response): Promise<void> {
    try {
      const contact = await prisma.messagingContact.update({
        where: { id: String(req.params.id) },
        data: {
          ...(req.body?.firstName !== undefined ? { firstName: req.body.firstName } : {}),
          ...(req.body?.lastName !== undefined ? { lastName: req.body.lastName } : {}),
          ...(req.body?.emailAddress !== undefined ? { emailAddress: req.body.emailAddress } : {}),
          ...(req.body?.company !== undefined ? { company: req.body.company } : {}),
          ...(req.body?.city !== undefined ? { city: req.body.city } : {}),
          ...(req.body?.state !== undefined ? { state: req.body.state } : {}),
          ...(Array.isArray(req.body?.tags) ? { tags: req.body.tags.map(String) } : {}),
        },
      });

      res.json({ success: true, data: contact });
    } catch (err) {
      console.error('[messaging:contacts] update failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to update contact' });
    }
  }

  /**
   * POST /messaging/contacts/block
   * Keyed on phone number rather than contact id so a number can be blocked
   * straight from a conversation that has no contact record yet.
   */
  async block(req: Request, res: Response): Promise<void> {
    try {
      const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
      if (!phoneNumber) {
        res.status(400).json({ success: false, message: 'A valid phoneNumber is required' });
        return;
      }

      await blockContact(phoneNumber, actorId(req));

      // Reflect the block on any open thread so the composer disables at once.
      const conversations = await prisma.messagingConversation.findMany({
        where: { contactNumber: phoneNumber },
        select: { id: true },
      });
      for (const conversation of conversations) {
        emitConversationUpdate({ id: conversation.id, isBlocked: true });
      }

      res.json({ success: true, data: { phoneNumber, blocked: true } });
    } catch (err) {
      console.error('[messaging:contacts] block failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to block contact' });
    }
  }

  /** POST /messaging/contacts/unblock */
  async unblock(req: Request, res: Response): Promise<void> {
    try {
      const phoneNumber = normalizePhoneNumber(req.body?.phoneNumber);
      if (!phoneNumber) {
        res.status(400).json({ success: false, message: 'A valid phoneNumber is required' });
        return;
      }

      await unblockContact(phoneNumber);

      const conversations = await prisma.messagingConversation.findMany({
        where: { contactNumber: phoneNumber },
        select: { id: true },
      });
      for (const conversation of conversations) {
        emitConversationUpdate({ id: conversation.id, isBlocked: false });
      }

      res.json({ success: true, data: { phoneNumber, blocked: false } });
    } catch (err) {
      console.error('[messaging:contacts] unblock failed:', err);
      res.status(400).json({ success: false, message: (err as Error)?.message || 'Failed to unblock contact' });
    }
  }

  /**
   * GET /messaging/clients?search=&page=&excludeSuppressed=
   *
   * CRM clients as a messaging audience — used by the recipient picker in both
   * the broadcast wizard and the inbox's "message a client" flow, so merchants
   * already in Harbor never have to be re-entered as contacts.
   */
  async clients(req: Request, res: Response): Promise<void> {
    try {
      const result = await listClientRecipients({
        search: String(req.query.search ?? ''),
        page: Number(req.query.page) || 1,
        pageSize: Number(req.query.pageSize) || 50,
        excludeSuppressed: String(req.query.excludeSuppressed ?? '') === 'true',
      });

      res.json({
        success: true,
        data: result.items,
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          hasMore: result.hasMore,
        },
      });
    } catch (err) {
      console.error('[messaging:contacts] client list failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load clients' });
    }
  }

  /**
   * GET /messaging/contacts/profile?phoneNumber=
   *
   * The contact card shown beside a chat. Resolution order:
   *   1. a saved MessagingContact for the number
   *   2. the CRM client that owns the number
   *
   * Step 2 is what makes a chat started from the client picker show the
   * merchant's name, company, email and location straight away. Without it the
   * panel is blank until someone is separately imported into Contacts & DNC,
   * which is never obvious to the agent looking at it.
   *
   * Nothing is written here — a card is read-only, and persisting a contact for
   * a chat that may never be sent would recreate the empty-record problem.
   */
  async profile(req: Request, res: Response): Promise<void> {
    try {
      const phoneNumber = normalizePhoneNumber(req.query.phoneNumber);
      if (!phoneNumber) {
        res.status(400).json({ success: false, message: 'A valid phoneNumber is required' });
        return;
      }

      const saved = await prisma.messagingContact.findFirst({
        where: { phoneNumber },
        // Prefer a row owned by this user, then the most recently created.
        orderBy: [{ ownerUserId: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          phoneNumber: true,
          firstName: true,
          lastName: true,
          emailAddress: true,
          company: true,
          city: true,
          state: true,
          tags: true,
          status: true,
          clientId: true,
          createdAt: true,
        },
      });

      const client = await findClientByPhone(phoneNumber);

      if (!saved && !client) {
        res.json({ success: true, data: null });
        return;
      }

      if (!saved && client) {
        // Synthesize a card from the CRM record. `id` is null so the FE can
        // tell this is not an editable Contacts & DNC row.
        res.json({
          success: true,
          data: {
            id: null,
            phoneNumber,
            firstName: client.ownerFirstName || null,
            lastName: client.ownerLastName || null,
            emailAddress: client.businessEmail,
            company: client.businessName,
            city: client.businessCity,
            state: client.businessState,
            tags: ['crm-client'],
            status: 'ACTIVE',
            createdAt: null,
            source: 'crm-client',
            client: {
              id: client.id,
              clientNumber: client.clientId,
              businessName: client.businessName,
              status: client.status,
            },
          },
        });
        return;
      }

      // A saved contact wins, but fill any gaps from the CRM record — an
      // imported sheet often has only a number and a first name.
      res.json({
        success: true,
        data: {
          ...saved,
          firstName: saved!.firstName || client?.ownerFirstName || null,
          lastName: saved!.lastName || client?.ownerLastName || null,
          emailAddress: saved!.emailAddress || client?.businessEmail || null,
          company: saved!.company || client?.businessName || null,
          city: saved!.city || client?.businessCity || null,
          state: saved!.state || client?.businessState || null,
          source: 'contact',
          client: client
            ? {
                id: client.id,
                clientNumber: client.clientId,
                businessName: client.businessName,
                status: client.status,
              }
            : null,
        },
      });
    } catch (err) {
      console.error('[messaging:contacts] profile lookup failed:', err);
      res.status(500).json({ success: false, message: 'Failed to load contact profile' });
    }
  }

  /** GET /messaging/contacts/status?phoneNumber= — combined block + DNC verdict. */
  async status(req: Request, res: Response): Promise<void> {
    try {
      const phoneNumber = normalizePhoneNumber(req.query.phoneNumber);
      if (!phoneNumber) {
        res.status(400).json({ success: false, message: 'A valid phoneNumber is required' });
        return;
      }

      const verdict = await checkSuppression(phoneNumber);
      res.json({ success: true, data: { phoneNumber, ...verdict } });
    } catch (err) {
      console.error('[messaging:contacts] status failed:', err);
      res.status(500).json({ success: false, message: 'Failed to resolve contact status' });
    }
  }
}

export default new MessagingContactController();
