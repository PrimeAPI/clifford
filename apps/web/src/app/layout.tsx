import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Clifford',
  description: 'Autonomous agent platform',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: '20px', fontFamily: 'sans-serif' }}>{children}</body>
    </html>
  );
}
