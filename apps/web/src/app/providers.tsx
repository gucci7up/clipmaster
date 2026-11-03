'use client';

import { ThemeProvider } from 'next-themes';
import { Toaster } from 'sonner';
import { SWRConfig } from 'swr';
import { fetcher } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <SWRConfig value={{ fetcher, revalidateOnFocus: true, dedupingInterval: 1000 }}>
        {children}
        <Toaster richColors position="top-right" closeButton />
      </SWRConfig>
    </ThemeProvider>
  );
}
