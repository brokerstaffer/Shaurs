import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'BrokerStaffer — Client Health',
  description: 'Live client outreach health from Instantly + MasterInbox',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
