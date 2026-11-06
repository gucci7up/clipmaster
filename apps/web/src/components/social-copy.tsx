'use client';

import { Check, Copy, Loader2, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardHeader, CardTitle } from './ui';
import { api, ApiError, Clip } from '@/lib/api';

/**
 * Título, descripción y hashtags para publicar el clip, generados con el LLM del servidor.
 * Requiere «LLM semántico» en Ajustes: el texto del clip se envía al proveedor configurado.
 */
export function SocialCopyCard({ clip, llmEnabled, llmProvider, onChange }: {
  clip: Clip; llmEnabled: boolean; llmProvider: string | null; onChange: (c: Clip) => void;
}) {
  const [busy, setBusy] = useState(false);
  const copy = clip.socialCopy;
  const pending = clip.socialStatus === 'PENDING';

  async function generate() {
    setBusy(true);
    try {
      onChange(await api<Clip>(`/clips/${clip.id}/copy`, { method: 'POST' }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo generar el texto');
    } finally {
      setBusy(false);
    }
  }

  const all = copy ? `${copy.title}\n\n${copy.description}\n\n${copy.hashtags.join(' ')}` : '';
  return (
    <Card>
      <CardHeader><CardTitle>Texto para publicar</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!llmEnabled ? (
          <p className="text-xs text-muted-foreground">
            {llmProvider ? <>Activa <Link href="/ajustes" className="underline">«LLM semántico» en Ajustes</Link> para generar título, descripción y hashtags con IA.</>
              : 'No disponible: el administrador no ha configurado ningún LLM (Ollama o NVIDIA).'}
          </p>
        ) : (
          <>
            {copy && (
              <div className="space-y-2">
                <Field label="Título" value={copy.title} />
                <Field label="Descripción" value={copy.description} />
                <Field label="Hashtags" value={copy.hashtags.join(' ')} />
              </div>
            )}
            {clip.socialStatus === 'FAILED' && clip.socialError && <p className="text-xs text-destructive">No se pudo generar: {clip.socialError}</p>}
            {pending && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Generando… (si se está analizando un video, espera su turno en la cola de IA)</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant={copy ? 'outline' : 'default'} disabled={pending} loading={busy} onClick={generate}><Sparkles /> {copy ? 'Generar otro' : 'Generar con IA'}</Button>
              {copy && <CopyButton text={all} label="Copiar todo" />}
            </div>
            <p className="text-xs text-muted-foreground">
              {llmProvider?.startsWith('nvidia:') ? 'Se envía el texto del clip a NVIDIA.' : 'Se genera en tu servidor con Ollama.'} Revísalo antes de publicar.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        <CopyButton text={value} label={`Copiar ${label.toLowerCase()}`} compact />
      </div>
      <p className="whitespace-pre-wrap break-words">{value}</p>
    </div>
  );
}

function CopyButton({ text, label, compact }: { text: string; label: string; compact?: boolean }) {
  const [done, setDone] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      toast.error('No se pudo copiar');
    }
  }
  return (
    <Button size="sm" variant={compact ? 'ghost' : 'outline'} aria-label={label} onClick={copy} className={compact ? 'h-7 px-2' : undefined}>
      {done ? <Check /> : <Copy />}{!compact && ` ${label}`}
    </Button>
  );
}
