import dotenv from 'dotenv';
import { supabase } from '../services/supabase.js';
import { stripe } from '../services/stripe.js';
import { hashPassword } from '../utils/auth.js';

// Load environment variables
dotenv.config();

interface TestUser {
  email: string;
  password: string;
  description: string;
}

const TEST_USERS: TestUser[] = [
  {
    email: 'test@test.com',
    password: 'Test123!',
    description: 'Default test user'
  },
  {
    email: 'admin@saige.com',
    password: 'Admin123!',
    description: 'Admin test user'
  },
  {
    email: 'demo@saige.com',
    password: 'Demo123!',
    description: 'Demo user for presentations'
  }
];

async function createTestUser(email: string, password: string, description: string) {
  console.log(`\n📝 Creating user: ${email} (${description})`);
  
  try {
    // Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('email')
      .eq('email', email)
      .single();

    if (existingUser) {
      console.log(`⚠️  User ${email} already exists - skipping`);
      return;
    }

    // Hash password
    const password_hash = await hashPassword(password);

    // Create Stripe customer
    const stripeCustomer = await stripe.customers.create({
      email,
      metadata: {
        source: 'test_user_script',
        description
      }
    });
    console.log(`✅ Created Stripe customer: ${stripeCustomer.id}`);

    // Create user in database
    const { data: newUser, error } = await supabase
      .from('users')
      .insert({
        email,
        password_hash,
        stripe_customer_id: stripeCustomer.id,
        subscription_status: 'free'
      })
      .select()
      .single();

    if (error) {
      // Clean up Stripe customer if user creation fails
      await stripe.customers.del(stripeCustomer.id);
      throw error;
    }

    console.log(`✅ Created user: ${email}`);
    console.log(`   ID: ${newUser.id}`);
    console.log(`   Password: ${password}`);
    console.log(`   Status: ${newUser.subscription_status}`);
    
  } catch (error) {
    console.error(`❌ Failed to create user ${email}:`, error);
  }
}

async function main() {
  console.log('🚀 Starting test user creation script...');
  console.log('================================');
  
  // Create all test users
  for (const user of TEST_USERS) {
    await createTestUser(user.email, user.password, user.description);
  }
  
  console.log('\n================================');
  console.log('✅ Test user creation complete!');
  console.log('\n📋 Available test accounts:');
  console.log('---------------------------');
  
  for (const user of TEST_USERS) {
    console.log(`Email: ${user.email}`);
    console.log(`Password: ${user.password}`);
    console.log(`Description: ${user.description}`);
    console.log('---------------------------');
  }
  
  console.log('\n💡 You can now use these accounts to test the application');
  process.exit(0);
}

// Run the script
main().catch((error) => {
  console.error('Script failed:', error);
  process.exit(1);
});