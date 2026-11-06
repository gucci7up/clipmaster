'use client';

import { MODES } from '@clipmaster/shared';
import { ArrowLeft, Ban, Film, ListTree, RefreshCw, ScrollText, Square, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { MergeClipsDialog } from '@/components/clip-tools';
import { FindMoments } from '@/components/find-moments';
import { ClipCard, EmptyState, ErrorState, STATUS, StatusBadge } from '@/components/common';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, ConfirmButton, Progress, Skeleton, Tabs } from '@/components/ui';
import { api, ApiError, Clip, Job, ProjectDetail } from '@/lib/api';
import { formatBytes, formatDate, formatDuration, formatMs, formatTimecode } from '@/lib/utils';

const JOB_LABEL: Record<Job['type'], string> = {
  IMPORT: 'Importación', LIVE_CAPTURE: 'Captura en vivo', ANALYZE: 'Análisis', RENDER: 'Render', CLEANUP: 'Limpieza', COPY: 'Texto para publicar', THUMBNAIL: 'Miniatura',
};
const STAGE_LABEL: Record<string, string> = {
  validate: 'Validando', download: 'Descargando', import: 'Importando', audio: 'Extrayendo audio',
  transcribe: 'Transcribiendo', audio_analysis: 'Señales de audio', visual_analysis: 'Señales visuales',
  semantic: 'Análisis semántico', scoring: 'Puntuación', render: 'Renderizando', capture: 'Capturando',
  reconnecting: 'Reconectando', waiting_agent: 'Esperando al capturador de tu PC', claimed: 'Asignado al capturador',
};
const JOB_STATUS: Record<Job['status'], { label: string; variant: 'default' | 'secondary' | 'success' | 'destructive' }> = {
  QUEUED: { label: 'En cola', variant: 'secondary' }, RUNNING: { label: 'En curso', variant: 'default' },
  COMPLETED: { label: 'Completado', variant: 'success' }, FAILED: { label: 'Fallido', variant: 'destructive' },
  CANCELLED: { label: 'Cancelado', variant: 'secondary' },
};

interface EventRow { id: string; type: string; stage: string | null; message: string | null; progress: number | null; createdAt: string }

