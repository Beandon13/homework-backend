-- Licenses and Device Management Schema for sAIge Math
-- This creates the proper tables for license and device management

-- Create licenses table (separate from users)
CREATE TABLE IF NOT EXISTS licenses (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  license_key TEXT UNIQUE NOT NULL,
  license_type TEXT DEFAULT 'standard' CHECK (license_type IN ('trial', 'standard', 'premium', 'enterprise')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'revoked', 'inactive')),
  max_devices INTEGER DEFAULT 3,
  expires_at TIMESTAMP WITH TIME ZONE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create authorized_devices table for device tracking
CREATE TABLE IF NOT EXISTS authorized_devices (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  license_id UUID REFERENCES licenses(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT,
  last_validated TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(license_id, device_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_licenses_user_id ON licenses(user_id);
CREATE INDEX IF NOT EXISTS idx_licenses_license_key ON licenses(license_key);
CREATE INDEX IF NOT EXISTS idx_licenses_status ON licenses(status);
CREATE INDEX IF NOT EXISTS idx_authorized_devices_license_id ON authorized_devices(license_id);
CREATE INDEX IF NOT EXISTS idx_authorized_devices_device_id ON authorized_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_authorized_devices_last_validated ON authorized_devices(last_validated);

-- Enable Row Level Security
ALTER TABLE licenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE authorized_devices ENABLE ROW LEVEL SECURITY;

-- RLS policies for licenses table
CREATE POLICY "Users can view own licenses" ON licenses
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Service role has full access to licenses" ON licenses
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- RLS policies for authorized_devices table
CREATE POLICY "Users can view devices for their licenses" ON authorized_devices
  FOR SELECT USING (
    license_id IN (
      SELECT id FROM licenses WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Service role has full access to authorized_devices" ON authorized_devices
  FOR ALL USING (auth.jwt()->>'role' = 'service_role');

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_licenses_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger to automatically update updated_at
CREATE TRIGGER update_licenses_updated_at
  BEFORE UPDATE ON licenses
  FOR EACH ROW
  EXECUTE FUNCTION update_licenses_updated_at();

-- Migration: Remove old license fields from users table if they exist
ALTER TABLE users DROP COLUMN IF EXISTS license_key;
ALTER TABLE users DROP COLUMN IF EXISTS license_expires_at;
ALTER TABLE users DROP COLUMN IF EXISTS license_status;
ALTER TABLE users DROP COLUMN IF EXISTS license_type;
ALTER TABLE users DROP COLUMN IF EXISTS max_devices;

-- Drop old tables if they exist
DROP TABLE IF EXISTS license_activations CASCADE;
DROP TABLE IF EXISTS license_validations CASCADE;