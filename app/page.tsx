import Dashboard from './Dashboard';
import { loadDashboardClients } from '@/lib/loadDashboard';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const { clients, allInstantlyCampaigns, source, error } = await loadDashboardClients();
  if (error) {
    console.warn(`[dashboard] Falling back to ${source}:`, error);
  }
  return (
    <Dashboard
      initialClients={clients}
      allInstantlyCampaigns={allInstantlyCampaigns}
      dataSource={source}
    />
  );
}
