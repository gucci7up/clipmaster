'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { api, ApiError } from '@/lib/api';
import { Button, Input, Label } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: cfg } = useSWR<{ registration: boolean; passwordReset: boolean }>('/auth/config');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setLoading(true);
    setError(null);
    try {
      await api('/auth/login', { method: 'POST', json: { email: form.get('email'), password: form.get('password') } });
      const next = params.get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'No se pudo iniciar sesión');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold">Iniciar sesión</h1>
        <p className="text-sm text-muted-foreground">Accede a tus proyectos y clips.</p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="email">Correo</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Contraseña</Label>
          {cfg?.passwordReset && <Link href="/recuperar" className="text-xs text-primary hover:underline">¿La olvidaste?</Link>}
        </div>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error && <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" className="w-full" loading={loading}>Entrar</Button>
      {cfg?.registration !== false && (
        <p className="text-center text-sm text-muted-foreground">
          ¿No tienes cuenta? <Link href="/registro" className="font-medium text-primary hover:underline">Regístrate</Link>
        </p>
      )}
    </form>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
