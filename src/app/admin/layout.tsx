import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Sidebar from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const role = user.app_metadata?.role as string;
  if (role !== 'admin') redirect('/rep');

  const userName = user.email || 'Admin';

  return (
    <div className="flex min-h-screen bg-background">
      <Sidebar role="admin" userName={userName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar role="admin" />
        <main className="flex-1 overflow-auto">
          <div className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
