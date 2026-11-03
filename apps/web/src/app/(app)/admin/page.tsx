'use client';

import { Copy, Cpu, Laptop, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { ErrorState, PageHeader } from '@/components/common';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmButton, Input, Label, Select, Skeleton } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/session';
import { formatBytes, formatDate, relativeTime } from '@/lib/utils';

interface AdminUser { id: string; email: string; name: string; role: 'USER' | 'ADMIN'; disabled: boolean; storageUsedBytes: string | number; storageQuotaBytes: string | number; createdAt: string; _count: { projects: number } }
interface Worker { role: string; device: string; busy: number; id?: string; processed?: number; model?: string; llm?: string | null; at?: number }
interface CaptureAgent { id: string; name: string; tokenPrefix: string; createdAt: string; lastSeenAt: string | null; online: boolean }
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

        <CaptureAgents />

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Users className="size-4" /> Usuarios</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <CreateUser onCreated={() => mutate()} />
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

/** Alta de usuarios por el administrador (no depende de que el registro público esté abierto). */
function CreateUser({ onCreated }: { onCreated: () => Promise<unknown> }) {
  const empty = { name: '', email: '', password: '', role: 'USER' as 'USER' | 'ADMIN', quotaGb: '' };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const set = (k: keyof typeof empty, v: string) => setForm((f) => ({ ...f, [k]: v }));

  async function submit() {
    if (form.password && form.password.length < 10) return toast.error('La contraseña debe tener al menos 10 caracteres');
    setBusy(true);
    try {
      const res = await api<{ user: { email: string }; generatedPassword: string | null }>('/admin/users', {
        method: 'POST',
        json: {
          name: form.name.trim(), email: form.email.trim(), role: form.role,
          password: form.password || undefined,
          quotaGb: form.quotaGb ? Number(form.quotaGb) : undefined,
        },
      });
      if (res.generatedPassword) setCreated({ email: res.user.email, password: res.generatedPassword });
      toast.success(`Usuario ${res.user.email} creado`);
      setForm(empty);
      setOpen(false);
      await onCreated();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear el usuario');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      {!open && <Button type="button" variant="outline" onClick={() => { setOpen(true); setCreated(null); }}><UserPlus className="size-4" /> Nuevo usuario</Button>}
      {open && (
        <form className="space-y-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor="nu-name">Nombre</Label><Input id="nu-name" required minLength={2} maxLength={80} value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
            <div className="space-y-1"><Label htmlFor="nu-email">Correo</Label><Input id="nu-email" type="email" required maxLength={254} autoComplete="off" value={form.email} onChange={(e) => set('email', e.target.value)} /></div>
            <div className="space-y-1">
              <Label htmlFor="nu-pass">Contraseña</Label>
              <Input id="nu-pass" type="password" minLength={10} maxLength={200} autoComplete="new-password" placeholder="Vacía = generar una aleatoria" value={form.password} onChange={(e) => set('password', e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="nu-role">Rol</Label>
                <Select id="nu-role" value={form.role} onChange={(e) => set('role', e.target.value)}>
                  <option value="USER">Usuario</option><option value="ADMIN">Administrador</option>
                </Select>
              </div>
              <div className="space-y-1"><Label htmlFor="nu-quota">Cuota (GB)</Label><Input id="nu-quota" type="number" min={1} max={100000} placeholder="Por defecto" value={form.quotaGb} onChange={(e) => set('quotaGb', e.target.value)} /></div>
            </div>
          </div>
          <div className="flex gap-2">
            <Button type="submit" loading={busy}>Crear usuario</Button>
            <Button type="button" variant="ghost" onClick={() => { setOpen(false); setForm(empty); }}>Cancelar</Button>
          </div>
        </form>
      )}
      {created && (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          <p className="font-medium">Contraseña generada para {created.email}. Cópiala ahora: no se volverá a mostrar.</p>
          <div className="flex gap-2">
            <Input readOnly value={created.password} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="secondary" onClick={() => { void navigator.clipboard.writeText(created.password).then(() => toast.success('Contraseña copiada')); }}><Copy className="size-4" /> Copiar</Button>
          </div>
          <p className="text-xs text-muted-foreground">El usuario puede cambiarla luego desde Ajustes.</p>
          <Button type="button" size="sm" variant="ghost" onClick={() => setCreated(null)}>Ya la guardé</Button>
        </div>
      )}
    </div>
  );
}

/** Capturadores remotos: PCs que descargan los enlaces de YouTube con su propia conexión. */
function CaptureAgents() {
  const { data: agents, error, mutate } = useSWR<CaptureAgent[]>('/admin/capture-agents', { refreshInterval: 15_000 });
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState<string | null>(null);

  async function create() {
    setCreating(true);
    try {
      const res = await api<{ token: string }>('/admin/capture-agents', { method: 'POST', json: { name: name.trim() || 'Mi PC' } });
      setToken(res.token);
      setName('');
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear el capturador');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string) {
    try {
      await api(`/admin/capture-agents/${id}`, { method: 'DELETE' });
      await mutate();
      toast.success('Token revocado');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo revocar');
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Laptop className="size-4" /> Capturadores</CardTitle>
        <CardDescription>
          YouTube bloquea las descargas desde servidores. Un capturador en tu PC descarga esos enlaces con tu conexión y entrega el video aquí.
          Ejecuta <code className="rounded bg-muted px-1">scripts\iniciar-capturador.ps1</code> y pega el token la primera vez.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <Input placeholder="Nombre (ej. PC de casa)" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" loading={creating}>Crear token</Button>
        </form>
        {token && (
          <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
            <p className="font-medium">Copia el token ahora: no se volverá a mostrar.</p>
            <div className="flex gap-2">
              <Input readOnly value={token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="secondary" onClick={() => { void navigator.clipboard.writeText(token).then(() => toast.success('Token copiado')); }}><Copy className="size-4" /> Copiar</Button>
            </div>
            <Button type="button" size="sm" variant="ghost" onClick={() => setToken(null)}>Ya lo guardé</Button>
          </div>
        )}
        {error && <ErrorState message={error.message} />}
        {!agents ? <Skeleton className="h-16" /> : agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aún no hay capturadores.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="py-1.5">Nombre</th><th>Estado</th><th>Última conexión</th><th>Token</th><th /></tr></thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.id} className="border-t">
                    <td className="py-2 font-medium">{a.name}</td>
                    <td>{a.online ? <Badge variant="success">Conectado</Badge> : <Badge variant="secondary">Desconectado</Badge>}</td>
                    <td className="text-xs">{a.lastSeenAt ? relativeTime(a.lastSeenAt) : 'Nunca'}</td>
                    <td className="font-mono text-xs">{a.tokenPrefix}…</td>
                    <td className="text-right">
                      <ConfirmButton size="sm" variant="ghost" title="Revocar token" description={`El capturador «${a.name}» dejará de poder conectarse.`} confirmLabel="Revocar" onConfirm={() => revoke(a.id)}>Revocar</ConfirmButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
