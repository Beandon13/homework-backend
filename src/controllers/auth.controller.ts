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

      const { data: licenses } = await supabase
        .from('licenses')
        .select('license_key, license_type, status, expires_at')
        .eq('user_id', req.user.userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false });

      // Use the most recent active license if multiple exist
      const license = licenses && licenses.length > 0 ? licenses[0] : null;

      return res.json({ 
        user: {
          ...user,
          license_key: license?.license_key || 'Not assigned',
          license_status: license?.status || 'UNKNOWN',
          license_type: license?.license_type || 'N/A',
          expires_at: license?.expires_at || 'N/A',
          total_active_licenses: licenses?.length || 0
        }
      });
    } catch (error) {
      console.error('Get profile error:', error);
      return res.status(500).json({ error: 'Failed to get profile' });
    }
  }

  async loginAndGetLicense(req: Request, res: Response): Promise<Response> {
    try {
      const { email, password, device_id, device_name } = req.body;

      // Query users table to find user by email
      const { data: user, error: userError } = await supabase
        .from('users')
        .select('*')
        .eq('email', email)
        .single();

      if (userError || !user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Verify password
      const isValidPassword = await comparePassword(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Query licenses table to find active license for this user's email
      let { data: license, error: licenseError } = await supabase
        .from('licenses')
        .select('id, license_key, user_email, status, expires_at')
        .eq('user_email', email)
        .eq('status', 'active')
        .single();

      // If no license found but user has active subscription, create one
      if ((licenseError || !license) && user.subscription_status === 'active') {
        // Generate a new license key for the active subscriber
        const newLicenseKey = `LIC-${user.id.substring(0, 8).toUpperCase()}-${Date.now()}`;
        
        // Create new license record
        const { data: newLicense, error: createError } = await supabase
          .from('licenses')
          .insert({
            user_id: user.id,
            user_email: email,
            license_key: newLicenseKey,
            status: 'active',
            license_type: 'subscription',
            expires_at: user.subscription_current_period_end
          })
          .select('id, license_key, user_email, status, expires_at')
          .single();

        if (createError || !newLicense) {
          console.error('Failed to create license for active subscriber:', createError);
          return res.status(500).json({ error: 'Failed to create license' });
        }

        license = newLicense;
      } else if (licenseError || !license) {
        // Only reject if no license AND not an active subscriber
        return res.status(403).json({ error: 'No active license or subscription' });
      }

      // Query authorized_devices table to count devices for this license_id
      const { data: devices, error: devicesError } = await supabase
        .from('authorized_devices')
        .select('id, created_at, last_validated')
        .eq('license_id', license.id)
        .order('last_validated', { ascending: true, nullsFirst: true });

      if (devicesError) {
        throw devicesError;
      }

      let deviceCount = devices?.length || 0;

      // If count >= 3, delete the oldest device (earliest last_validated) for this license_id
      if (deviceCount >= 3) {
        const oldestDevice = devices[0];
        const { error: deleteError } = await supabase
          .from('authorized_devices')
          .delete()
          .eq('id', oldestDevice.id);

        if (deleteError) {
          throw deleteError;
        }
        deviceCount--;
      }

      // Upsert the current device into authorized_devices table with updated last_validated
      const { error: upsertError } = await supabase
        .from('authorized_devices')
        .upsert({
          license_id: license.id,
          device_id,
          device_name,
          last_validated: new Date().toISOString()
        }, {
          onConflict: 'license_id, device_id'
        });

      if (upsertError) {
        throw upsertError;
      }

      // Get final device count after upsert
      const { data: finalDevices, error: finalCountError } = await supabase
        .from('authorized_devices')
        .select('id')
        .eq('license_id', license.id);

      if (finalCountError) {
        throw finalCountError;
      }

      const finalDeviceCount = finalDevices?.length || 0;

      // Generate JWT token
      const token = generateToken(user.id);

      return res.json({
        valid: true,
        token,
        license_key: license.license_key,
        user_email: license.user_email,
        expires_at: license.expires_at,
        device_count: finalDeviceCount,
        max_devices: 3
      });
    } catch (error) {
      console.error('Login and get license error:', error);
      return res.status(500).json({ error: 'Failed to login and validate license' });
    }
  }

  async validateLicense(req: Request, res: Response): Promise<Response> {
    try {
      const { license_key, device_id, device_name } = req.body;

      // Query the licenses table to find the license by license_key
      const { data: license, error: licenseError } = await supabase
        .from('licenses')
        .select('id, user_email, status, expires_at')
        .eq('license_key', license_key)
        .single();

      if (licenseError || !license) {
        return res.status(400).json({ valid: false, error: 'Invalid license key' });
      }

      // Check if the license status is 'active'
      if (license.status !== 'active') {
        return res.status(400).json({ valid: false, error: 'License inactive' });
      }

      // Query authorized_devices table to count devices for this license_id
      const { data: devices, error: devicesError } = await supabase
        .from('authorized_devices')
        .select('id, created_at, last_validated')
        .eq('license_id', license.id)
        .order('last_validated', { ascending: true, nullsFirst: true });

      if (devicesError) {
        throw devicesError;
      }

      let deviceCount = devices?.length || 0;

      // If count >= 3, delete the oldest device (earliest last_validated) for this license_id
      if (deviceCount >= 3) {
        const oldestDevice = devices[0];
        const { error: deleteError } = await supabase
          .from('authorized_devices')
          .delete()
          .eq('id', oldestDevice.id);

        if (deleteError) {
          throw deleteError;
        }
        deviceCount--;
      }

      // Upsert the current device into authorized_devices table with updated last_validated
      const { error: upsertError } = await supabase
        .from('authorized_devices')
        .upsert({
          license_id: license.id,
          device_id,
          device_name,
          last_validated: new Date().toISOString()
        }, {
          onConflict: 'license_id, device_id'
        });

      if (upsertError) {
        throw upsertError;
      }

      // Get final device count after upsert
      const { data: finalDevices, error: finalCountError } = await supabase
        .from('authorized_devices')
        .select('id')
        .eq('license_id', license.id);

      if (finalCountError) {
        throw finalCountError;
      }

      const finalDeviceCount = finalDevices?.length || 0;

      return res.json({
        valid: true,
        user_email: license.user_email,
        expires_at: license.expires_at,
        device_count: finalDeviceCount,
        max_devices: 3
      });
    } catch (error) {
      console.error('License validation error:', error);
      return res.status(500).json({ error: 'Failed to validate license' });
    }
  }
}