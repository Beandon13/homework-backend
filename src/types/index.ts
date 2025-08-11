export interface User {
  id: string;
  email: string;
  password_hash: string;
  stripe_customer_id?: string;
  subscription_status: 'free' | 'active' | 'canceled' | 'past_due';
  subscription_id?: string;
  created_at: Date;
}

export interface CreateUserDTO {
  email: string;
  password: string;
}

export interface LoginDTO {
  email: string;
  password: string;
}

export interface JWTPayload {
  userId: string;
  email: string;
}

export interface CheckoutSessionDTO {
  priceId: string;
  successUrl: string;
  cancelUrl: string;
}