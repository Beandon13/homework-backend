import { Router } from 'express';
import { body } from 'express-validator';
import rateLimit from 'express-rate-limit';
import { AuthController } from '../controllers/auth.controller.js';
import { authenticate } from '../middleware/auth.js';
import { handleValidationErrors } from '../middleware/validation.js';
import { LicenseService } from '../services/license.service.js';
import { supabase } from '../services/supabase.js';

const router = Router();
const authController = new AuthController();

// Rate limiters for security-sensitive endpoints
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per hour per IP
  message: 'Too many password reset requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('🚨 Password reset rate limit exceeded:', {
      ip: req.ip,
      email: req.body?.email,
      timestamp: new Date().toISOString()
    });
    res.status(429).json({ error: 'Too many password reset requests. Please try again later.' });
  }
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 attempts per hour per IP
  message: 'Too many password reset attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful resets
  handler: (req, res) => {
    console.warn('🚨 Password reset attempts rate limit exceeded:', {
      ip: req.ip,
      timestamp: new Date().toISOString()
    });
    res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
  }
});

const verifyEmailLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 requests per hour per IP
  message: 'Too many email verification attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Don't count successful verifications
});

const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per hour per IP
  message: 'Too many verification email requests. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('🚨 Resend verification rate limit exceeded:', {
      ip: req.ip,
      email: req.body?.email,
      timestamp: new Date().toISOString()
    });
    res.status(429).json({ error: 'Too many verification email requests. Please try again later.' });
  }
});

const validateLicenseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // 20 validation attempts per hour per IP
  message: 'Too many license validation attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Don't count successful validations
});

// Validation rules
const signupValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
];

const forgotPasswordValidation = [
  body('email').isEmail().normalizeEmail(),
];

const resetPasswordValidation = [
  body('token').notEmpty(),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

const verifyEmailValidation = [
  body('token').notEmpty(),
];

const resendVerificationValidation = [
  body('email').isEmail().normalizeEmail(),
];

const loginLicenseValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  body('device_id').notEmpty(),
  body('device_name').notEmpty(),
];

const validateLicenseValidation = [
  body('licenseKey').notEmpty().withMessage('License key is required'),
  body('deviceId').notEmpty().withMessage('Device ID is required'),
  body('deviceName').notEmpty().withMessage('Device name is required'),
];

// Routes
router.post('/signup', (req: any, _res: any, next: any) => {
  console.log('📨 Signup route hit:', {
    body: req.body,
    headers: req.headers,
    method: req.method,
    url: req.url
  });
  next();
}, signupValidation, handleValidationErrors, authController.signup);
router.post('/login', (req: any, _res: any, next: any) => {
  console.log('📨 Login route hit:', {
    body: req.body,
    headers: req.headers,
    method: req.method,
    url: req.url
  });
  next();
}, loginValidation, handleValidationErrors, authController.login);
router.get('/profile', authenticate, authController.getProfile);

// Password recovery routes (with rate limiting)
router.post('/forgot-password', forgotPasswordLimiter, forgotPasswordValidation, handleValidationErrors, authController.forgotPassword);
router.post('/reset-password', resetPasswordLimiter, resetPasswordValidation, handleValidationErrors, authController.resetPassword);

// Email verification routes (with rate limiting)
router.post('/verify-email', verifyEmailLimiter, verifyEmailValidation, handleValidationErrors, authController.verifyEmail);
router.post('/resend-verification', resendVerificationLimiter, resendVerificationValidation, handleValidationErrors, authController.resendVerification);

// License management routes
router.get('/license', authenticate, async (req, res) => {
  try {
    const licenseInfo = await LicenseService.validateLicense(req.user!.userId);
    return res.json(licenseInfo);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get license info' });
  }
});

router.post('/validate-license', validateLicenseLimiter, validateLicenseValidation, handleValidationErrors, authController.validateLicense);

router.post('/login-license', loginLicenseValidation, handleValidationErrors, authController.loginAndGetLicense);

router.get('/license-status', authenticate, async (req, res) => {
  try {
    // Get user with full license and subscription info
    const { data: user, error } = await supabase
      .from('users')
      .select(`
        id, email, subscription_status, license_key, license_type, 
        license_status, license_expires_at, subscription_current_period_end,
        subscription_id, max_devices
      `)
      .eq('id', req.user!.userId)
      .single();

    if (error || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get license status' });
  }
});

router.get('/license/devices', authenticate, async (req, res) => {
  try {
    const devices = await LicenseService.getActiveDevices(req.user!.userId);
    return res.json({ devices });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get active devices' });
  }
});

router.post('/license/deactivate', authenticate, body('machineId').optional(), async (req, res) => {
  try {
    const { machineId } = req.body;
    const success = await LicenseService.deactivateDevice(req.user!.userId, machineId);
    if (success) {
      return res.json({ message: 'Device deactivated successfully' });
    } else {
      return res.status(400).json({ error: 'Failed to deactivate device' });
    }
  } catch (error) {
    return res.status(500).json({ error: 'Failed to deactivate device' });
  }
});

export default router;