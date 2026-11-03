'use client';

import type { SubtitleStyle, Word } from '@clipmaster/shared';
import { Combine, Loader2, RotateCcw, Save, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogTrigger, Input, Select } from './ui';
import { api, ApiError, Clip, ClipWords, SubtitlePresetRow } from '@/lib/api';
import { cn, formatDuration, formatTimecode } from '@/lib/utils';

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/**
 * Corrección del texto de los subtítulos. Cada palabra conserva sus tiempos (los de Whisper):
 * sólo cambia lo que se escribe. Una palabra vacía se elimina del subtítulo.
 */
export function WordsEditor({ clipId, onSaved }: { clipId: string; onSaved: () => void }) {
  const { data, mutate } = useSWR<ClipWords>(`/clips/${clipId}/words`);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const key = (w: Word) => `${w.start}|${w.end}`;

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.words.map((w) => [key(w), w.word])));
  }, [data]);

  if (!data) return <Card><CardContent className="p-6"><Loader2 className="size-4 animate-spin" /></CardContent></Card>;
  // Se editan las palabras originales: así una palabra borrada puede recuperarse escribiéndola otra vez.
  const base = data.original;
  const current = new Map(data.words.map((w) => [key(w), w.word]));
  const dirty = base.some((w) => (draft[key(w)] ?? '') !== (current.get(key(w)) ?? ''));

  async function save() {
    setBusy(true);
    try {
      const words = base.map((w) => ({ start: w.start, end: w.end, word: draft[key(w)] ?? '' }));
      await mutate(await api<ClipWords>(`/clips/${clipId}/words`, { method: 'PUT', json: { words } }), { revalidate: false });
      toast.success('Texto guardado. Regenera el clip para verlo en el video.');
      onSaved();
    } catch (err) {
      toast.error(errorText(err, 'No se pudo guardar el texto'));
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    try {
      await mutate(await api<ClipWords>(`/clips/${clipId}/words`, { method: 'DELETE' }), { revalidate: false });
      toast.success('Se restauró la transcripción original');
      onSaved();
    } catch (err) {
      toast.error(errorText(err, 'No se pudo restaurar'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Texto de los subtítulos</CardTitle>
        <CardDescription>Corrige palabras mal transcritas sin cambiar su sincronía. Deja una palabra vacía para quitarla.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {base.length === 0 ? <p className="text-sm text-muted-foreground">Este clip no tiene voz transcrita.</p> : (
          <div className="flex max-h-72 flex-wrap gap-1 overflow-y-auto rounded-lg border p-2">
            {base.map((w) => {
              const k = key(w);
              const value = draft[k] ?? '';
              const changed = value !== w.word;
              return (
                <input key={k} value={value} title={`${formatTimecode(w.start)} · original: ${w.word}`} aria-label={`Palabra en ${formatTimecode(w.start)}`}
                  onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}
                  style={{ width: `${Math.max(2, value.length || w.word.length) + 1.5}ch` }}
                  className={cn('rounded border bg-background px-1 py-0.5 text-sm', changed && 'border-primary bg-primary/5', !value && 'border-dashed opacity-60',
                    w.probability != null && w.probability < 0.5 && !changed && 'border-amber-500/60')} />
              );
            })}
          </div>
        )}
        <p className="text-xs text-muted-foreground">Las palabras con borde ámbar tienen baja confianza en la transcripción.</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!dirty || busy} loading={busy} onClick={save}><Save /> Guardar texto</Button>
          {data.edited && <Button size="sm" variant="ghost" disabled={busy} onClick={reset}><RotateCcw /> Restaurar original</Button>}
        </div>
      </CardContent>
    </Card>
  );
}

const SIGNAL_LABELS: Record<string, string> = {
  semantic: 'Contenido (gancho, palabras clave)',
  emotion: 'Emoción en la voz',
  audio: 'Energía del audio',
  visual: 'Acción visual',
  chat: 'Actividad del chat',
  narrative: 'Inicio y final limpios',
  standalone: 'Se entiende por sí solo',
};

/** Desglose de la puntuación con los componentes que calculó el análisis (no hay valores inventados). */
export function ScoreBreakdown({ clip }: { clip: Clip }) {
  const signals = clip.candidate?.signals ?? {};
  const entries = Object.entries(signals).filter(([k]) => k in SIGNAL_LABELS).sort((a, b) => b[1] - a[1]);
  return (
    <Card>
      <CardHeader><CardTitle>Por qué se eligió</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted-foreground">{clip.reason}</p>
        {entries.length > 0 && (
          <div className="space-y-2">
            {entries.map(([k, v]) => (
              <div key={k} className="space-y-1">
                <div className="flex justify-between text-xs"><span>{SIGNAL_LABELS[k]}</span><span className="font-medium tabular-nums">{Math.round(v * 100)}</span></div>
                <div className="h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, Math.min(100, v * 100))}%` }} /></div>
              </div>
            ))}
          </div>
        )}
        {!!clip.candidate?.tags.length && (
          <div className="flex flex-wrap gap-1">{clip.candidate.tags.map((t) => <span key={t} className="rounded bg-muted px-1.5 py-0.5 text-xs">{t}</span>)}</div>
        )}
      </CardContent>
    </Card>
  );
}

/** Estilos guardados: aplicar uno, guardar el actual o aplicarlo a todos los clips del proyecto. */
export function StyleLibrary({ style, projectId, onPick }: { style: SubtitleStyle; projectId: string; onPick: (s: SubtitleStyle) => void }) {
  const { data: presets, mutate } = useSWR<SubtitlePresetRow[]>('/subtitle-presets');
  const [busy, setBusy] = useState<string | null>(null);

  async function saveCurrent() {
    const name = window.prompt('Nombre del estilo', 'Mi estilo')?.trim();
    if (!name) return;
    setBusy('save');
    try {
      await api('/subtitle-presets', { method: 'POST', json: { name, style } });
      await mutate();
      toast.success('Estilo guardado');
    } catch (err) {
      toast.error(errorText(err, 'No se pudo guardar el estilo'));
    } finally {
      setBusy(null);
    }
  }

  async function applyAll() {
    if (!window.confirm('Se aplicará este estilo a todos los clips del proyecto y se volverán a renderizar. ¿Continuar?')) return;
    setBusy('all');
    try {
      const r = await api<{ updated: number; queued: number }>(`/projects/${projectId}/apply-style`, { method: 'POST', json: { style, regenerate: true } });
      toast.success(`Estilo aplicado a ${r.updated} clips (${r.queued} en cola de render)`);
    } catch (err) {
      toast.error(errorText(err, 'No se pudo aplicar el estilo'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2">
      {!!presets?.length && (
        <Select aria-label="Estilos guardados" value="" onChange={(e) => {
          const p = presets.find((x) => x.id === e.target.value);
          if (p) onPick(p.style);
        }}>
          <option value="">Usar un estilo guardado…</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" size="sm" variant="outline" loading={busy === 'save'} onClick={saveCurrent}><Save /> Guardar estilo</Button>
        <Button type="button" size="sm" variant="outline" loading={busy === 'all'} onClick={applyAll}>Aplicar a todo el proyecto</Button>
      </div>
    </div>
  );
}

/** Lista de estilos guardados con opción de borrar (Ajustes). */
export function PresetList() {
  const { data: presets, mutate } = useSWR<SubtitlePresetRow[]>('/subtitle-presets');
  if (!presets?.length) return <p className="text-sm text-muted-foreground">Aún no hay estilos guardados. Guárdalos desde el editor de un clip.</p>;
  return (
    <ul className="divide-y rounded-lg border text-sm">
      {presets.map((p) => (
        <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2">
          <span><span className="font-medium">{p.name}</span> <span className="text-xs text-muted-foreground">· {p.style.preset} · {p.style.font?.startsWith('custom:') ? 'fuente propia' : p.style.font}</span></span>
          <Button size="sm" variant="ghost" aria-label={`Borrar ${p.name}`} onClick={async () => {
            try { await api(`/subtitle-presets/${p.id}`, { method: 'DELETE' }); await mutate(); } catch (err) { toast.error(errorText(err, 'No se pudo borrar')); }
          }}><Trash2 className="size-4" /></Button>
        </li>
      ))}
    </ul>
  );
}

/** Combina varios clips del proyecto, en el orden elegido, en un clip nuevo. */
export function MergeClipsDialog({ clips }: { clips: Clip[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const total = order.reduce((a, id) => a + (clips.find((c) => c.id === id)?.duration ?? 0), 0);

  function toggle(id: string) {
    setOrder((o) => (o.includes(id) ? o.filter((x) => x !== id) : [...o, id]));
  }

  async function merge() {
    setBusy(true);
    try {
      const clip = await api<Clip>('/clips/merge', { method: 'POST', json: { clipIds: order, title: title.trim() || undefined } });
      toast.success('Clip combinado en cola de render');
      setOpen(false);
      router.push(`/clips/${clip.id}`);
    } catch (err) {
      toast.error(errorText(err, 'No se pudieron combinar los clips'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setOrder([]); setTitle(''); } }}>
      <DialogTrigger asChild><Button variant="outline" size="sm" disabled={clips.length < 2}><Combine /> Combinar clips</Button></DialogTrigger>
      <DialogContent title="Combinar clips" description="Marca los clips en el orden en que quieres que aparezcan. Los originales no cambian." className="max-w-lg">
        <div className="space-y-3">
          <ul className="max-h-72 space-y-1 overflow-y-auto">
            {clips.map((c) => {
              const pos = order.indexOf(c.id);
              return (
                <li key={c.id}>
                  <button type="button" onClick={() => toggle(c.id)} className={cn('flex w-full items-center gap-3 rounded-lg border p-2 text-left text-sm', pos >= 0 ? 'border-primary bg-primary/5' : 'hover:bg-muted')}>
                    <span className={cn('grid size-6 shrink-0 place-items-center rounded-full border text-xs font-semibold', pos >= 0 && 'border-primary bg-primary text-primary-foreground')}>{pos >= 0 ? pos + 1 : ''}</span>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="text-xs text-muted-foreground">{formatDuration(c.duration)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <Input placeholder="Título (opcional)" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
          <div className="flex items-center justify-between text-sm">
            <span className={cn('text-muted-foreground', total > 600 && 'text-destructive')}>{order.length} clips · {formatDuration(total)}{total > 600 && ' (máx. 10 min)'}</span>
            <Button disabled={order.length < 2 || total > 600} loading={busy} onClick={merge}><Combine /> Combinar</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
