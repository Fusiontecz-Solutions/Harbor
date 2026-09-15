import express from 'express';
import messagingController from '../controllers/messagingController';
import messagingBroadcastController from '../controllers/messagingBroadcastController';
import messagingContactController from '../controllers/messagingContactController';
import messagingDncController from '../controllers/messagingDncController';
import messagingVoiceController from '../controllers/messagingVoiceController';
import messagingWebhookController from '../controllers/messagingWebhookController';
import { authenticateToken } from '../middleware/authMiddleware';

const router = express.Router();

/* ---------------------------------------------------------------------------
 * Provider callbacks — UNAUTHENTICATED by necessity (Infobip has no JWT).
 *
 * Mounted BEFORE `authenticateToken` so the auth middleware never sees them.
 * They authenticate with the INFOBIP_WEBHOOK_SECRET shared secret instead; see
 * messagingWebhookController.
 * -------------------------------------------------------------------------*/
router.post('/webhooks/infobip/inbound', messagingWebhookController.inbound.bind(messagingWebhookController));
router.post('/webhooks/infobip/delivery', messagingWebhookController.delivery.bind(messagingWebhookController));
router.post('/webhooks/infobip/calls', messagingWebhookController.calls.bind(messagingWebhookController));

/* Everything below requires a signed-in Harbor user. */
router.use(authenticateToken);

router.get('/config', messagingController.getConfig.bind(messagingController));

/* Inbox */
router.get('/conversations', messagingController.getConversations.bind(messagingController));
router.post('/conversations', messagingController.openConversation.bind(messagingController));
router.get('/conversations/:id/messages', messagingController.getMessages.bind(messagingController));
router.patch('/conversations/:id/read', messagingController.markRead.bind(messagingController));
router.patch('/conversations/:id/archive', messagingController.setArchived.bind(messagingController));
router.delete('/conversations/:id', messagingController.deleteConversation.bind(messagingController));
router.post('/send', messagingController.sendMessage.bind(messagingController));
router.get('/unread-count', messagingController.getUnreadCount.bind(messagingController));

/* Contacts + spreadsheet import + block controls.
 * `status` is declared before `:id` so it is not swallowed by the param route. */
router.get('/contacts', messagingContactController.list.bind(messagingContactController));
router.get('/contacts/status', messagingContactController.status.bind(messagingContactController));
router.get('/contacts/profile', messagingContactController.profile.bind(messagingContactController));
router.post('/contacts', messagingContactController.create.bind(messagingContactController));
router.post('/contacts/import', messagingContactController.import.bind(messagingContactController));
router.post('/contacts/block', messagingContactController.block.bind(messagingContactController));
router.post('/contacts/unblock', messagingContactController.unblock.bind(messagingContactController));
router.patch('/contacts/:id', messagingContactController.update.bind(messagingContactController));

/* CRM clients as a messaging audience (recipient picker). */
router.get('/clients', messagingContactController.clients.bind(messagingContactController));

/* Broadcasts */
router.get('/broadcasts', messagingBroadcastController.list.bind(messagingBroadcastController));
router.post('/broadcasts', messagingBroadcastController.create.bind(messagingBroadcastController));
router.get('/broadcasts/:id', messagingBroadcastController.stats.bind(messagingBroadcastController));
router.get('/broadcasts/:id/recipients', messagingBroadcastController.recipients.bind(messagingBroadcastController));
router.get(
  '/broadcasts/:id/error-breakdown',
  messagingBroadcastController.errorBreakdown.bind(messagingBroadcastController),
);
router.get('/broadcasts/:id/export', messagingBroadcastController.exportRecipients.bind(messagingBroadcastController));
router.post('/broadcasts/:id/start', messagingBroadcastController.start.bind(messagingBroadcastController));
router.post('/broadcasts/:id/pause', messagingBroadcastController.pause.bind(messagingBroadcastController));
router.post('/broadcasts/:id/cancel', messagingBroadcastController.cancel.bind(messagingBroadcastController));

/* Do Not Call */
router.get('/dnc/check', messagingDncController.check.bind(messagingDncController));
router.post('/dnc/check-bulk', messagingDncController.checkBulk.bind(messagingDncController));
router.get('/dnc/history', messagingDncController.history.bind(messagingDncController));

/* Voice */
router.post('/voice/token', messagingVoiceController.token.bind(messagingVoiceController));
router.post('/voice/call', messagingVoiceController.call.bind(messagingVoiceController));
router.post('/voice/log', messagingVoiceController.log.bind(messagingVoiceController));
router.get('/voice/history', messagingVoiceController.history.bind(messagingVoiceController));

export default router;
