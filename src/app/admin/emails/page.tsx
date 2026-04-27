import EmailInbox from '@/components/rep/email-inbox';

export default function AdminEmailsPage() {
  return (
    <EmailInbox
      title="Email activity"
      description="All inbound and outbound customer-mailbox messages across the platform."
    />
  );
}
