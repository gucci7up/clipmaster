'use client';

import { Film, FolderKanban, Home, LogOut, Menu, Moon, Plus, Scissors, Settings, Shield, Sun, Wifi, WifiOff, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { Button, Skeleton } from './ui';

const NAV = [
  { href: '/', label: 'Inicio', icon: Home },
  { href: '/proyectos/nuevo', label: 'Nuevo proyecto', icon: Plus },
  { href: '/proyectos', label: 'Mis proyectos', icon: FolderKanban },
  { href: '/clips', label: 'Clips generados', icon: Film },
  { href: '/ajustes', label: 'Ajustes', icon: Settings },
];

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="size-9" />;
  return (
    <Button variant="ghost" size="icon" aria-label="Cambiar tema" onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
      {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
    </Button>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { user } = useSession();
  const items = user?.role === 'ADMIN' ? [...NAV, { href: '/admin', label: 'Administración', icon: Shield }] : NAV;
  return (
    <nav className="flex flex-col gap-1">
      {items.map(({ href, label, icon: Icon }) => {
        const active = href === '/' ? pathname === '/' : pathname === href || (pathname.startsWith(href + '/') && !(href === '/proyectos' && pathname === '/proyectos/nuevo'));
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, loading, logout, connected } = useSession();
  const [open, setOpen] = useState(false);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen">
        <div className="hidden w-64 border-r bg-sidebar p-4 md:block"><Skeleton className="h-8 w-40" /></div>
        <div className="flex-1 space-y-4 p-8"><Skeleton className="h-8 w-64" /><Skeleton className="h-40 w-full" /></div>
      </div>
    );
  }

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-4">
      <Link href="/" className="flex items-center gap-2 px-2 text-lg font-semibold">
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground"><Scissors className="size-4" /></span>
        ClipMaster AI
      </Link>
      <NavLinks onNavigate={() => setOpen(false)} />
      <div className="mt-auto space-y-3 border-t pt-4">
        <div className="px-2">
          <p className="truncate text-sm font-medium">{user.name}</p>
          <p className="truncate text-xs text-muted-foreground">{user.email}</p>
        </div>
        <Button variant="ghost" className="w-full justify-start text-muted-foreground" onClick={() => void logout()}>
          <LogOut /> Cerrar sesión
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-sidebar md:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 border-r bg-sidebar">{sidebar}</aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/80 px-4 backdrop-blur md:px-8">
          <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setOpen(!open)} aria-label="Menú">
            {open ? <X /> : <Menu />}
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <span
              className={cn('flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs', connected ? 'text-success' : 'text-muted-foreground')}
              title={connected ? 'Actualizaciones en tiempo real activas' : 'Sin conexión en tiempo real'}
            >
              {connected ? <Wifi className="size-3.5" /> : <WifiOff className="size-3.5" />}
              <span className="hidden sm:inline">{connected ? 'En vivo' : 'Desconectado'}</span>
            </span>
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
