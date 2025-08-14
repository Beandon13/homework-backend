import { Router } from 'express';
import { body } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { SubscriptionController } from '../controllers/subscription.controller.js';
import { authenticate } from '../middleware/auth.js';
import { handleValidationErrors } from '../middleware/validation.js';

const router = Router();
const subscriptionController = new SubscriptionController();

// Webhook-specific rate limiting to prevent abuse
const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 10, // Max 10 webhook requests per minute per IP
  message: 'Too many webhook requests',
  standardHeaders: true,
  legacyHeaders: false,
  // Log security events for rate limit violations
  handler: (req, res) => {
    console.error('🚨 SECURITY ALERT - Webhook rate limit exceeded:', {
      timestamp: new Date().toISOString(),
      type: 'SECURITY_ALERT',
      event: 'WEBHOOK_RATE_LIMIT_EXCEEDED',
      ip: req.ip || req.connection.remoteAddress,
      userAgent: req.headers['user-agent'],
      path: req.path
    });
    res.status(429).json({ error: 'Too many webhook requests' });
  }
});

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
// Apply rate limiting to prevent abuse
router.post(
  '/webhook',
  webhookLimiter,
  subscriptionController.handleWebhook.bind(subscriptionController)
);

export default router;