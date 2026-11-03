'use client';

import { DEFAULT_SUBTITLE_STYLE } from '@clipmaster/shared';
import type { AspectRatio, SubtitleStyle } from '@clipmaster/shared';
import { ArrowLeft, Download, Loader2, RefreshCw, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { ErrorState, ScoreBadge } from '@/components/common';
import { SubtitleControls } from '@/components/subtitle-controls';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmButton, Input, Label, Select, Skeleton, Switch } from '@/components/ui';
import { api, ApiError, Clip, ProjectDetail } from '@/lib/api';
import { cn, formatDuration, formatMs, formatTimecode } from '@/lib/utils';

const ASPECTS: { v: AspectRatio; l: string }[] = [
  { v: 'VERTICAL', l: '9:16' }, { v: 'HORIZONTAL', l: '16:9' }, { v: 'SQUARE', l: '1:1' },
];

interface Draft {
  title: string;
  start: number;
  end: number;
  aspect: AspectRatio;
  subtitles: boolean;
  subtitleStyle: SubtitleStyle;
  reframeMode: 'auto' | 'center' | 'manual';
  manualX: number;
}

function draftOf(c: Clip): Draft {
  return {
    title: c.title, start: c.start, end: c.end, aspect: c.aspect, subtitles: c.subtitles,
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE, ...c.subtitleStyle }, reframeMode: c.reframeMode, manualX: c.manualX ?? 0.5,
  };
}

