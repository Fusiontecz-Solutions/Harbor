import { Router } from 'express';
import { sendPaymentMail } from '../controllers/mail.controller';
import { authenticateToken } from '../middleware/authMiddleware';

const router = Router();

router.post('/send', authenticateToken, sendPaymentMail);

export default router;
