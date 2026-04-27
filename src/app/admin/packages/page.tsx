'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Package, Plus, Save, Loader2, Trash2, ToggleLeft, ToggleRight } from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';
import { PageHeader } from '@/components/ui/page';
import { Button } from '@/components/ui/button';
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
        <Loader2 className="w-8 h-8 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Package />}
        title="Minute Packages"
        description="Pricing tiers customers can purchase for phone time."
        actions={
          <Button variant="accent" onClick={() => setShowAdd(!showAdd)}>
            <Plus /> Add Package
          </Button>
        }
      />

      {/* Add new package form */}
      {showAdd && (
        <div className="bg-card rounded-xl shadow-sm border p-6">
          <h3 className="font-semibold mb-4">New Package</h3>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Name</label>
              <input
                value={newPkg.name}
                onChange={(e) => setNewPkg({ ...newPkg, name: e.target.value })}
                placeholder="e.g. Starter"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Minutes</label>
              <input
                type="number"
                value={newPkg.minutes}
                onChange={(e) => setNewPkg({ ...newPkg, minutes: e.target.value })}
                placeholder="30"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Price ($)</label>
              <input
                type="number"
                step="0.01"
                value={newPkg.price}
                onChange={(e) => setNewPkg({ ...newPkg, price: e.target.value })}
                placeholder="15.00"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground mb-1">Description</label>
              <input
                value={newPkg.description}
                onChange={(e) => setNewPkg({ ...newPkg, description: e.target.value })}
                placeholder="Optional description"
                className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground">
              Cancel
            </button>
            <button
              onClick={handleAdd}
              disabled={saving === 'new'}
              className="flex items-center gap-2 px-4 py-2 bg-accent text-white rounded-lg hover:bg-accent/90 text-sm disabled:opacity-50"
            >
              {saving === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Create
            </button>
          </div>
        </div>
      )}

      {/* Package list */}
      <div className="bg-card rounded-xl shadow-sm border overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Package</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Minutes</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Price</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">$/Min</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Cost</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Profit</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-semibold text-muted-foreground uppercase">Actions</th>
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
                <tr key={pkg.id} className={!pkg.is_active ? 'bg-muted/40 opacity-60' : ''}>
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
                        {pkg.description && <div className="text-xs text-muted-foreground">{pkg.description}</div>}
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
                  <td className="px-6 py-4 text-sm text-muted-foreground">{formatCurrency(perMin)}</td>
                  <td className="px-6 py-4 text-sm text-destructive">{formatCurrency(cost)}</td>
                  <td className="px-6 py-4">
                    <span className={`text-sm font-medium ${margin >= 30 ? 'text-success' : margin >= 15 ? 'text-warning' : 'text-destructive'}`}>
                      {formatCurrency(profit)} ({margin.toFixed(0)}%)
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <button
                      onClick={() => handleToggle(pkg)}
                      disabled={saving === pkg.id}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      {pkg.is_active ? (
                        <ToggleRight className="w-6 h-6 text-success" />
                      ) : (
                        <ToggleLeft className="w-6 h-6 text-muted-foreground/80" />
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
                            className="p-1.5 rounded bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
                          >
                            {saving === pkg.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => { setEditId(null); setEditValues({}); }}
                            className="p-1.5 rounded bg-muted text-muted-foreground hover:bg-muted text-xs"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => { setEditId(pkg.id); setEditValues({}); }}
                          className="text-sm text-accent hover:underline"
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
      <div className="bg-accent/10 rounded-xl border border-accent/30 p-4">
        <h4 className="font-medium text-accent mb-1">Pricing Guide</h4>
        <p className="text-sm text-accent">
          Estimated cost per minute: {formatCurrency(costPerMinute)} (worker $0.167 + phone $0.02 + overhead $0.05).
          Aim for 30%+ profit margin on each package. The IVR will read package names and prices to callers over the phone.
        </p>
      </div>
    </div>
  );
}