function JobRow({ job }: { job: Job }) {
  const s = JOB_STATUS[job.status];
  return (
    <div className="space-y-1.5 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{JOB_LABEL[job.type]}{job.stage && (job.status === 'RUNNING' || job.stage === 'waiting_agent') && <span className="font-normal text-muted-foreground"> · {STAGE_LABEL[job.stage] ?? job.stage}</span>}</span>
        <Badge variant={s.variant}>{s.label}</Badge>
      </div>
      {job.status === 'RUNNING' && <Progress value={job.progress} />}
      <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        {job.attempts > 1 && <span>Intento {job.attempts}</span>}
        {job.startedAt && job.finishedAt && <span>{formatMs(new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime())}</span>}
        {job.error && <span className="text-destructive">{job.error}</span>}
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [tab, setTab] = useState<'clips' | 'transcript' | 'events'>('clips');
  const videoRef = useRef<HTMLVideoElement>(null);
  const { data: p, error, mutate } = useSWR<ProjectDetail>(`/projects/${id}`);
  const { data: clips } = useSWR<Clip[]>(`/projects/${id}/clips`);
  const { data: events } = useSWR<EventRow[]>(tab === 'events' ? `/projects/${id}/events` : null);
  const { data: transcript } = useSWR<{ id: string; start: number; end: number; text: string }[]>(tab === 'transcript' ? `/projects/${id}/transcript` : null);

  async function action(path: string, ok: string, method = 'POST') {
    try {
      await api(`/projects/${id}${path}`, { method });
      toast.success(ok);
      await mutate();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'La operación falló');
    }
  }

  if (error) return <ErrorState message={error.message} />;
  if (!p) return <div className="space-y-4"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></div>;

  const active = STATUS[p.status].active;
  const capture = p.captures[0];
  const asset = p.assets[0];
  const jobs = [...p.jobs].sort((a, b) => +new Date(b.queuedAt) - +new Date(a.queuedAt));
  const visibleJobs = jobs.filter((j) => j.type !== 'COPY' && j.type !== 'THUMBNAIL' && (j.type !== 'RENDER' || j.status !== 'COMPLETED')).slice(0, 8);

  return (
    <>
      <Link href="/proyectos" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Proyectos</Link>
      <div className="mb-6 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-bold tracking-tight">{p.name}</h1>
            <StatusBadge status={p.status} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {MODES[p.mode]?.label} · {p.source?.provider === 'UPLOAD' ? 'Archivo subido' : p.source?.provider}
            {p.detectedLanguage && ` · idioma ${p.detectedLanguage}`} · creado {formatDate(p.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {p.status === 'CAPTURING' && capture?.status === 'RECORDING' && (
            <ConfirmButton variant="default" title="¿Detener la captura?" description="Se procesará lo capturado hasta ahora y se generarán los clips restantes." confirmLabel="Detener" onConfirm={() => action('/stop-capture', 'Deteniendo la captura…')}><Square /> Detener captura</ConfirmButton>
          )}
          {active && (
            <ConfirmButton title="¿Cancelar el procesamiento?" description="Los trabajos en curso se detendrán. Los clips ya generados se conservan." confirmLabel="Cancelar procesamiento" onConfirm={() => action('/cancel', 'Procesamiento cancelado')}><Ban /> Cancelar</ConfirmButton>
          )}
          {(p.status === 'FAILED' || p.status === 'CANCELLED') && (
            <Button variant="outline" onClick={() => action('/retry', 'Reintentando')}><RefreshCw /> Reintentar</Button>
          )}
          <ConfirmButton title="¿Eliminar el proyecto?" description="Se eliminarán el video original, los clips y todos los archivos asociados. No se puede deshacer." confirmLabel="Eliminar" onConfirm={async () => { await action('', 'Proyecto eliminado', 'DELETE'); router.push('/proyectos'); }}><Trash2 /> Eliminar</ConfirmButton>
        </div>
      </div>

      {p.errorMessage && <div className="mb-6"><ErrorState message={p.errorMessage} /></div>}

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-6">
          {p.originalUrl && (
            <Card className="overflow-hidden">
              <video ref={videoRef} src={p.originalUrl} controls preload="metadata" className="aspect-video w-full bg-black" />
            </Card>
          )}
          <FindMoments projectId={p.id} sourceDuration={asset?.durationSec ?? null} onSeek={p.originalUrl ? (t) => {
            const v = videoRef.current;
            if (!v) return;
            v.currentTime = t;
            v.scrollIntoView({ behavior: 'smooth', block: 'center' });
            void v.play().catch(() => undefined);
          } : undefined} />
          <Tabs value={tab} onChange={setTab} items={[
            { value: 'clips', label: <span className="flex items-center gap-1.5"><Film className="size-4" /> Clips ({clips?.length ?? 0})</span> },
            { value: 'transcript', label: <span className="flex items-center gap-1.5"><ScrollText className="size-4" /> Transcripción</span> },
            { value: 'events', label: <span className="flex items-center gap-1.5"><ListTree className="size-4" /> Actividad</span> },
          ]} />
          {tab === 'clips' && (
            !clips ? <Skeleton className="h-48" />
              : clips.length === 0 ? (
                <EmptyState icon={Film} title={active ? 'Buscando los mejores momentos…' : 'No se generaron clips'} description={active ? 'Los clips aparecerán aquí en cuanto estén listos.' : 'Prueba con otro modo de contenido, una duración distinta o la preferencia “Cantidad”.'} />
              ) : (
                <div className="space-y-3">
                  <div className="flex justify-end"><MergeClipsDialog clips={clips} /></div>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{clips.map((c) => <ClipCard key={c.id} clip={c} />)}</div>
                </div>
              )
          )}
          {tab === 'transcript' && (
            <Card><CardContent className="max-h-[32rem] space-y-2 overflow-y-auto pt-5 text-sm">
              {!transcript ? <Skeleton className="h-32" /> : transcript.length === 0 ? <p className="text-muted-foreground">Aún no hay transcripción.</p>
                : transcript.map((s) => <p key={s.id}><span className="mr-2 font-mono text-xs text-primary">{formatTimecode(s.start)}</span>{s.text}</p>)}
            </CardContent></Card>
          )}
          {tab === 'events' && (
            <Card><CardContent className="max-h-[32rem] space-y-1 overflow-y-auto pt-5 text-sm">
              {!events ? <Skeleton className="h-32" /> : events.length === 0 ? <p className="text-muted-foreground">Sin actividad registrada.</p>
                : events.map((e) => (
                  <div key={e.id} className="flex gap-3 border-b py-1.5 last:border-0">
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString('es')}</span>
                    <span className="min-w-0">{e.message ?? e.type}{e.stage && <span className="text-muted-foreground"> · {STAGE_LABEL[e.stage] ?? e.stage}</span>}{e.progress != null && <span className="text-muted-foreground"> · {Math.round(e.progress * 100)}%</span>}</span>
                  </div>
                ))}
            </CardContent></Card>
          )}
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Procesamiento</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {visibleJobs.length === 0 ? <p className="text-sm text-muted-foreground">Sin trabajos todavía.</p> : visibleJobs.map((j) => <JobRow key={j.id} job={j} />)}
              {p.processingMs > 0 && <p className="pt-1 text-xs text-muted-foreground">Tiempo total de cómputo: {formatMs(p.processingMs)}</p>}
            </CardContent>
          </Card>
          {capture && (
            <Card>
              <CardHeader><CardTitle>Captura en vivo</CardTitle></CardHeader>
              <CardContent className="grid grid-cols-2 gap-3 text-sm">
                <div><p className="text-muted-foreground">Estado</p><p className="font-medium">{capture.status}</p></div>
                <div><p className="text-muted-foreground">Capturado</p><p className="font-medium">{formatDuration(capture.durationSec)}</p></div>
                <div><p className="text-muted-foreground">Segmentos</p><p className="font-medium">{capture.segmentsCount}</p></div>
                <div><p className="text-muted-foreground">Reconexiones</p><p className="font-medium">{capture.reconnects}</p></div>
                {capture.endedReason && <p className="col-span-2 text-xs text-muted-foreground">Fin: {capture.endedReason}</p>}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader><CardTitle>Detalles</CardTitle></CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {asset && <><Row k="Duración" v={formatDuration(asset.durationSec)} />{asset.width && <Row k="Resolución" v={`${asset.width}×${asset.height}`} />}<Row k="Tamaño" v={formatBytes(asset.sizeBytes)} /></>}
              <Row k="Clips máx." v={p.maxClips} />
              <Row k="Duración clip" v={`${p.minDuration}–${p.maxDuration} s`} />
              <Row k="Formato" v={p.aspect === 'VERTICAL' ? '9:16' : p.aspect === 'SQUARE' ? '1:1' : '16:9'} />
              <Row k="Subtítulos" v={p.subtitles ? 'Sí' : 'No'} />
              <Row k="Candidatos" v={p._count.candidates} />
              {p.source?.url && <p className="truncate pt-1 text-xs text-muted-foreground" title={p.source.url}>{p.source.url}</p>}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="flex justify-between gap-3"><span className="text-muted-foreground">{k}</span><span className="font-medium">{v}</span></div>;
}
