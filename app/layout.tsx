import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import '../variables.css';
import './globals.css';

const inter = Inter({
  subsets: ['latin', 'vietnamese'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'CodeGrid Preview Gallery',
  description: 'Browse CodeGrid downloads · preview HTML via Service Worker',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={inter.variable}>
      <body>
        {children}
        {/* JSZip global, used by lib/zip.ts */}
        <script src="/jszip.min.js" async={false} defer={false} />
      </body>
    </html>
  );
}
