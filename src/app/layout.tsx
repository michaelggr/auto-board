import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = { title: 'auto-board 自动化看板' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
