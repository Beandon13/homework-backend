import { Request, Response } from 'express';
import { supabase } from '../services/supabase.js';
import { stripe } from '../services/stripe.js';
import { LicenseService } from '../services/license.service.js';
import Stripe from 'stripe';

export class SubscriptionController {
  async createCheckoutSession(req: Request, res: Response): Promise<Response | void> {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { priceId } = req.body;

      // Get user with stripe customer id
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('stripe_customer_id, subscription_status')
        .eq('id', req.user.userId)
        .single();

      if (userError || !user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Check if user already has an active subscription
      if (user.subscription_status === 'active') {
        return res.status(400).json({ error: 'User already has an active subscription' });
      }

      // Create checkout session with 3-day free trial
      const session = await stripe.checkout.sessions.create({
        customer: user.stripe_customer_id,
        payment_method_types: ['card'],
        line_items: [
          {
            price: priceId || process.env.STRIPE_PRICE_ID,
            quantity: 1,
          },
        ],
        mode: 'subscription',
        success_url: `${process.env.FRONTEND_URL}/dashboard?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.FRONTEND_URL}/pricing`,
        subscription_data: {
          trial_period_days: 3, // 3-day free trial
        },
        metadata: {
          userId: req.user.userId,
        },
      });

      return res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
      console.error('Create checkout session error:', error);
      return res.status(500).json({ error: 'Failed to create checkout session' });
    }
  }

