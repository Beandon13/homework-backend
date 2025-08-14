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

  static async generateLicenseKey(
    userId: string, 
    licenseType: string = 'standard',
    stripeCustomerId?: string,
    stripeSubscriptionId?: string
  ): Promise<string> {
    // Generate a unique license key in JavaScript
    // Format: LIC-{userId}-{timestamp}
    const timestamp = Date.now();
    const licenseKey = `LIC-${userId.substring(0, 8).toUpperCase()}-${timestamp}`;
    
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
        id: crypto.randomUUID(),
        user_id: userId,
        license_key: licenseKey,
        license_type: licenseType,
        status: 'active',
        expires_at: expiresAt.toISOString(),
        max_devices: licenseType === 'enterprise' ? 10 : 3,
        stripe_customer_id: stripeCustomerId || null,
        stripe_subscription_id: stripeSubscriptionId || null
      });
    
    if (insertError) {
      console.error('Supabase insert error:', insertError);
      throw new Error(`Failed to create license: ${insertError.message}`);
    }
    
    return licenseKey;
  }

  static async validateLicense(userId: string, licenseKey?: string): Promise<LicenseInfo> {
    try {
      // Get user's license info from licenses table
      const { data: license, error } = await supabase
        .from('licenses')
        .select('license_key, license_type, status, expires_at, max_devices')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();
      
      if (error || !license) {
        return {
          isValid: false,
          errorReason: 'No active license found'
        };
      }
      
      // If license key provided, verify it matches
      if (licenseKey && license.license_key !== licenseKey) {
        return {
          isValid: false,
          errorReason: 'Invalid license key'
        };
      }
      
      // Check license status
      if (license.status === 'revoked') {
        return {
          isValid: false,
          errorReason: 'License has been revoked'
        };
      }
      
      // Check expiration
      const now = new Date();
      const expiresAt = new Date(license.expires_at);
      
      if (expiresAt < now) {
        // Update status to expired
        await supabase
          .from('licenses')
          .update({ status: 'expired' })
          .eq('user_id', userId)
          .eq('license_key', license.license_key);
        
        return {
          isValid: false,
          errorReason: 'License has expired',
          licenseKey: license.license_key,
          expiresAt
        };
      }
      
      // License is valid
      return {
        isValid: true,
        licenseKey: license.license_key,
        licenseType: license.license_type,
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
      
      // Get the license ID
      const { data: license, error: licenseError } = await supabase
        .from('licenses')
        .select('id, max_devices')
        .eq('user_id', userId)
        .eq('license_key', licenseKey)
        .eq('status', 'active')
        .single();
      
      if (licenseError || !license) {
        throw new Error('Invalid or inactive license');
      }
      
      // Check current device count
      const { data: devices, error: devicesError } = await supabase
        .from('authorized_devices')
        .select('id')
        .eq('license_id', license.id);
      
      if (devicesError) {
        throw devicesError;
      }
      
      const deviceCount = devices?.length || 0;
      const maxDevices = license.max_devices || 3;
      
      // Check if this device already exists
      const { data: existingDevice } = await supabase
        .from('authorized_devices')
        .select('id')
        .eq('license_id', license.id)
        .eq('device_id', deviceInfo.machineId)
        .single();
      
      if (existingDevice) {
        // Update last validated time for existing device
        await supabase
          .from('authorized_devices')
          .update({ last_validated: new Date().toISOString() })
          .eq('id', existingDevice.id);
        
        return true;
      }
      
      // Check if we can add a new device
      if (deviceCount >= maxDevices) {
        throw new Error('Device limit reached');
      }
      
      // Add new device
      const { error } = await supabase
        .from('authorized_devices')
        .insert({
          license_id: license.id,
          device_id: deviceInfo.machineId,
          device_name: deviceInfo.machineName,
          last_validated: new Date().toISOString()
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
      
      // Get user's active license
      const { data: license, error: licenseError } = await supabase
        .from('licenses')
        .select('id')
        .eq('user_id', userId)
        .eq('status', 'active')
        .single();
      
      if (licenseError || !license) {
        return false;
      }
      
      // Delete the device from authorized_devices
      const { error } = await supabase
        .from('authorized_devices')
        .delete()
        .eq('license_id', license.id)
        .eq('device_id', targetMachineId);
      
      return !error;
    } catch (error) {
      console.error('Device deactivation error:', error);
      return false;
    }
  }

  static async getActiveDevices(userId: string): Promise<any[]> {
    // Get user's active license
    const { data: license, error: licenseError } = await supabase
      .from('licenses')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();
    
    if (licenseError || !license) {
      return [];
    }
    
    // Get devices for this license
    const { data, error } = await supabase
      .from('authorized_devices')
      .select('*')
      .eq('license_id', license.id)
      .order('created_at', { ascending: false });
    
    if (error) {
      throw new Error('Failed to fetch active devices');
    }
    
    return data || [];
  }
}