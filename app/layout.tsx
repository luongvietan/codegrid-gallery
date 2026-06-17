import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CodeGrid Preview Gallery',
  description: 'Browse CodeGrid downloads · preview HTML via Service Worker',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body>
        {children}
        {/* JSZip global, used by lib/zip.ts */}
        <script src="/jszip.min.js" async={false} defer={false} />
      </body>
    </html>
  );
}
