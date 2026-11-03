'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Label } from '@/components/ui';

function ResetForm() {
  const token = useSearchParams().get('token') ?? '';
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/auth/reset-password', { method: 'POST', json: { token, password: new FormData(e.currentTarget).get('password') } });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo restablecer');
    } finally {
      setLoading(false);
    }
  }

  if (done) return <div className="space-y-3"><h1 className="text-2xl font-bold">Contraseña actualizada</h1><Link href="/login" className="text-primary hover:underline">Iniciar sesión</Link></div>;
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <h1 className="text-2xl font-bold">Nueva contraseña</h1>
      <div className="space-y-2"><Label htmlFor="password">Contraseña</Label><Input id="password" name="password" type="password" minLength={10} required /></div>
      {error && <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" loading={loading} disabled={!token}>Guardar</Button>
    </form>
  );
}

export default function ResetPage() {
  return <Suspense><ResetForm /></Suspense>;
}