  async createPortalSession(req: Request, res: Response): Promise<Response | void> {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      // Get user with stripe customer id
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('stripe_customer_id')
        .eq('id', req.user.userId)
        .single();

      if (userError || !user || !user.stripe_customer_id) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Create portal session
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${process.env.FRONTEND_URL}/dashboard`,
      });

      return res.json({ url: portalSession.url });
    } catch (error) {
      console.error('Create portal session error:', error);
      return res.status(500).json({ error: 'Failed to create portal session' });
    }
  }

  async handleWebhook(req: Request, res: Response): Promise<Response | void> {
    // Wrap entire handler in try-catch to prevent server crashes
    try {
      const sig = req.headers['stripe-signature'] as string;
      let event: Stripe.Event;

      // Log webhook received - handle Buffer body safely
      console.log('🔔 Webhook received:', {
        path: req.originalUrl,
        signature: sig ? 'present' : 'missing',
        bodyType: Buffer.isBuffer(req.body) ? 'Buffer' : typeof req.body,
        bodyLength: Buffer.isBuffer(req.body) ? req.body.length : JSON.stringify(req.body).length
      });

      // Check if webhook secret is configured
      if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.error('❌ STRIPE_WEBHOOK_SECRET not configured');
        return res.status(500).json({ error: 'Webhook secret not configured' });
      }

      // Check if body is Buffer (required for Stripe signature verification)
      if (!Buffer.isBuffer(req.body)) {
        console.error('❌ Webhook body is not a Buffer. Got:', typeof req.body);
        return res.status(400).json({ error: 'Invalid webhook body format' });
      }

      // Verify webhook signature
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          process.env.STRIPE_WEBHOOK_SECRET
        );
        console.log('✅ Webhook signature verified for event:', event.type);
      } catch (err) {
        console.error('❌ Webhook signature verification failed:', err);
        return res.status(400).send(`Webhook Error: ${err}`);
      }

      // Process the webhook event
      console.log(`📥 Processing webhook event: ${event.type}`);
      
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object as Stripe.Checkout.Session;
          console.log('💳 Checkout session completed:', session.id);
          await this.handleCheckoutComplete(session);
          break;
        }

        case 'customer.subscription.created': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log('🆕 New subscription created:', subscription.id);
          await this.handleSubscriptionCreated(subscription);
          break;
        }

        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log('🔄 Subscription updated:', subscription.id);
          await this.handleSubscriptionUpdate(subscription);
          break;
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription;
          console.log('🗑️ Subscription deleted:', subscription.id);
          await this.handleSubscriptionDeleted(subscription);
          break;
        }

        case 'invoice.payment_succeeded': {
          const invoice = event.data.object as Stripe.Invoice;
          console.log('💰 Payment succeeded for invoice:', invoice.id);
          await this.handlePaymentSucceeded(invoice);
          break;
        }

        case 'invoice.payment_failed': {
          const invoice = event.data.object as Stripe.Invoice;
          console.log('❌ Payment failed for invoice:', invoice.id);
          await this.handlePaymentFailed(invoice);
          break;
        }

        default:
          console.log(`⚠️ Unhandled event type: ${event.type}`);
      }

      console.log(`✅ Successfully processed webhook event: ${event.type}`);
      return res.json({ received: true });
    } catch (error) {
      // Catch any error to prevent server crash
      console.error('❌ Webhook handler critical error:', error);
      console.error('Stack trace:', error instanceof Error ? error.stack : 'No stack trace');
      // Always return a response to prevent hanging
      return res.status(500).json({ error: 'Webhook handler failed', message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  private async handleCheckoutComplete(session: Stripe.Checkout.Session) {
    const userId = session.metadata?.userId;
    if (!userId) return;

    const subscription = await stripe.subscriptions.retrieve(session.subscription as string);
    const customerId = subscription.customer as string;

    // Determine license type based on price
    const priceId = subscription.items.data[0].price.id;
    let licenseType = 'standard';
    
    // Map price IDs to license types (you can customize this)
    if (priceId === process.env.STRIPE_PREMIUM_PRICE_ID) {
      licenseType = 'premium';
    } else if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) {
      licenseType = 'enterprise';
    }

    // Generate license key for the user with Stripe IDs
    const licenseKey = await LicenseService.generateLicenseKey(
      userId, 
      licenseType,
      customerId,
      subscription.id
    );

    // Update user subscription status to 'active'
    await supabase
      .from('users')
      .update({
        subscription_status: 'active',
        subscription_id: subscription.id,
        subscription_current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      })
      .eq('id', userId);

    // Add to subscription history
    await supabase
      .from('subscription_history')
      .insert({
        user_id: userId,
        stripe_subscription_id: subscription.id,
        status: 'active',
        price_id: subscription.items.data[0].price.id,
        current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : new Date().toISOString(),
        current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      });

    console.log(`Generated license key ${licenseKey} for user ${userId}`);
  }

  private async handleSubscriptionCreated(subscription: Stripe.Subscription) {
    console.log('Processing new subscription creation...');
    
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('stripe_customer_id', subscription.customer as string)
      .single();

    if (!user) {
      console.error('User not found for customer:', subscription.customer);
      return;
    }

    const status = this.mapStripeStatus(subscription.status);
    
    // Determine license type based on price
    const priceId = subscription.items.data[0].price.id;
    let licenseType = 'standard';
    
    if (priceId === process.env.STRIPE_PREMIUM_PRICE_ID) {
      licenseType = 'premium';
    } else if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) {
      licenseType = 'enterprise';
    }

    // Generate license key for new subscription with Stripe IDs
    try {
      const licenseKey = await LicenseService.generateLicenseKey(
        user.id, 
        licenseType,
        subscription.customer as string,
        subscription.id
      );
      console.log(`✅ Generated license key for new subscription: ${licenseKey}`);
    } catch (error) {
      console.error('Failed to generate license key:', error);
    }

    // Update subscription status to 'active' if subscription is active
    await supabase
      .from('users')
      .update({
        subscription_status: status === 'active' ? 'active' : status,
        subscription_id: subscription.id,
        subscription_current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      })
      .eq('id', user.id);

    // Add to subscription history
    await supabase
      .from('subscription_history')
      .insert({
        user_id: user.id,
        stripe_subscription_id: subscription.id,
        status: status,
        price_id: subscription.items.data[0].price.id,
        current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : new Date().toISOString(),
        current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      });

    console.log(`✅ Subscription created and license generated for user ${user.id}`);
  }

  private async handlePaymentSucceeded(invoice: Stripe.Invoice) {
    console.log('Processing successful payment...');
    
    const { data: user } = await supabase
      .from('users')
      .select('id, license_key')
      .eq('stripe_customer_id', invoice.customer as string)
      .single();

    if (!user) {
      console.error('User not found for customer:', invoice.customer);
      return;
    }

    // If user doesn't have a license key yet, generate one
    if (!user.license_key && invoice.subscription) {
      try {
        const subscription = await stripe.subscriptions.retrieve(invoice.subscription as string);
        const priceId = subscription.items.data[0].price.id;
        let licenseType = 'standard';
        
        if (priceId === process.env.STRIPE_PREMIUM_PRICE_ID) {
          licenseType = 'premium';
        } else if (priceId === process.env.STRIPE_ENTERPRISE_PRICE_ID) {
          licenseType = 'enterprise';
        }

        const licenseKey = await LicenseService.generateLicenseKey(
          user.id, 
          licenseType,
          invoice.customer as string,
          invoice.subscription as string
        );
        console.log(`✅ Generated license key after payment success: ${licenseKey}`);
      } catch (error) {
        console.error('Failed to generate license key after payment:', error);
      }
    }

    // Update subscription status to active
    await supabase
      .from('users')
      .update({
        subscription_status: 'active',
      })
      .eq('id', user.id);

    console.log(`✅ Payment succeeded and license activated for user ${user.id}`);
  }

  private async handleSubscriptionUpdate(subscription: Stripe.Subscription) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('stripe_customer_id', subscription.customer as string)
      .single();

    if (!user) return;

    const status = this.mapStripeStatus(subscription.status);

    await supabase
      .from('users')
      .update({
        subscription_status: status,
        subscription_current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      })
      .eq('id', user.id);

    // Add to subscription history
    await supabase
      .from('subscription_history')
      .insert({
        user_id: user.id,
        stripe_subscription_id: subscription.id,
        status: status,
        price_id: subscription.items.data[0].price.id,
        current_period_start: subscription.current_period_start ? new Date(subscription.current_period_start * 1000).toISOString() : new Date().toISOString(),
        current_period_end: subscription.current_period_end ? new Date(subscription.current_period_end * 1000).toISOString() : null,
      });
  }

  private async handleSubscriptionDeleted(subscription: Stripe.Subscription) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('stripe_customer_id', subscription.customer as string)
      .single();

    if (!user) return;

    await supabase
      .from('users')
      .update({
        subscription_status: 'canceled',
        subscription_current_period_end: null,
      })
      .eq('id', user.id);

    // Add to subscription history
    await supabase
      .from('subscription_history')
      .insert({
        user_id: user.id,
        stripe_subscription_id: subscription.id,
        status: 'canceled',
      });
  }

  private async handlePaymentFailed(invoice: Stripe.Invoice) {
    const { data: user } = await supabase
      .from('users')
      .select('id')
      .eq('stripe_customer_id', invoice.customer as string)
      .single();

    if (!user) return;

    await supabase
      .from('users')
      .update({
        subscription_status: 'past_due',
      })
      .eq('id', user.id);
  }

  private mapStripeStatus(stripeStatus: Stripe.Subscription.Status): 'active' | 'canceled' | 'past_due' {
    switch (stripeStatus) {
      case 'active':
        return 'active';
      case 'canceled':
        return 'canceled';
      case 'past_due':
        return 'past_due';
      default:
        return 'canceled';
    }
  }
}