'use client';

import { useEffect, useState } from 'react';
import { formatDateTime } from '@/lib/utils';
import { toast } from 'sonner';
import {
  Users,
  Plus,
  Shield,
  Phone,
  Loader2,
  Trash2,
  KeyRound,
  X,
  Eye,
  EyeOff,
  Pencil,
} from 'lucide-react';
import { edgeFn } from '@/lib/supabase/edge';

interface AppUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
  last_sign_in_at: string | null;
  rep: {
    full_name: string;
    phone_extension: string | null;
    phone_e164: string | null;
    sip_uri: string | null;
    status: string;
  } | null;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Reset password modal
  const [resetTarget, setResetTarget] = useState<AppUser | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  const [form, setForm] = useState({
    email: '',
    password: '',
    fullName: '',
    role: 'rep' as 'admin' | 'rep',
    phoneExtension: '',
    phoneE164: '',
    sipUri: '',
  });

  // Edit rep modal
  const [editTarget, setEditTarget] = useState<AppUser | null>(null);
  const [editForm, setEditForm] = useState({ fullName: '', phoneExtension: '', phoneE164: '', sipUri: '' });
  const [savingEdit, setSavingEdit] = useState(false);

  const fetchUsers = async () => {
    try {
      const res = await edgeFn('admin-users');
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      } else {
        toast.error('Failed to load users');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const handleCreate = async () => {
    if (!form.email || !form.password || !form.fullName) {
      toast.error('Email, password, and name are required');
      return;
    }
    if (form.password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setCreating(true);
    try {
      const res = await edgeFn('admin-users', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      if (res.ok) {
        toast.success(`${form.role === 'admin' ? 'Admin' : 'Rep'} "${form.fullName}" created`);
        setShowCreate(false);
        setForm({ email: '', password: '', fullName: '', role: 'rep', phoneExtension: '', phoneE164: '', sipUri: '' });
        setShowPassword(false);
        fetchUsers();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to create user');
      }
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (user: AppUser) => {
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) return;
    const res = await edgeFn('admin-users', { method: 'DELETE', params: { id: user.id } });
    if (res.ok) {
      toast.success('User deleted');
      setUsers(users.filter((u) => u.id !== user.id));
    } else {
      const data = await res.json();
      toast.error(data.error || 'Failed to delete user');
    }
  };

  const handleResetPassword = async () => {
    if (!resetTarget || !newPassword) return;
    if (newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setResetting(true);
    try {
      const res = await edgeFn('admin-users', {
        method: 'PATCH',
        body: JSON.stringify({ id: resetTarget.id, resetPassword: newPassword }),
      });
      if (res.ok) {
        toast.success(`Password reset for ${resetTarget.email}`);
        setResetTarget(null);
        setNewPassword('');
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to reset password');
      }
    } finally {
      setResetting(false);
    }
  };

  const openEdit = (user: AppUser) => {
    setEditTarget(user);
    setEditForm({
      fullName: user.rep?.full_name || '',
      phoneExtension: user.rep?.phone_extension || '',
      phoneE164: user.rep?.phone_e164 || '',
      sipUri: user.rep?.sip_uri || '',
    });
  };

  const handleSaveEdit = async () => {
    if (!editTarget) return;
    if (editForm.phoneE164 && !/^\+[1-9][0-9]{6,14}$/.test(editForm.phoneE164)) {
      toast.error('Phone must be E.164 format, e.g. +14155551234');
      return;
    }
    setSavingEdit(true);
    try {
      const res = await edgeFn('admin-users', {
        method: 'PATCH',
        body: JSON.stringify({
          id: editTarget.id,
          fullName: editForm.fullName,
          phoneExtension: editForm.phoneExtension,
          phoneE164: editForm.phoneE164,
          sipUri: editForm.sipUri,
        }),
      });
      if (res.ok) {
        toast.success('Rep updated');
        setEditTarget(null);
        fetchUsers();
      } else {
        const data = await res.json();
        toast.error(data.error || 'Failed to save');
      }
    } finally {
      setSavingEdit(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  const admins = users.filter((u) => u.role === 'admin');
  const reps = users.filter((u) => u.role === 'rep');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold flex items-center gap-2">
          <Users className="w-5 h-5" />
          User Management
        </h2>
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition"
        >
          <Plus className="w-4 h-4" />
          Add User
        </button>
      </div>

      {/* Create User Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-lg font-semibold">Create New User</h3>
              <button onClick={() => { setShowCreate(false); setShowPassword(false); }} className="p-1 rounded hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4">
              {/* Role selector */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setForm({ ...form, role: 'admin' })}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                      form.role === 'admin'
                        ? 'bg-purple-50 border-purple-300 text-purple-700'
                        : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <Shield className="w-4 h-4 inline mr-1" />
                    Admin
                  </button>
                  <button
                    onClick={() => setForm({ ...form, role: 'rep' })}
                    className={`flex-1 py-2 rounded-lg text-sm font-medium border transition ${
                      form.role === 'rep'
                        ? 'bg-blue-50 border-blue-300 text-blue-700'
                        : 'bg-white border-gray-300 text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    <Phone className="w-4 h-4 inline mr-1" />
                    Rep
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input
                  value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                  placeholder="John Smith"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  placeholder="john@company.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    placeholder="Min 6 characters"
                    className="w-full px-3 py-2 pr-10 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-gray-400 hover:text-gray-600"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {form.role === 'rep' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Phone Extension <span className="text-gray-400">(optional)</span>
                    </label>
                    <input
                      value={form.phoneExtension}
                      onChange={(e) => setForm({ ...form, phoneExtension: e.target.value })}
                      placeholder="101"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Dial-out Phone <span className="text-gray-400">(E.164 format)</span>
                    </label>
                    <input
                      value={form.phoneE164}
                      onChange={(e) => setForm({ ...form, phoneE164: e.target.value })}
                      placeholder="+14155551234"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                    <p className="text-xs text-gray-500 mt-1">Calls will ring this number when assigned.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      SIP URI <span className="text-gray-400">(optional, overrides phone)</span>
                    </label>
                    <input
                      value={form.sipUri}
                      onChange={(e) => setForm({ ...form, sipUri: e.target.value })}
                      placeholder="sip:user@accuinfo.signalwire.com"
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                    />
                    <p className="text-xs text-gray-500 mt-1">For deskphones or softphones (Zoiper, Linphone). Free audio — no PSTN charge.</p>
                  </div>
                </>
              )}

              <button
                onClick={handleCreate}
                disabled={creating}
                className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition disabled:opacity-50"
              >
                {creating ? 'Creating...' : `Create ${form.role === 'admin' ? 'Admin' : 'Rep'}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Rep Modal */}
      {editTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-md mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Edit Rep</h3>
              <button onClick={() => setEditTarget(null)} className="p-1 rounded hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">{editTarget.email}</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input
                  value={editForm.fullName}
                  onChange={(e) => setEditForm({ ...editForm, fullName: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Phone Extension</label>
                <input
                  value={editForm.phoneExtension}
                  onChange={(e) => setEditForm({ ...editForm, phoneExtension: e.target.value })}
                  placeholder="101"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Dial-out Phone <span className="text-gray-400">(E.164)</span>
                </label>
                <input
                  value={editForm.phoneE164}
                  onChange={(e) => setEditForm({ ...editForm, phoneE164: e.target.value })}
                  placeholder="+14155551234"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                <p className="text-xs text-gray-500 mt-1">Cell or landline to ring when a call is assigned.</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  SIP URI <span className="text-gray-400">(optional, preferred)</span>
                </label>
                <input
                  value={editForm.sipUri}
                  onChange={(e) => setEditForm({ ...editForm, sipUri: e.target.value })}
                  placeholder="sip:user@accuinfo.signalwire.com"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
                <p className="text-xs text-gray-500 mt-1">For deskphone/softphone. Overrides the phone number if set.</p>
              </div>
              <button
                onClick={handleSaveEdit}
                disabled={savingEdit}
                className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition disabled:opacity-50"
              >
                {savingEdit ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl p-6 w-full max-w-sm mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold">Reset Password</h3>
              <button onClick={() => { setResetTarget(null); setNewPassword(''); }} className="p-1 rounded hover:bg-gray-100">
                <X className="w-5 h-5" />
              </button>
            </div>
            <p className="text-sm text-gray-600 mb-4">
              Set a new password for <strong>{resetTarget.email}</strong>
            </p>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password (min 6 chars)"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm mb-4 focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
            />
            <button
              onClick={handleResetPassword}
              disabled={resetting}
              className="w-full py-2.5 bg-blue-600 text-white rounded-lg font-medium text-sm hover:bg-blue-700 transition disabled:opacity-50"
            >
              {resetting ? 'Resetting...' : 'Reset Password'}
            </button>
          </div>
        </div>
      )}

      {/* Admins Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Shield className="w-4 h-4" />
          Admins ({admins.length})
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {admins.map((user) => (
            <div key={user.id} className="bg-white rounded-xl shadow-sm border p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-purple-100 rounded-full flex items-center justify-center">
                    <Shield className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <div className="font-medium">
                      {user.rep?.full_name || user.email.split('@')[0]}
                    </div>
                    <div className="text-xs text-gray-500">{user.email}</div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t">
                <span className="text-xs text-gray-400">
                  Joined {formatDateTime(user.created_at)}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setResetTarget(user)}
                    className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                    title="Reset password"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(user)}
                    className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                    title="Delete user"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reps Section */}
      <div>
        <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Phone className="w-4 h-4" />
          Representatives ({reps.length})
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {reps.map((user) => (
            <div key={user.id} className="bg-white rounded-xl shadow-sm border p-5">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center">
                    <Phone className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <div className="font-medium">{user.rep?.full_name || user.email}</div>
                    <div className="text-xs text-gray-500">{user.email}</div>
                  </div>
                </div>
              </div>
              <div className="flex items-center justify-between">
                {user.rep && (
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2.5 h-2.5 rounded-full ${
                        user.rep.status === 'available'
                          ? 'bg-green-500'
                          : user.rep.status === 'on_call'
                          ? 'bg-yellow-500'
                          : user.rep.status === 'busy'
                          ? 'bg-red-500'
                          : 'bg-gray-400'
                      }`}
                    />
                    <span className="text-sm capitalize text-gray-600">
                      {user.rep.status.replace('_', ' ')}
                    </span>
                  </div>
                )}
                {user.rep?.phone_extension && (
                  <span className="text-xs text-gray-500">
                    Ext. {user.rep.phone_extension}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-between mt-3 pt-3 border-t">
                <span className="text-xs text-gray-400">
                  {user.last_sign_in_at
                    ? `Last login ${formatDateTime(user.last_sign_in_at)}`
                    : 'Never signed in'}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => openEdit(user)}
                    className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                    title="Edit rep"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setResetTarget(user)}
                    className="p-1.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                    title="Reset password"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(user)}
                    className="p-1.5 rounded hover:bg-red-50 text-gray-400 hover:text-red-600"
                    title="Delete user"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          ))}
          {reps.length === 0 && (
            <div className="col-span-full text-center py-8 text-gray-500 text-sm">
              No reps yet. Click &quot;Add User&quot; to create one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
