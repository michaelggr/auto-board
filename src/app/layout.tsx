import type { Metadata } from 'next';
import './globals.css';
import { StatusProvider, TokenGate, Nav, StatusBanner } from '@/components/Status';

export const metadata: Metadata = { title: 'auto-board 自动化看板' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <StatusProvider>
          <TokenGate>
            <Nav />
            <StatusBanner />
            <main style={{ padding: '16px 24px' }}>{children}</main>
          </TokenGate>
        </StatusProvider>
      </body>
    </html>
  );
}
