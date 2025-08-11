# Saige Backend API

Backend payment system for Saige Math SaaS using Stripe and Supabase.

## Setup Instructions

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Set up Supabase Database

1. Go to your Supabase project SQL Editor
2. Run the SQL commands from `supabase-schema.sql`
3. This creates the necessary tables and Row Level Security policies

### 3. Configure Environment Variables

1. Copy `.env.example` to `.env`
2. Add your actual API keys:
   - Supabase URL and keys from your project settings
   - Stripe secret key from your Stripe dashboard
   - Generate a secure JWT secret
   - Set your Stripe webhook secret (after configuring webhooks)

### 4. Configure Stripe Webhook

1. Install Stripe CLI: https://stripe.com/docs/stripe-cli
2. For local testing:
   ```bash
   stripe listen --forward-to localhost:3001/api/subscriptions/webhook
   ```
3. Copy the webhook signing secret to your `.env` file

4. For production, add webhook endpoint in Stripe Dashboard:
   - Endpoint URL: `https://your-domain.com/api/subscriptions/webhook`
   - Events to listen for:
     - `checkout.session.completed`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`
     - `invoice.payment_failed`

### 5. Run the Server

Development:
```bash
npm run dev
```

Production:
```bash
npm run build
npm start
```

## API Endpoints

### Authentication

- `POST /api/auth/signup` - Create new user account
- `POST /api/auth/login` - Login user
- `GET /api/auth/profile` - Get user profile (requires auth)

### Subscriptions

- `POST /api/subscriptions/create-checkout-session` - Create Stripe checkout session
- `POST /api/subscriptions/create-portal-session` - Create customer portal session
- `POST /api/subscriptions/webhook` - Stripe webhook endpoint

### Health Check

- `GET /api/health` - Server health status

## Security Features

- JWT authentication
- Password hashing with bcrypt
- Rate limiting on auth endpoints
- CORS protection
- Helmet.js security headers
- Input validation
- Row Level Security in Supabase

## Testing

Use Stripe test cards: https://stripe.com/docs/testing

Common test card: `4242 4242 4242 4242`

## Deployment

1. Set all environment variables on your hosting platform
2. Ensure Supabase database is accessible
3. Configure Stripe webhook for production URL
4. Enable HTTPS (required for Stripe webhooks)