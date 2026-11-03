'use client';

import { usePathname, useRouter } from 'next/navigation';
import * as React from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { toast } from 'sonner';
import { api, AppEvent, User } from './api';

interface SessionCtx {
  user: User | null;
  loading: boolean;
  refresh: () => Promise<unknown>;
  logout: () => Promise<void>;
  lastEvent: AppEvent | null;
  connected: boolean;
}

const Ctx = React.createContext<SessionCtx | null>(null);

export function useSession() {
  const v = React.useContext(Ctx);
  if (!v) throw new Error('useSession fuera de SessionProvider');
  return v;
}

/** Eventos SSE de un proyecto concreto (o de todos si no se indica). */
export function useProjectEvents(projectId: string | undefined, handler: (e: AppEvent) => void) {
  const { lastEvent } = useSession();
  const ref = React.useRef(handler);
  ref.current = handler;
  React.useEffect(() => {
    if (lastEvent && (!projectId || lastEvent.projectId === projectId)) ref.current(lastEvent);
  }, [lastEvent, projectId]);
}

const NOTIFY = new Set(['project.completed', 'project.failed', 'clip.ready', 'capture.ended']);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { mutate } = useSWRConfig();
  const { data, isLoading, mutate: refresh } = useSWR<{ user: User }>('/auth/me', (p: string) => api(p), {
    shouldRetryOnError: false,
    revalidateOnFocus: false,
  });
  const user = data?.user ?? null;
  const [lastEvent, setLastEvent] = React.useState<AppEvent | null>(null);
  const [connected, setConnected] = React.useState(false);

  React.useEffect(() => {
    if (!isLoading && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [isLoading, user, router, pathname]);

  // Progreso en tiempo real por Server-Sent Events (reconexión automática del navegador).
  React.useEffect(() => {
    if (!user) return;
    const es = new EventSource('/api/events', { withCredentials: true });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as AppEvent;
        if (!ev.projectId) return;
        setLastEvent(ev);
        // Revalida las vistas afectadas con datos reales de la API.
        void mutate((key) => typeof key === 'string' && (key.startsWith('/projects') || key.startsWith('/stats') || key.startsWith('/clips')));
        if (NOTIFY.has(ev.type) && ev.message) {
          if (ev.type === 'project.failed') toast.error(ev.message);
          else toast.success(ev.message);
        }
      } catch {
        /* ignorar mensajes no JSON (heartbeat) */
      }
    };
    return () => es.close();
  }, [user, mutate]);

  const logout = React.useCallback(async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    await refresh(undefined, { revalidate: false });
    router.replace('/login');
  }, [refresh, router]);

  return <Ctx.Provider value={{ user, loading: isLoading, refresh, logout, lastEvent, connected }}>{children}</Ctx.Provider>;
}
