'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Label } from '@/components/ui';

export default function RegisterPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    if (f.get('password') !== f.get('confirm')) {
      setError('Las contraseñas no coinciden');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api('/auth/register', { method: 'POST', json: { name: f.get('name'), email: f.get('email'), password: f.get('password') } });
      router.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo crear la cuenta');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Crear cuenta</h1>
        <p className="text-sm text-muted-foreground">Empieza a generar clips en minutos.</p>
      </div>
      <div className="space-y-2"><Label htmlFor="name">Nombre</Label><Input id="name" name="name" required minLength={2} maxLength={80} /></div>
      <div className="space-y-2"><Label htmlFor="email">Correo</Label><Input id="email" name="email" type="email" required /></div>
      <div className="space-y-2">
        <Label htmlFor="password">Contraseña</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={10} />
        <p className="text-xs text-muted-foreground">Mínimo 10 caracteres.</p>
      </div>
      <div className="space-y-2"><Label htmlFor="confirm">Repetir contraseña</Label><Input id="confirm" name="confirm" type="password" required minLength={10} /></div>
      {error && <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" className="w-full" loading={loading}>Crear cuenta</Button>
      <p className="text-center text-sm text-muted-foreground">¿Ya tienes cuenta? <Link href="/login" className="font-medium text-primary hover:underline">Inicia sesión</Link></p>
    </form>
  );
}
