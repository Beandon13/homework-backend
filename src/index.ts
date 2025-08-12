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
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

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
  res.json({ 
    message: 'sAIge Math Backend API',
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

// API root endpoint
app.get('/api', (_req: any, res) => {
  res.json({ 
    message: 'sAIge Math API',
    endpoints: {
      auth: '/api/auth',
      subscriptions: '/api/subscriptions',
      health: '/api/health',
      test: '/api/test'
    }
  });
});

// Health check endpoint
app.get('/api/health', (_req: any, res) => {
  console.log('✅ Health check route hit');
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV 
  });
});

// Test endpoint for debugging connection issues
app.post('/api/test', (req, res) => {
  console.log('🧪 Test endpoint hit!');
  console.log('Body:', req.body);
  res.json({ 
    message: 'Test successful',
    receivedBody: req.body,
    headers: req.headers
  });
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
  console.log(`🔒 CORS origin: ${process.env.FRONTEND_URL || 'http://localhost:5173'}`);
  console.log(`✅ Routes mounted:`);
  console.log(`   - GET  /`);
  console.log(`   - GET  /api`);
  console.log(`   - GET  /api/health`);
  console.log(`   - POST /api/test`);
  console.log(`   - *    /api/auth/*`);
  console.log(`   - *    /api/subscriptions/*`);
});