'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Label } from '@/components/ui';

export default function ForgotPage() {
  const [state, setState] = useState<'idle' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api('/auth/forgot-password', { method: 'POST', json: { email: new FormData(e.currentTarget).get('email') } });
      setState('sent');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo enviar el correo');
    } finally {
      setLoading(false);
    }
  }

  if (state === 'sent') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">Revisa tu correo</h1>
        <p className="text-sm text-muted-foreground">Si la cuenta existe, recibirás un enlace válido durante 1 hora.</p>
        <Link href="/login" className="text-sm text-primary hover:underline">Volver a iniciar sesión</Link>
      </div>
    );
  }
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <h1 className="text-2xl font-bold">Recuperar contraseña</h1>
      <div className="space-y-2"><Label htmlFor="email">Correo</Label><Input id="email" name="email" type="email" required /></div>
      {error && <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" loading={loading}>Enviar enlace</Button>
      <Link href="/login" className="block text-center text-sm text-muted-foreground hover:underline">Volver</Link>
    </form>
  );
}
