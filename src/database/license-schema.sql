-- License Management Schema Extension for sAIge Math
-- This adds licensing capabilities to the existing database

-- Add license fields to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_key TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_status TEXT DEFAULT 'inactive' 
  CHECK (license_status IN ('active', 'expired', 'revoked', 'inactive', 'trial'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS license_type TEXT DEFAULT 'standard'
  CHECK (license_type IN ('trial', 'standard', 'premium', 'enterprise'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS max_devices INTEGER DEFAULT 1;

-- Create license_activations table for device tracking
CREATE TABLE IF NOT EXISTS license_activations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  license_key TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  machine_name TEXT,
  os_type TEXT,
  app_version TEXT,
  last_validated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  activated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deactivated_at TIMESTAMP WITH TIME ZONE,
  is_active BOOLEAN DEFAULT true,
  UNIQUE(license_key, machine_id)
);

-- Create license_validations table for audit trail
CREATE TABLE IF NOT EXISTS license_validations (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  license_key TEXT NOT NULL,
  machine_id TEXT,
  validation_type TEXT CHECK (validation_type IN ('hourly', 'startup', 'manual', 'api')),
  is_valid BOOLEAN NOT NULL,
  error_reason TEXT,
  ip_address TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_license_activations_user_id ON license_activations(user_id);
CREATE INDEX IF NOT EXISTS idx_license_activations_license_key ON license_activations(license_key);
CREATE INDEX IF NOT EXISTS idx_license_activations_machine_id ON license_activations(machine_id);
CREATE INDEX IF NOT EXISTS idx_license_validations_user_id ON license_validations(user_id);
CREATE INDEX IF NOT EXISTS idx_license_validations_created_at ON license_validations(created_at);

-- Function to generate unique license key
CREATE OR REPLACE FUNCTION generate_license_key()
RETURNS TEXT AS $$
DECLARE
  chars TEXT := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  result TEXT := '';
  i INTEGER;
BEGIN
  -- Generate format: XXXX-XXXX-XXXX-XXXX
  FOR i IN 1..16 LOOP
    IF i % 4 = 1 AND i > 1 THEN
      result := result || '-';
    END IF;
    result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
  END LOOP;
  RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Function to check active device count
CREATE OR REPLACE FUNCTION check_device_limit(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  active_count INTEGER;
  max_allowed INTEGER;
BEGIN
  SELECT COUNT(*) INTO active_count
  FROM license_activations
  WHERE user_id = p_user_id AND is_active = true;
  
  SELECT max_devices INTO max_allowed
  FROM users
  WHERE id = p_user_id;
  
  RETURN active_count < max_allowed;
END;
$$ LANGUAGE plpgsql;

-- Row Level Security Policies
ALTER TABLE license_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE license_validations ENABLE ROW LEVEL SECURITY;

-- Users can only see their own license activations
CREATE POLICY "Users can view own license activations" ON license_activations
  FOR SELECT USING (auth.uid() = user_id);

-- Users can only see their own validation history
CREATE POLICY "Users can view own validation history" ON license_validations
  FOR SELECT USING (auth.uid() = user_id);