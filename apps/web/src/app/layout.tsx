import type { Metadata } from 'next';
import { Providers } from './providers';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'ClipMaster AI', template: '%s · ClipMaster AI' },
  description: 'Clips automáticos con inteligencia artificial a partir de tus videos y transmisiones.',
};

// Fuente del sistema: el build no depende de descargar fuentes externas.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning>
      <body className="min-h-screen font-sans">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