export default function ClipEditorPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { data: clip, error, mutate } = useSWR<Clip>(`/clips/${id}`, {
    refreshInterval: (c) => (c && (c.status === 'PENDING' || c.status === 'RENDERING') ? 4000 : 0),
  });
  const { data: project } = useSWR<ProjectDetail>(clip ? `/projects/${clip.projectId}` : null);
  const [d, setD] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const sourceRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (clip && !d) setD(draftOf(clip));
  }, [clip, d]);

  if (error) return <ErrorState message={error.message} />;
  if (!clip || !d) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-96" /></div>;

  const rendering = clip.status === 'PENDING' || clip.status === 'RENDERING';
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v });
  const setStyle = <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]) => setD({ ...d, subtitleStyle: { ...d.subtitleStyle, [k]: v } });
  const sourceDuration = project?.assets[0]?.durationSec ?? project?.captures[0]?.durationSec ?? Math.max(d.end + 30, clip.end + 30);
  const dirty = JSON.stringify(d) !== JSON.stringify(draftOf(clip));
  const invalid = d.end - d.start < 3 ? 'El clip debe durar al menos 3 s' : d.end - d.start > 600 ? 'Máximo 10 minutos' : d.start < 0 || d.end > sourceDuration + 0.5 ? 'Fuera de la duración del video' : null;

  function seek(t: number) {
    if (sourceRef.current) {
      sourceRef.current.currentTime = t;
      void sourceRef.current.play().catch(() => undefined);
    }
  }

  async function save(regenerate: boolean) {
    if (!d) return;
    setSaving(true);
    try {
      if (dirty) {
        await api(`/clips/${id}`, {
          method: 'PATCH',
          json: { ...d, manualX: d.reframeMode === 'manual' ? d.manualX : null, manualY: null },
        });
      }
      if (regenerate) await api(`/clips/${id}/regenerate`, { method: 'POST' });
      const fresh = await mutate();
      if (fresh) setD(draftOf(fresh));
      toast.success(regenerate ? 'Render en cola. Se actualizará automáticamente.' : 'Cambios guardados');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo guardar');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Link href={`/proyectos/${clip.projectId}`} className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> {clip.project.name}</Link>
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-2xl font-bold tracking-tight">Editor de clip</h1>
          <ScoreBadge score={clip.score} />
          {rendering && <Badge><Loader2 className="size-3 animate-spin" /> Renderizando</Badge>}
          {clip.status === 'FAILED' && <Badge variant="destructive">Render fallido</Badge>}
        </div>
        <div className="flex flex-wrap gap-2">
          {clip.downloadUrl && <Button variant="outline" asChild><a href={clip.downloadUrl}><Download /> Descargar MP4</a></Button>}
          <ConfirmButton title="¿Eliminar este clip?" description="Se eliminará el clip y sus renders." confirmLabel="Eliminar" onConfirm={async () => {
            try { await api(`/clips/${id}`, { method: 'DELETE' }); toast.success('Clip eliminado'); router.push(`/proyectos/${clip.projectId}`); }
            catch (err) { toast.error(err instanceof ApiError ? err.message : 'No se pudo eliminar'); }
          }}><Trash2 /> Eliminar</ConfirmButton>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_400px]">
        <div className="min-w-0 space-y-6">
          <div className="grid gap-6 md:grid-cols-2">
            <Card className="overflow-hidden">
              <CardHeader><CardTitle>Clip renderizado</CardTitle></CardHeader>
              <div className="grid place-items-center bg-black">
                {clip.videoUrl ? (
                  <video key={clip.currentRender?.id} src={clip.videoUrl} controls className={cn('max-h-[60vh] w-full', clip.aspect === 'VERTICAL' ? 'aspect-[9/16] max-w-xs' : clip.aspect === 'SQUARE' ? 'aspect-square' : 'aspect-video')} />
                ) : (
                  <div className="grid aspect-video w-full place-items-center text-sm text-white/70">{rendering ? 'Renderizando…' : 'Sin render disponible'}</div>
                )}
              </div>
              {clip.currentRender?.error && <p className="p-3 text-xs text-destructive">{clip.currentRender.error}</p>}
            </Card>
            <Card className="overflow-hidden">
              <CardHeader><CardTitle>Video original</CardTitle></CardHeader>
              {project?.originalUrl ? (
                <video ref={sourceRef} src={project.originalUrl} controls preload="metadata" className="aspect-video w-full bg-black" />
              ) : (
                <div className="grid aspect-video place-items-center bg-muted text-sm text-muted-foreground">{project?.captures.length ? 'Fuente segmentada (directo)' : 'Cargando…'}</div>
              )}
              <div className="flex flex-wrap gap-2 p-3">
                <Button size="sm" variant="secondary" onClick={() => seek(d.start)} disabled={!project?.originalUrl}>Ir al inicio</Button>
                <Button size="sm" variant="secondary" onClick={() => seek(Math.max(0, d.end - 3))} disabled={!project?.originalUrl}>Últimos 3 s</Button>
                <Button size="sm" variant="ghost" disabled={!project?.originalUrl} onClick={() => sourceRef.current && set('start', Math.round(sourceRef.current.currentTime * 10) / 10)}>Marcar inicio aquí</Button>
                <Button size="sm" variant="ghost" disabled={!project?.originalUrl} onClick={() => sourceRef.current && set('end', Math.round(sourceRef.current.currentTime * 10) / 10)}>Marcar fin aquí</Button>
              </div>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle>Recorte</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <Timeline duration={sourceDuration} start={d.start} end={d.end} onChange={(s, e) => setD({ ...d, start: s, end: e })} />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="space-y-1"><Label htmlFor="start">Inicio (s)</Label><Input id="start" type="number" step={0.1} min={0} value={d.start} onChange={(e) => set('start', Number(e.target.value))} /></div>
                <div className="space-y-1"><Label htmlFor="end">Fin (s)</Label><Input id="end" type="number" step={0.1} min={0} value={d.end} onChange={(e) => set('end', Number(e.target.value))} /></div>
                <div className="space-y-1"><Label>Duración</Label><p className="h-9 content-center font-medium">{formatDuration(d.end - d.start)}</p></div>
                <div className="space-y-1"><Label>Rango</Label><p className="h-9 content-center font-mono text-xs">{formatTimecode(d.start)} – {formatTimecode(d.end)}</p></div>
              </div>
              {invalid && <p className="text-sm text-destructive">{invalid}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Por qué se eligió</CardTitle></CardHeader>
            <CardContent className="text-sm text-muted-foreground">{clip.reason}</CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Ajustes</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2"><Label htmlFor="title">Título</Label><Input id="title" maxLength={200} value={d.title} onChange={(e) => set('title', e.target.value)} /></div>
              <div className="space-y-2">
                <Label>Formato</Label>
                <div className="grid grid-cols-3 gap-2">
                  {ASPECTS.map((a) => (
                    <button key={a.v} type="button" onClick={() => set('aspect', a.v)} className={cn('rounded-lg border py-2 text-sm font-medium', d.aspect === a.v ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-muted')}>{a.l}</button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reframe">Encuadre</Label>
                <Select id="reframe" value={d.reframeMode} onChange={(e) => set('reframeMode', e.target.value as Draft['reframeMode'])}>
                  <option value="auto">Automático (sigue rostros / movimiento)</option>
                  <option value="center">Centrado</option>
                  <option value="manual">Manual</option>
                </Select>
                {d.reframeMode === 'manual' && (
                  <div className="space-y-1">
                    <div className="flex justify-between text-xs text-muted-foreground"><span>Izquierda</span><span>{Math.round(d.manualX * 100)}%</span><span>Derecha</span></div>
                    <input type="range" min={0} max={1} step={0.01} value={d.manualX} onChange={(e) => set('manualX', Number(e.target.value))} className="w-full" aria-label="Posición horizontal del encuadre" />
                  </div>
                )}
              </div>
              <label className="flex items-center justify-between text-sm"><span className="font-medium">Subtítulos</span><Switch checked={d.subtitles} onCheckedChange={(v) => set('subtitles', v)} label="Subtítulos" /></label>
              {d.subtitles && <SubtitleControls style={d.subtitleStyle} setStyle={setStyle} />}
            </CardContent>
          </Card>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" disabled={!dirty || !!invalid || saving} onClick={() => save(false)}><Save /> Guardar</Button>
            <Button disabled={!!invalid || saving || rendering} loading={saving} onClick={() => save(true)}><RefreshCw /> {dirty ? 'Guardar y regenerar' : 'Regenerar'}</Button>
          </div>
          {clip.renders.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Historial de renders</CardTitle></CardHeader>
              <CardContent className="space-y-1.5 text-xs">
                {clip.renders.slice(0, 6).map((r) => (
                  <div key={r.id} className="flex justify-between gap-2">
                    <span>{new Date(r.createdAt).toLocaleString('es')}</span>
                    <span className="text-muted-foreground">{r.status === 'READY' ? `${r.width}×${r.height} · ${r.encoder} · ${formatMs(r.renderMs ?? 0)}` : r.status}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

/** Línea de tiempo con dos asas arrastrables sobre la duración del video fuente. */
function Timeline({ duration, start, end, onChange }: { duration: number; start: number; end: number; onChange: (s: number, e: number) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (t: number) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;

  function drag(which: 'start' | 'end') {
    return (ev: React.PointerEvent) => {
      ev.preventDefault();
      const el = ref.current;
      if (!el) return;
      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const t = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration * 10) / 10;
        if (which === 'start') onChange(Math.min(t, end - 3), end);
        else onChange(start, Math.max(t, start + 3));
      };
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
  }

  return (
    <div className="space-y-1">
      <div ref={ref} className="relative h-10 rounded-lg bg-muted">
        <div className="absolute inset-y-0 rounded-lg bg-primary/25 ring-2 ring-primary" style={{ left: pct(start), width: `calc(${pct(end)} - ${pct(start)})` }} />
        {(['start', 'end'] as const).map((w) => (
          <button key={w} type="button" aria-label={w === 'start' ? 'Asa de inicio' : 'Asa de fin'} onPointerDown={drag(w)}
            className="absolute top-1/2 h-12 w-3 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize touch-none rounded bg-primary shadow" style={{ left: pct(w === 'start' ? start : end) }} />
        ))}
      </div>
      <div className="flex justify-between text-xs text-muted-foreground"><span>0:00</span><span>{formatDuration(duration)}</span></div>
    </div>
  );
}
