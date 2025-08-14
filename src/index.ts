import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';

import authRoutes from './routes/auth.routes.js';
import subscriptionRoutes from './routes/subscription.routes.js';

// Load environment variables
dotenv.config();

// Create Express app
const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy (for deployment behind reverse proxy)
app.set('trust proxy', 1);

// Security middleware
app.use(helmet());

// CORS configuration
const isDevelopment = process.env.NODE_ENV === 'development';

// Parse allowed origins from environment variable
const getAllowedOrigins = (): string[] | boolean => {
  if (isDevelopment) {
    // In development, allow localhost ports and Electron apps
    return ['file://', 'http://localhost:5173', 'http://localhost:3000', 'http://localhost:5174'];
  }
  
  // In production, use strict origin list from environment variable
  const allowedOrigins = process.env.ALLOWED_ORIGINS;
  if (!allowedOrigins) {
    console.warn('⚠️  ALLOWED_ORIGINS not set in production! Using restrictive defaults.');
    // Default to only allowing Electron apps (file://) if not configured
    return ['file://'];
  }
  
  // Parse comma-separated origins and always include file:// for Electron apps
  const origins = allowedOrigins.split(',').map(origin => origin.trim()).filter(Boolean);
  
  // Always include file:// to support Electron/desktop apps
  if (!origins.includes('file://')) {
    origins.unshift('file://');
  }
  
  return origins;
};

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = getAllowedOrigins();
    
    // Allow requests with no origin (e.g., mobile apps, Postman, server-to-server)
    // Only in development or if explicitly allowed
    if (!origin) {
      if (isDevelopment || process.env.ALLOW_NO_ORIGIN === 'true') {
        return callback(null, true);
      }
      return callback(new Error('No origin header present'));
    }
    
    // If allowedOrigins is boolean true (shouldn't happen with our config)
    if (allowedOrigins === true) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`🚫 CORS blocked origin: ${origin}`);
      console.warn(`   Allowed origins: ${JSON.stringify(allowedOrigins)}`);
      callback(new Error(`Origin ${origin} not allowed by CORS policy`));
    }
  },
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'Accept',
    'Origin',
    'X-CSRF-Token',
    'stripe-signature' // For Stripe webhooks
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  maxAge: 86400, // 24 hours
  optionsSuccessStatus: 200 // Some legacy browsers choke on 204
};

app.use(cors(corsOptions));

// Special handling for Stripe webhooks (raw body needed) - MUST come before express.json()
// This middleware ensures the body is kept raw for Stripe signature verification
// Support both singular and plural routes for backward compatibility
// Use type: '*/*' to handle all content types that Stripe might send
app.use('/api/subscriptions/webhook', express.raw({ type: '*/*' }));
app.use('/api/subscription/webhook', express.raw({ type: '*/*' }));

// Request logging middleware - AFTER raw body setup to avoid interference
app.use((req, _res: any, next) => {
  // Don't log body for webhook routes to avoid Buffer issues
  const isWebhook = req.url.includes('/webhook');
  console.log(`\n🌐 Incoming request: ${req.method} ${req.url}`);
  console.log('Headers:', req.headers);
  if (!isWebhook && req.body) {
    console.log('Body preview:', JSON.stringify(req.body).substring(0, 200));
  }
  next();
});

// Body parsing middleware - IMPORTANT: Must come AFTER webhook raw body handler
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.',
});

// Apply rate limiting to all routes
app.use('/api/', limiter);

// Stricter rate limiting for auth routes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit each IP to 5 requests per windowMs
  skipSuccessfulRequests: true,
});

app.use('/api/auth/signup', authLimiter);
app.use('/api/auth/login', authLimiter);

// Root endpoint - IMPORTANT: Add this for basic connectivity check
app.get('/', (_req: any, res) => {
  // In production, return minimal info for security
  if (process.env.NODE_ENV === 'production') {
    res.json({ 
      message: 'sAIge Math API',
      status: 'running'
    });
  } else {
    // In development, return more detailed info
    res.json({ 
      message: 'sAIge Math Backend API',
      status: 'running',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV
    });
  }
});

// API root endpoint
app.get('/api', (_req: any, res) => {
  // In production, return minimal info for security
  if (process.env.NODE_ENV === 'production') {
    res.json({ 
      message: 'sAIge Math API',
      status: 'ok'
    });
  } else {
    // In development, return endpoint list for debugging
    res.json({ 
      message: 'sAIge Math API',
      endpoints: {
        auth: '/api/auth',
        subscriptions: '/api/subscriptions',
        health: '/api/health'
      }
    });
  }
});

// Health check endpoint
app.get('/api/health', (_req: any, res) => {
  // In production, return minimal info for security
  if (process.env.NODE_ENV === 'production') {
    res.json({ status: 'ok' });
  } else {
    // In development, return more info for debugging
    console.log('✅ Health check route hit');
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV 
    });
  }
});


// Mount route modules - with logging
console.log('📂 Mounting auth routes at /api/auth');
app.use('/api/auth', authRoutes);
console.log('📂 Mounting subscription routes at /api/subscriptions');
app.use('/api/subscriptions', subscriptionRoutes);
// Also mount at singular path for backward compatibility with Stripe webhook
console.log('📂 Mounting subscription routes at /api/subscription (alias)');
app.use('/api/subscription', subscriptionRoutes);

// Error handling middleware
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction): any => {
  console.error('Error:', err);
  
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler
app.use((_req: any, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV}`);
  
  // Log CORS configuration
  const allowedOrigins = getAllowedOrigins();
  if (isDevelopment) {
    console.log(`🔒 CORS (dev mode): Allowing localhost origins`);
    console.log(`   Allowed: ${JSON.stringify(allowedOrigins)}`);
  } else {
    console.log(`🔒 CORS (production): Strict origin checking enabled`);
    if (Array.isArray(allowedOrigins)) {
      console.log(`   Allowed origins: ${JSON.stringify(allowedOrigins)}`);
    }
    if (process.env.ALLOW_NO_ORIGIN === 'true') {
      console.log(`   ⚠️  Warning: Allowing requests with no origin header`);
    }
  }
  
  console.log(`✅ Routes mounted:`);
  console.log(`   - GET  /`);
  console.log(`   - GET  /api`);
  console.log(`   - GET  /api/health`);
  console.log(`   - *    /api/auth/*`);
  console.log(`   - *    /api/subscriptions/*`);
});// Deploy to Railway 
