import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../utils/auth.js';
import { LicenseService } from '../services/license.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        email: string;
        licenseValid?: boolean;
        licenseType?: string;
      };
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const token = authHeader.substring(7);
    const payload = verifyToken(token);
    
    req.user = {
      userId: payload.userId,
      email: payload.email
    };
    
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

export const validateLicense = async (req: Request, res: Response, next: NextFunction): Promise<Response | void> => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    // Get license key from header if provided
    const licenseKey = req.headers['x-license-key'] as string;
    
    // Validate the license
    const licenseInfo = await LicenseService.validateLicense(req.user.userId, licenseKey);
    
    // Record the validation attempt
    const ipAddress = req.ip || req.socket.remoteAddress;
    await LicenseService.recordValidation(
      req.user.userId,
      licenseKey || '',
      licenseInfo.isValid,
      'api',
      licenseInfo.errorReason,
      ipAddress
    );
    
    if (!licenseInfo.isValid) {
      return res.status(403).json({ 
        error: 'Invalid license',
        reason: licenseInfo.errorReason 
      });
    }
    
    // Try to activate device if license is valid
    if (licenseInfo.licenseKey) {
      const activated = await LicenseService.activateDevice(req.user.userId, licenseInfo.licenseKey);
      if (!activated) {
        // Device limit reached but might be already activated
        console.warn('Device activation warning for user:', req.user.userId);
      }
    }
    
    // Add license info to request
    req.user.licenseValid = licenseInfo.isValid;
    req.user.licenseType = licenseInfo.licenseType;
    
    next();
  } catch (error) {
    console.error('License validation error:', error);
    return res.status(500).json({ error: 'License validation failed' });
  }
};

// Middleware that only checks license without blocking
export const checkLicense = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      return next();
    }
    
    const licenseInfo = await LicenseService.validateLicense(req.user.userId);
    req.user.licenseValid = licenseInfo.isValid;
    req.user.licenseType = licenseInfo.licenseType;
    
    next();
  } catch (error) {
    // Don't block on errors, just log
    console.error('License check error:', error);
    next();
  }
};