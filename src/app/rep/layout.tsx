import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import Sidebar from '@/components/layout/sidebar';

export default async function RepLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect('/login');

  const role = (user.app_metadata?.role as 'admin' | 'rep') || 'rep';
  const userName = user.email || 'User';

  return (
    <div className="flex min-h-screen">
      <Sidebar role="rep" userName={userName} />
      <main className="flex-1 bg-gray-50 overflow-auto">
        <div className="p-6">{children}</div>
      </main>
    </div>
  );
}
