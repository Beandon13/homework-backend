import { Request, Response } from 'express';
import { supabase } from '../services/supabase.js';
import { stripe } from '../services/stripe.js';
import { hashPassword, comparePassword, generateToken } from '../utils/auth.js';
import { CreateUserDTO, LoginDTO } from '../types/index.js';

export class AuthController {
  async forgotPassword(req: Request<{}, {}, { email: string }>, res: Response): Promise<Response> {
    console.log('🔐 Forgot password request for:', req.body.email);
    try {
      const { email } = req.body;
      
      // Use Supabase Auth to send password reset email
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${process.env.FRONTEND_URL}/reset-password`,
      });

      if (error) {
        console.error('Supabase password reset error:', error);
        // Don't reveal if user exists
        return res.json({ 
          message: 'If an account exists with this email, you will receive password reset instructions.' 
        });
      }

      return res.json({ 
        message: 'Password reset email sent successfully' 
      });
    } catch (error) {
      console.error('Forgot password error:', error);
      return res.status(500).json({ error: 'Failed to send password reset email' });
    }
  }

  async resetPassword(req: Request<{}, {}, { token: string; password: string }>, res: Response): Promise<Response> {
    console.log('🔐 Reset password request');
    try {
      const { password } = req.body;

      // Use Supabase Auth to update password
      const { error } = await supabase.auth.updateUser({
        password: password
      });

      if (error) {
        console.error('Supabase password update error:', error);
        if (error.message.includes('expired')) {
          return res.status(400).json({ 
            error: 'Password reset link has expired',
            type: 'EXPIRED_TOKEN'
          });
        }
        return res.status(400).json({ 
          error: 'Invalid or expired reset token',
          type: 'INVALID_TOKEN'
        });
      }

      return res.json({ 
        message: 'Password updated successfully' 
      });
    } catch (error) {
      console.error('Reset password error:', error);
      return res.status(500).json({ error: 'Failed to reset password' });
    }
  }

  async verifyEmail(req: Request<{}, {}, { token: string }>, res: Response): Promise<Response> {
    console.log('📧 Email verification request');
    try {
      const { token } = req.body;

      // Verify the email using Supabase
      const { error } = await supabase.auth.verifyOtp({
        token_hash: token,
        type: 'email'
      });

      if (error) {
        console.error('Email verification error:', error);
        if (error.message.includes('expired')) {
          return res.status(400).json({ 
            error: 'Verification link has expired',
            type: 'EXPIRED_TOKEN'
          });
        }
        return res.status(400).json({ 
          error: 'Invalid verification token',
          type: 'INVALID_TOKEN'
        });
      }

      return res.json({ 
        message: 'Email verified successfully' 
      });
    } catch (error) {
      console.error('Email verification error:', error);
      return res.status(500).json({ error: 'Failed to verify email' });
    }
  }

  async resendVerification(req: Request<{}, {}, { email: string }>, res: Response): Promise<Response> {
    console.log('📧 Resend verification request for:', req.body.email);
    try {
      const { email } = req.body;

      // Resend verification email using Supabase
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: email
      });

      if (error) {
        console.error('Resend verification error:', error);
        if (error.message.includes('rate')) {
          return res.status(429).json({ 
            error: 'Too many requests. Please wait before trying again.',
            type: 'RATE_LIMITED'
          });
        }
        return res.status(400).json({ error: 'Failed to resend verification email' });
      }

      return res.json({ 
        message: 'Verification email sent successfully' 
      });
    } catch (error) {
      console.error('Resend verification error:', error);
      return res.status(500).json({ error: 'Failed to resend verification email' });
    }
  }

  async signup(req: Request<{}, {}, CreateUserDTO>, res: Response): Promise<Response> {
    console.log('🚀 Signup controller called with:', req.body);
    try {
      const { email, password } = req.body;
      console.log('🔐 Processing signup for email:', email);

      // Check if user already exists
      const { data: existingUser } = await supabase
        .from('users')
        .select('email')
        .eq('email', email)
        .single();

      if (existingUser) {
        return res.status(400).json({ error: 'User already exists' });
      }

      // Hash password for our database
      const password_hash = await hashPassword(password);

      // Create Stripe customer
      const stripeCustomer = await stripe.customers.create({
        email,
        metadata: {
          source: 'website_signup'
        }
      });

      // Create user directly in database - no email verification needed
      const { data: newUser, error } = await supabase
        .from('users')
        .insert({
          email,
          password_hash,
          stripe_customer_id: stripeCustomer.id,
          subscription_status: 'free' // Start with free trial
        })
        .select()
        .single();

      if (error) {
        // Clean up Stripe customer if user creation fails
        await stripe.customers.del(stripeCustomer.id);
        console.error('Database error creating user:', error);
        throw error;
      }

      // Generate JWT token
      const token = generateToken({
        userId: newUser.id,
        email: newUser.email
      });

      console.log('✅ User created successfully:', newUser.email);

      return res.status(201).json({
        message: 'User created successfully',
        token,
        user: {
          id: newUser.id,
          email: newUser.email,
          subscription_status: newUser.subscription_status
        }
      });
    } catch (error) {
      console.error('Signup error:', error);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }

  async login(req: Request<{}, {}, LoginDTO>, res: Response): Promise<Response> {
    console.log('🚀 Login controller called with:', req.body);
    try {
      const { email, password } = req.body;
      console.log('🔐 Processing login for email:', email);

      // Get user from database
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .single();

      if (error || !user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Verify password
      const isValidPassword = await comparePassword(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate JWT token
      const token = generateToken({
        userId: user.id,
        email: user.email
      });

      return res.json({
        message: 'Login successful',
        token,
        user: {
          id: user.id,
          email: user.email,
          subscription_status: user.subscription_status
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      return res.status(500).json({ error: 'Failed to login' });
    }
  }

  async getProfile(req: Request, res: Response): Promise<Response> {
    try {
      if (!req.user) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const { data: user, error } = await supabase
        .from('users')
        .select('id, email, subscription_status, created_at')
        .eq('id', req.user.userId)
        .single();

      if (error || !user) {
        return res.status(404).json({ error: 'User not found' });
      }

      const { data: license } = await supabase
        .from('licenses')
        .select('license_key, license_type, status, expires_at')
        .eq('user_id', req.user.userId)
        .eq('status', 'active')
        .single();

      return res.json({ 
        user: {
          ...user,
          license_key: license?.license_key || 'Not assigned',
          license_status: license?.status || 'UNKNOWN',
          license_type: license?.license_type || 'N/A',
          expires_at: license?.expires_at || 'N/A'
        }
      });
    } catch (error) {
      console.error('Get profile error:', error);
      return res.status(500).json({ error: 'Failed to get profile' });
    }
  }
}