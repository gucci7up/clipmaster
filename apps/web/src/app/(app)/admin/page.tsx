'use client';

import { Cpu, ShieldCheck, Users } from 'lucide-react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { ErrorState, PageHeader } from '@/components/common';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatBytes, formatDate } from '@/lib/utils';

interface AdminUser { id: string; email: string; name: string; role: 'USER' | 'ADMIN'; disabled: boolean; storageUsedBytes: string | number; storageQuotaBytes: string | number; createdAt: string; _count: { projects: number } }
interface Worker { role: string; device: string; busy: number; id?: string; processed?: number; model?: string; llm?: string | null; at?: number }
interface SystemInfo { queues: Record<string, Record<string, number>>; workers: Worker[] }

export default function AdminPage() {
  const { user } = useSession();
  const isAdmin = user?.role === 'ADMIN';
  const { data: users, error, mutate } = useSWR<AdminUser[]>(isAdmin ? '/admin/users' : null);
  const { data: sys } = useSWR<SystemInfo>(isAdmin ? '/health/system' : null, { refreshInterval: 10_000 });

  if (user && !isAdmin) return <ErrorState message="Sólo los administradores pueden ver esta sección." />;

  async function patch(id: string, body: Record<string, unknown>) {
    try {
      await api(`/admin/users/${id}`, { method: 'PATCH', json: body });
      await mutate();
      toast.success('Usuario actualizado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo actualizar');
    }
  }

  return (
    <>
      <PageHeader title="Administración" description="Usuarios, colas y workers" />
      <div className="space-y-6">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Cpu className="size-4" /> Sistema</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {!sys ? <Skeleton className="h-24" /> : (
              <>
                <div className="grid gap-3 sm:grid-cols-3">
                  {Object.entries(sys.queues).map(([q, c]) => (
                    <div key={q} className="rounded-lg border p-3 text-sm">
                      <p className="font-medium capitalize">Cola {q}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {c.active ?? 0} activos · {c.waiting ?? 0} en espera · {c.delayed ?? 0} diferidos · {c.failed ?? 0} fallidos
                      </p>
                    </div>
                  ))}
                </div>
                {sys.workers.length === 0 ? <ErrorState message="No hay workers conectados. Revisa los contenedores capture/ai/render." /> : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5">Rol</th><th>ID</th><th>Dispositivo</th><th>Whisper</th><th>LLM</th><th>Ocupado</th><th>Procesados</th></tr></thead>
                      <tbody>
                        {sys.workers.map((w, i) => (
                          <tr key={w.id ?? i} className="border-t">
                            <td className="py-1.5 font-medium">{w.role}</td><td className="font-mono text-xs">{w.id ?? '—'}</td>
                            <td><Badge variant={w.device === 'cuda' ? 'success' : 'secondary'}>{w.device}</Badge></td>
                            <td>{w.role === 'ai' || w.role === 'all' ? w.model ?? '—' : '—'}</td><td className="text-xs">{w.llm ?? '—'}</td><td>{w.busy}</td><td>{w.processed ?? 0}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Users className="size-4" /> Usuarios</CardTitle></CardHeader>
          <CardContent>
            {error && <ErrorState message={error.message} />}
            {!users ? <Skeleton className="h-32" /> : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5">Usuario</th><th>Rol</th><th>Proyectos</th><th>Almacenamiento</th><th>Alta</th><th /></tr></thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.id} className="border-t">
                        <td className="py-2"><p className="font-medium">{u.name}</p><p className="text-xs text-muted-foreground">{u.email}</p></td>
                        <td>{u.role === 'ADMIN' ? <Badge><ShieldCheck className="size-3" /> Admin</Badge> : <Badge variant="secondary">Usuario</Badge>}{u.disabled && <Badge variant="destructive" className="ml-1">Desactivado</Badge>}</td>
                        <td>{u._count.projects}</td>
                        <td className="text-xs">{formatBytes(Number(u.storageUsedBytes))} / {formatBytes(Number(u.storageQuotaBytes))}</td>
                        <td className="text-xs">{formatDate(u.createdAt)}</td>
                        <td className="space-x-1 whitespace-nowrap text-right">
                          {u.id !== user?.id && (
                            <>
                              <Button size="sm" variant="ghost" onClick={() => patch(u.id, { role: u.role === 'ADMIN' ? 'USER' : 'ADMIN' })}>{u.role === 'ADMIN' ? 'Quitar admin' : 'Hacer admin'}</Button>
                              <Button size="sm" variant="ghost" onClick={() => patch(u.id, { disabled: !u.disabled })}>{u.disabled ? 'Activar' : 'Desactivar'}</Button>
                            </>
                          )}
                          <Button size="sm" variant="ghost" onClick={() => {
                            const v = window.prompt('Nueva cuota en GB', String(Math.round(Number(u.storageQuotaBytes) / 1024 ** 3)));
                            const n = Number(v);
                            if (v && Number.isInteger(n) && n > 0) void patch(u.id, { quotaGb: n });
                          }}>Cuota</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
