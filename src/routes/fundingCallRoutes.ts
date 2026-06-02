import express from 'express';
import fundingCallController from '../controllers/fundingCallController';
import { authenticateToken } from '../middleware/authMiddleware';
import { forbidRoles } from '../middleware/forbidRoles';

const router = express.Router();

router.use(authenticateToken, forbidRoles('AGENT'));

router.post('/', fundingCallController.create.bind(fundingCallController));
router.get('/', fundingCallController.getByApplication.bind(fundingCallController));

export default router;

