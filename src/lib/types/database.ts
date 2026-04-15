// Database types matching Supabase schema

export type CustomerStatus = 'active' | 'inactive' | 'flagged';
export type RepStatus = 'available' | 'busy' | 'offline' | 'on_call';
export type CallOutcome = 'resolved' | 'unresolved' | 'partial';
export type CallFlagStatus = 'none' | 'flagged' | 'reviewed' | 'dismissed';
export type AiSuccessStatus = 'successful' | 'partially_successful' | 'unsuccessful';
export type AiSentiment = 'positive' | 'neutral' | 'negative';
export type LedgerEntryType = 'purchase' | 'deduction' | 'adjustment' | 'refund';
export type PaymentStatusType = 'pending' | 'completed' | 'failed' | 'refunded';
export type CredentialAction = 'view' | 'copy';
export type CallbackStatusType = 'pending' | 'called_back' | 'expired';
export type UserRole = 'admin' | 'rep';

export interface Customer {
  id: string;
  full_name: string;
  primary_phone: string;
  secondary_phone: string | null;
  email: string | null;
  address: string | null;
  internal_notes: string | null;
  status: CustomerStatus;
  current_balance_minutes: number;
  total_minutes_purchased: number;
  total_minutes_used: number;
  created_at: string;
  updated_at: string;
}

export interface Rep {
  id: string;
  full_name: string;
  email: string;
  phone_extension: string | null;
  status: RepStatus;
  signalwire_resource_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface Call {
  id: string;
  customer_id: string | null;
  rep_id: string | null;
  inbound_phone: string | null;
  call_sid: string | null;
  started_at: string;
  connected_at: string | null;
  ended_at: string | null;
  total_duration_seconds: number | null;
  billable_duration_seconds: number | null;
  minutes_deducted: number;
  recording_url: string | null;
  recording_storage_path: string | null;
  transcript_text: string | null;
  rep_notes: string | null;
  task_category_id: string | null;
  outcome_status: CallOutcome | null;
  followup_needed: boolean;
  flag_status: CallFlagStatus;
  flag_reason: string | null;
  extensions_used: number;
  created_at: string;
}

export interface CallAnalysis {
  id: string;
  call_id: string;
  ai_summary: string | null;
  ai_category: string | null;
  ai_success_status: AiSuccessStatus | null;
  ai_sentiment: AiSentiment | null;
  ai_followup_needed: boolean;
  ai_wasted_time_flag: boolean;
  ai_flag_reason: string | null;
  ai_confidence_score: number | null;
  created_at: string;
}

export interface MinuteLedgerEntry {
  id: string;
  customer_id: string;
  entry_type: LedgerEntryType;
  minutes_amount: number;
  dollar_amount: number | null;
  reason: string | null;
  performed_by: string | null;
  call_id: string | null;
  payment_id: string | null;
  created_at: string;
}

export interface Payment {
  id: string;
  customer_id: string;
  package_id: string | null;
  package_name: string | null;
  minutes_added: number;
  amount_paid: number;
  currency: string;
  payment_status: PaymentStatusType;
  sola_transaction_ref: string | null;
  sola_token: string | null;
  created_at: string;
}

export interface PaymentPackage {
  id: string;
  name: string;
  minutes: number;
  price: number;
  currency: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskCategory {
  id: string;
  name: string;
  is_active: boolean;
  sort_order: number;
  created_at: string;
}

export interface TaskBenchmark {
  id: string;
  task_category_id: string;
  expected_min_minutes: number;
  expected_max_minutes: number;
  flag_threshold_minutes: number;
  created_at: string;
  updated_at: string;
}

export interface CustomerCredential {
  id: string;
  customer_id: string;
  service_name: string;
  username: string | null;
  encrypted_password: string; // bytea - not exposed to client
  encrypted_notes: string | null;
  encryption_key_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  last_accessed_by: string | null;
}

// Safe version that never includes password
export interface CustomerCredentialSafe {
  id: string;
  customer_id: string;
  service_name: string;
  username: string | null;
  created_at: string;
  updated_at: string;
}

export interface CredentialAccessLog {
  id: string;
  credential_id: string;
  rep_id: string;
  call_id: string;
  action: CredentialAction;
  accessed_at: string;
}

export interface CallbackRequest {
  id: string;
  phone_number: string;
  customer_id: string | null;
  requested_at: string;
  status: CallbackStatusType;
  called_back_at: string | null;
  called_back_by: string | null;
  notes: string | null;
}

export interface AdminSetting {
  id: string;
  key: string;
  value: unknown;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface DisclosurePrompt {
  id: string;
  name: string;
  prompt_text: string;
  is_enabled: boolean;
  plays_before_routing: boolean;
  requires_acknowledgment: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface AdminAuditLog {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_value: unknown | null;
  new_value: unknown | null;
  created_at: string;
}

export interface OwnerWithdrawal {
  id: string;
  amount: number;
  method: string;
  notes: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

// Joined / view types
export interface CallWithRelations extends Call {
  customer?: Customer | null;
  rep?: Rep | null;
  task_category?: TaskCategory | null;
  analysis?: CallAnalysis | null;
}

export interface RepWithStats extends Rep {
  total_calls?: number;
  total_talk_time_seconds?: number;
  avg_call_duration_seconds?: number;
  success_rate?: number;
  flagged_call_count?: number;
}
