'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import { formatCurrency, formatPhone } from '@/lib/utils';
import {
  CreditCard,
  DollarSign,
  Search,
  Loader2,
  CheckCircle,
  Package,
} from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface Customer {
  id: string;
  full_name: string;
  primary_phone: string;
  current_balance_minutes: number;
}

interface PaymentPackage {
  id: string;
  name: string;
  minutes: number;
  price: number;
}

export default function RepPaymentsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [packages, setPackages] = useState<PaymentPackage[]>([]);
  const [search, setSearch] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedPackage, setSelectedPackage] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [paymentSuccess, setPaymentSuccess] = useState(false);

  // Card fields
  const [cardNumber, setCardNumber] = useState('');
  const [expDate, setExpDate] = useState('');
  const [cvv, setCvv] = useState('');
  const [cardName, setCardName] = useState('');

  const supabase = createClient();

  useEffect(() => {
    async function init() {
      const { data: pkgs } = await supabase
        .from('payment_packages')
        .select('*')
        .eq('is_active', true)
        .order('sort_order');
      if (pkgs) setPackages(pkgs);
      setLoading(false);
    }
    init();
  }, []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      if (search.length < 2) {
        setCustomers([]);
        return;
      }
      const res = await edgeFn('customers', { params: { search: encodeURIComponent(search), limit: '10' } });
      if (res.ok) {
        const data = await res.json();
        setCustomers(data.customers || []);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const formatCardInput = (value: string) => {
    const cleaned = value.replace(/\D/g, '');
    const groups = cleaned.match(/.{1,4}/g);
    return groups ? groups.join(' ') : '';
  };

  const formatExpInput = (value: string) => {
    const cleaned = value.replace(/\D/g, '');
    if (cleaned.length >= 3) {
      return cleaned.slice(0, 2) + '/' + cleaned.slice(2, 4);
    }
    return cleaned;
  };

  const processPayment = async () => {
    if (!selectedCustomer || !selectedPackage) {
      toast.error('Select a customer and package');
      return;
    }
    const cleanCard = cardNumber.replace(/\s/g, '');
    if (cleanCard.length < 13 || cleanCard.length > 19) {
      toast.error('Enter a valid card number');
      return;
    }
    if (expDate.length < 4) {
      toast.error('Enter a valid expiration date');
      return;
    }
    if (cvv.length < 3) {
      toast.error('Enter a valid CVV');
      return;
    }
    if (!cardName.trim()) {
      toast.error('Enter the cardholder name');
      return;
    }

    setProcessing(true);
    try {
      const res = await edgeFn('payments-process', {
        method: 'POST',
        body: JSON.stringify({
          customerId: selectedCustomer.id,
          packageId: selectedPackage,
          cardNumber: cleanCard,
          cardExp: expDate.replace('/', ''),
          cardCvv: cvv,
          cardName,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setPaymentSuccess(true);
        toast.success(`Payment processed! ${data.minutesAdded} minutes added.`);
        // Clear form
        setCardNumber('');
        setExpDate('');
        setCvv('');
        setCardName('');
        setSelectedPackage('');
        // Refresh customer balance
        const { data: updated } = await supabase
          .from('customers')
          .select('id, full_name, primary_phone, current_balance_minutes')
          .eq('id', selectedCustomer.id)
          .single();
        if (updated) setSelectedCustomer(updated);
        setTimeout(() => setPaymentSuccess(false), 3000);
      } else {
        const err = await res.json();
        toast.error(err.error || 'Payment failed');
      }
    } catch {
      toast.error('Payment processing failed');
    } finally {
      setProcessing(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const pkg = packages.find((p) => p.id === selectedPackage);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h2 className="text-xl font-semibold flex items-center gap-2">
        <CreditCard className="w-6 h-6" />
        Process Payment
      </h2>

      {/* Customer Search */}
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase mb-3">1. Select Customer</h3>

        {selectedCustomer ? (
          <div className="flex items-center justify-between p-3 bg-blue-50 rounded-lg border border-blue-200">
            <div>
              <div className="font-medium">{selectedCustomer.full_name}</div>
              <div className="text-sm text-gray-500">
                {formatPhone(selectedCustomer.primary_phone)} &middot; Balance:{' '}
                <span className="font-medium">
                  {selectedCustomer.current_balance_minutes} min
                </span>
              </div>
            </div>
            <button
              onClick={() => {
                setSelectedCustomer(null);
                setSearch('');
              }}
              className="text-sm text-blue-600 hover:underline"
            >
              Change
            </button>
          </div>
        ) : (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or phone..."
              className="w-full pl-9 pr-3 py-2 rounded-lg border text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {customers.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                {customers.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setSelectedCustomer(c);
                      setCustomers([]);
                      setSearch('');
                    }}
                    className="w-full text-left px-4 py-2 hover:bg-gray-50 text-sm border-b last:border-b-0"
                  >
                    <div className="font-medium">{c.full_name}</div>
                    <div className="text-xs text-gray-500">{formatPhone(c.primary_phone)}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Package Selection */}
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase mb-3">2. Select Package</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {packages.map((p) => (
            <button
              key={p.id}
              onClick={() => setSelectedPackage(p.id)}
              className={`p-4 rounded-lg border-2 text-center transition ${
                selectedPackage === p.id
                  ? 'border-blue-600 bg-blue-50 ring-2 ring-blue-600'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <Package className="w-6 h-6 mx-auto mb-2 text-blue-600" />
              <div className="font-semibold">{p.name}</div>
              <div className="text-2xl font-bold text-blue-600">{formatCurrency(p.price)}</div>
              <div className="text-sm text-gray-500">{p.minutes} minutes</div>
            </button>
          ))}
        </div>
      </div>

      {/* Card Details */}
      <div className="bg-white rounded-xl shadow-sm border p-6">
        <h3 className="text-sm font-semibold text-gray-500 uppercase mb-3">3. Card Details</h3>
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Cardholder Name</label>
            <input
              value={cardName}
              onChange={(e) => setCardName(e.target.value)}
              placeholder="Name on card"
              className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Card Number</label>
            <input
              value={cardNumber}
              onChange={(e) => setCardNumber(formatCardInput(e.target.value))}
              placeholder="1234 5678 9012 3456"
              maxLength={19}
              className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Expiration</label>
              <input
                value={expDate}
                onChange={(e) => setExpDate(formatExpInput(e.target.value))}
                placeholder="MM/YY"
                maxLength={5}
                className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">CVV</label>
              <input
                value={cvv}
                onChange={(e) => setCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                placeholder="123"
                maxLength={4}
                type="password"
                className="w-full rounded-lg border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>
      </div>

      {/* Submit */}
      <button
        onClick={processPayment}
        disabled={processing || !selectedCustomer || !selectedPackage}
        className={`w-full flex items-center justify-center gap-2 py-3 rounded-xl text-white font-semibold text-lg transition ${
          processing || !selectedCustomer || !selectedPackage
            ? 'bg-gray-400 cursor-not-allowed'
            : paymentSuccess
            ? 'bg-green-600'
            : 'bg-blue-600 hover:bg-blue-700'
        }`}
      >
        {processing ? (
          <>
            <Loader2 className="w-5 h-5 animate-spin" />
            Processing...
          </>
        ) : paymentSuccess ? (
          <>
            <CheckCircle className="w-5 h-5" />
            Payment Successful!
          </>
        ) : (
          <>
            <DollarSign className="w-5 h-5" />
            Charge {pkg ? formatCurrency(pkg.price) : '$0.00'}
          </>
        )}
      </button>
    </div>
  );
}
