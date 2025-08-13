import { supabase } from './supabase.js';
import crypto from 'crypto';
import os from 'os';

interface LicenseInfo {
  isValid: boolean;
  licenseKey?: string;
  licenseType?: string;
  expiresAt?: Date;
  errorReason?: string;
}

interface DeviceInfo {
  machineId: string;
  machineName: string;
  osType: string;
  appVersion: string;
}

export class LicenseService {
  private static getMachineId(): string {
    // Generate a unique machine ID based on system info
    const cpus = os.cpus();
    const networkInterfaces = os.networkInterfaces();
    const hostname = os.hostname();
    
    const data = JSON.stringify({
      hostname,
      cpuModel: cpus[0]?.model,
      cpuCount: cpus.length,
      platform: os.platform(),
      arch: os.arch(),
      // Use first non-internal network interface MAC address
      mac: Object.values(networkInterfaces)
        .flat()
        .find(ni => ni && !ni.internal && ni.mac)?.mac
    });
    
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private static getDeviceInfo(): DeviceInfo {
    return {
      machineId: this.getMachineId(),
      machineName: os.hostname(),
      osType: `${os.platform()} ${os.release()}`,
      appVersion: process.env.APP_VERSION || '1.0.0'
    };
  }

  static async generateLicenseKey(userId: string, licenseType: string = 'standard'): Promise<string> {
    // Generate a unique license key in JavaScript
    // Format: SM-{timestamp}-{random string}
    const timestamp = Date.now();
    const randomString = Math.random().toString(36).substring(2, 15);
    const licenseKey = `SM-${timestamp}-${randomString}`;
    
    // Calculate expiration based on license type
    const expiresAt = new Date();
    switch (licenseType) {
      case 'trial':
        expiresAt.setDate(expiresAt.getDate() + 14); // 14 days trial
        break;
      case 'standard':
        expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year
        break;
      case 'premium':
        expiresAt.setFullYear(expiresAt.getFullYear() + 1); // 1 year
        break;
      case 'enterprise':
        expiresAt.setFullYear(expiresAt.getFullYear() + 3); // 3 years
        break;
    }
    
    // Insert license info into licenses table
    const { error: insertError } = await supabase
      .from('licenses')
      .insert({
        user_id: userId,
        license_key: licenseKey,
        license_type: licenseType,
        license_status: 'active',
        license_expires_at: expiresAt.toISOString(),
        max_devices: licenseType === 'enterprise' ? 10 : licenseType === 'premium' ? 5 : 1
      });
    
    if (insertError) {
      console.error('Supabase insert error:', insertError);
      throw new Error(`Failed to create license: ${insertError.message}`);
    }
    
    return licenseKey;
  }

  static async validateLicense(userId: string, licenseKey?: string): Promise<LicenseInfo> {
    try {
      // Get user's license info
      const { data: user, error } = await supabase
        .from('users')
        .select('license_key, license_type, license_status, license_expires_at, max_devices')
        .eq('id', userId)
        .single();
      
      if (error || !user) {
        return {
          isValid: false,
          errorReason: 'User not found'
        };
      }
      
      // Check if user has a license
      if (!user.license_key) {
        return {
          isValid: false,
          errorReason: 'No license assigned'
        };
      }
      
      // If license key provided, verify it matches
      if (licenseKey && user.license_key !== licenseKey) {
        return {
          isValid: false,
          errorReason: 'Invalid license key'
        };
      }
      
      // Check license status
      if (user.license_status === 'revoked') {
        return {
          isValid: false,
          errorReason: 'License has been revoked'
        };
      }
      
      // Check expiration
      const now = new Date();
      const expiresAt = new Date(user.license_expires_at);
      
      if (expiresAt < now) {
        // Update status to expired
        await supabase
          .from('users')
          .update({ license_status: 'expired' })
          .eq('id', userId);
        
        return {
          isValid: false,
          errorReason: 'License has expired',
          licenseKey: user.license_key,
          expiresAt
        };
      }
      
      // License is valid
      return {
        isValid: true,
        licenseKey: user.license_key,
        licenseType: user.license_type,
        expiresAt
      };
    } catch (error) {
      console.error('License validation error:', error);
      return {
        isValid: false,
        errorReason: 'Validation error'
      };
    }
  }

  static async activateDevice(userId: string, licenseKey: string): Promise<boolean> {
    try {
      const deviceInfo = this.getDeviceInfo();
      
      // Check if we can activate another device
      const { data: canActivate } = await supabase.rpc('check_device_limit', {
        p_user_id: userId
      });
      
      if (!canActivate) {
        // Check if this device is already activated
        const { data: existingActivation } = await supabase
          .from('license_activations')
          .select('id')
          .eq('user_id', userId)
          .eq('machine_id', deviceInfo.machineId)
          .eq('is_active', true)
          .single();
        
        if (!existingActivation) {
          throw new Error('Device limit reached');
        }
        
        // Update last validated time for existing activation
        await supabase
          .from('license_activations')
          .update({ last_validated_at: new Date().toISOString() })
          .eq('id', existingActivation.id);
        
        return true;
      }
      
      // Create or update device activation
      const { error } = await supabase
        .from('license_activations')
        .upsert({
          user_id: userId,
          license_key: licenseKey,
          machine_id: deviceInfo.machineId,
          machine_name: deviceInfo.machineName,
          os_type: deviceInfo.osType,
          app_version: deviceInfo.appVersion,
          last_validated_at: new Date().toISOString(),
          is_active: true
        }, {
          onConflict: 'license_key,machine_id'
        });
      
      if (error) {
        throw new Error('Failed to activate device');
      }
      
      return true;
    } catch (error) {
      console.error('Device activation error:', error);
      return false;
    }
  }

  static async deactivateDevice(userId: string, machineId?: string): Promise<boolean> {
    try {
      const targetMachineId = machineId || this.getMachineId();
      
      const { error } = await supabase
        .from('license_activations')
        .update({
          is_active: false,
          deactivated_at: new Date().toISOString()
        })
        .eq('user_id', userId)
        .eq('machine_id', targetMachineId);
      
      return !error;
    } catch (error) {
      console.error('Device deactivation error:', error);
      return false;
    }
  }

  static async recordValidation(
    userId: string,
    licenseKey: string,
    isValid: boolean,
    validationType: 'hourly' | 'startup' | 'manual' | 'api' = 'api',
    errorReason?: string,
    ipAddress?: string
  ): Promise<void> {
    try {
      await supabase
        .from('license_validations')
        .insert({
          user_id: userId,
          license_key: licenseKey,
          machine_id: this.getMachineId(),
          validation_type: validationType,
          is_valid: isValid,
          error_reason: errorReason,
          ip_address: ipAddress
        });
    } catch (error) {
      console.error('Failed to record validation:', error);
    }
  }

  static async getActiveDevices(userId: string): Promise<any[]> {
    const { data, error } = await supabase
      .from('license_activations')
      .select('*')
      .eq('user_id', userId)
      .eq('is_active', true)
      .order('activated_at', { ascending: false });
    
    if (error) {
      throw new Error('Failed to fetch active devices');
    }
    
    return data || [];
  }
}