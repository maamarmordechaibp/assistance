'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Package, Plus, Save, Loader2, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { formatCurrency } from '@/lib/utils';

interface Pkg {
  id: string;
  name: string;
  minutes: number;
  price: number;
  description: string | null;
  is_active: boolean;
  sort_order: number;
}

export default function AdminPackagesPage() {
  const [packages, setPackages] = useState<Pkg[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [newPkg, setNewPkg] = useState({ name: '', minutes: '', price: '', description: '' });
  const [editId, setEditId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<Pkg>>({});

  const fetchPackages = async () => {
    const res = await edgeFn('packages', { params: { all: 'true' } });
    if (res.ok) {
      const data = await res.json();
      setPackages(data.packages || []);
    }
    setLoading(false);
  };

  useEffect(() => { fetchPackages(); }, []);

  const handleAdd = async () => {
    if (!newPkg.name || !newPkg.minutes || !newPkg.price) {
      toast.error('Fill in name, minutes, and price');
      return;
    }
    setSaving('new');
    const res = await edgeFn('packages', {
      method: 'POST',
      body: JSON.stringify({
        name: newPkg.name,
        minutes: parseInt(newPkg.minutes),
        price: parseFloat(newPkg.price),
        description: newPkg.description,
      }),
    });
    if (res.ok) {
      toast.success('Package created');
      setNewPkg({ name: '', minutes: '', price: '', description: '' });
      setShowAdd(false);
      fetchPackages();
    } else {
      toast.error('Failed to create package');
    }
    setSaving(null);
  };

  const handleSave = async (id: string) => {
    setSaving(id);
    const res = await edgeFn('packages', {
      method: 'PATCH',
      body: JSON.stringify({ id, ...editValues }),
    });
    if (res.ok) {
      toast.success('Package updated');
      setEditId(null);
      fetchPackages();
    } else {
      toast.error('Failed to update');
    }
    setSaving(null);
  };

  const handleToggle = async (pkg: Pkg) => {
    setSaving(pkg.id);
    const res = await edgeFn('packages', {
      method: 'PATCH',
      body: JSON.stringify({ id: pkg.id, is_active: !pkg.is_active }),
    });
    if (res.ok) {
      toast.success(pkg.is_active ? 'Package deactivated' : 'Package activated');
      fetchPackages();
    }
    setSaving(null);
  };

  const costPerMinute = 0.24;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Package className="w-5 h-5" />
          Minute Packages
        </h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Add Package
        </button>
      </div>

      {/* Add new package form */}
      {showAdd && (
        <div className="bg-white rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold mb-4">New Package</h3>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
              <input
                value={newPkg.name}
                onChange={(e) => setNewPkg({ ...newPkg, name: e.target.value })}
                placeholder="e.g. Starter"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Minutes</label>
              <input
                type="number"
                value={newPkg.minutes}
                onChange={(e) => setNewPkg({ ...newPkg, minutes: e.target.value })}
                placeholder="30"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Price ($)</label>
              <input
                type="number"
                step="0.01"
                value={newPkg.price}
                onChange={(e) => setNewPkg({ ...newPkg, price: e.target.value })}
                placeholder="15.00"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
              <input
                value={newPkg.description}
                onChange={(e) => setNewPkg({ ...newPkg, description: e.target.value })}
                placeholder="Optional description"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={saving === 'new'}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm disabled:opacity-50"
            >
              {saving === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Create
            </button>
          </div>
        </div>
      )}

      {/* Package list */}
      <div className="bg-white rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Package</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Minutes</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Price</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">$/Min</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Cost</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Profit</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {packages.map((pkg) => {
              const perMin = pkg.price / pkg.minutes;
              const cost = pkg.minutes * costPerMinute;
              const profit = pkg.price - cost;
              const margin = (profit / pkg.price) * 100;
              const isEditing = editId === pkg.id;

              return (
                <tr key={pkg.id} className={!pkg.is_active ? 'bg-gray-50 opacity-60' : ''}>
                  <td className="px-6 py-4">
                    {isEditing ? (
                      <input
                        value={editValues.name ?? pkg.name}
                        onChange={(e) => setEditValues({ ...editValues, name: e.target.value })}
                        className="w-full rounded border px-2 py-1 text-sm"
                      />
                    ) : (
                      <div>
                        <div className="font-medium">{pkg.name}</div>
                        {pkg.description && <div className="text-xs text-gray-500">{pkg.description}</div>}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {isEditing ? (
                      <input
                        type="number"
                        value={editValues.minutes ?? pkg.minutes}
                        onChange={(e) => setEditValues({ ...editValues, minutes: parseInt(e.target.value) })}
                        className="w-20 rounded border px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className="font-medium">{pkg.minutes}</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        value={editValues.price ?? pkg.price}
                        onChange={(e) => setEditValues({ ...editValues, price: parseFloat(e.target.value) })}
                        className="w-24 rounded border px-2 py-1 text-sm"
                      />
                    ) : (
                      <span className="font-semibold">{formatCurrency(pkg.price)}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-sm text-gray-600">{formatCurrency(perMin)}</td>
                  <td className="px-6 py-4 text-sm text-red-600">{formatCurrency(cost)}</td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-medium ${margin >= 30 ? 'text-green-600' : margin >= 15 ? 'text-yellow-600' : 'text-red-600'}`}>
                      {formatCurrency(profit)} ({margin.toFixed(0)}%)
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleToggle(pkg)}
                      disabled={saving === pkg.id}
                      className="text-gray-500 hover:text-gray-700"
                    >
                      {pkg.is_active ? (
                        <ToggleRight className="w-6 h-6 text-green-600" />
                      ) : (
                        <ToggleLeft className="w-6 h-6 text-gray-400" />
                      )}
                    </button>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      {isEditing ? (
                        <>
                          <button
                            onClick={() => handleSave(pkg.id)}
                            disabled={saving === pkg.id}
                            className="p-1.5 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                          >
                            {saving === pkg.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => { setEditId(null); setEditValues({}); }}
                            className="p-1.5 rounded bg-gray-200 text-gray-600 hover:bg-gray-300 text-xs"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => { setEditId(pkg.id); setEditValues({}); }}
                          className="text-sm text-blue-600 hover:underline"
                        >
                          Edit
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Pricing guide */}
      <div className="bg-blue-50 rounded-xl border border-blue-200 p-4">
        <h4 className="font-medium text-blue-900 mb-1">Pricing Guide</h4>
        <p className="text-sm text-blue-700">
          Estimated cost per minute: {formatCurrency(costPerMinute)} (worker $0.167 + phone $0.02 + overhead $0.05).
          Aim for 30%+ profit margin on each package. The IVR will read package names and prices to callers over the phone.
        </p>
      </div>
    </div>
  );
}
