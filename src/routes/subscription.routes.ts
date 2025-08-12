import { Router } from 'express';
import { body } from 'express-validator';
import { SubscriptionController } from '../controllers/subscription.controller.js';
import { authenticate } from '../middleware/auth.js';
import { handleValidationErrors } from '../middleware/validation.js';

const router = Router();
const subscriptionController = new SubscriptionController();

// Validation rules
const checkoutValidation = [
  body('priceId').optional().isString(),
];

// Routes
router.post(
  '/create-checkout-session',
  authenticate,
  checkoutValidation,
  handleValidationErrors,
  subscriptionController.createCheckoutSession.bind(subscriptionController)
);

router.post(
  '/create-portal-session',
  authenticate,
  subscriptionController.createPortalSession.bind(subscriptionController)
);

// Stripe webhook - no authentication needed
// Note: Raw body handling is done in index.ts before JSON parser
router.post(
  '/webhook',
  subscriptionController.handleWebhook.bind(subscriptionController)
);

export default router;