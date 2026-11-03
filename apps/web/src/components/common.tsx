'use client';

import { AlertTriangle, CheckCircle2, CircleDashed, Clock, Download, Loader2, Radio, Scissors, Sparkles, XCircle } from 'lucide-react';
import Link from 'next/link';
import type { Clip, Project, ProjectStatus } from '@/lib/api';
import { cn, formatDuration, relativeTime } from '@/lib/utils';
import { Badge, Card } from './ui';

export const STATUS: Record<ProjectStatus, { label: string; variant: 'default' | 'secondary' | 'success' | 'warning' | 'destructive'; active: boolean }> = {
  PENDING: { label: 'Pendiente', variant: 'secondary', active: true },
  VALIDATING: { label: 'Validando enlace', variant: 'default', active: true },
  CAPTURING: { label: 'Capturando', variant: 'destructive', active: true },
  DOWNLOADING: { label: 'Importando', variant: 'default', active: true },
  TRANSCRIBING: { label: 'Transcribiendo', variant: 'default', active: true },
  ANALYZING: { label: 'Analizando', variant: 'default', active: true },
  GENERATING: { label: 'Generando clips', variant: 'default', active: true },
  COMPLETED: { label: 'Completado', variant: 'success', active: false },
  FAILED: { label: 'Fallido', variant: 'destructive', active: false },
  CANCELLED: { label: 'Cancelado', variant: 'secondary', active: false },
};

export function StatusBadge({ status }: { status: ProjectStatus }) {
  const s = STATUS[status];
  const Icon = status === 'COMPLETED' ? CheckCircle2 : status === 'FAILED' ? XCircle : status === 'CANCELLED' ? CircleDashed
    : status === 'CAPTURING' ? Radio : status === 'PENDING' ? Clock : Loader2;
  return (
    <Badge variant={s.variant}>
      <Icon className={cn('size-3', s.active && status !== 'CAPTURING' && status !== 'PENDING' && 'animate-spin', status === 'CAPTURING' && 'animate-pulse')} />
      {s.label}
    </Badge>
  );
}

export function ScoreBadge({ score }: { score: number }) {
  const variant = score >= 70 ? 'success' : score >= 45 ? 'default' : 'secondary';
  return (
    <Badge variant={variant} title="Puntuación de interés estimada (0–100). No es una predicción garantizada de viralidad.">
      <Sparkles className="size-3" /> {Math.round(score)}
    </Badge>
  );
}

export function EmptyState({ icon: Icon = Scissors, title, description, action }: { icon?: React.ElementType; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-14 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary"><Icon className="size-6" /></span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {message}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function ProjectRow({ p }: { p: Project & { clipCount?: number; _count?: { clips: number } } }) {
  const clips = p.clipCount ?? p._count?.clips ?? 0;
  return (
    <Link href={`/proyectos/${p.id}`} className="group">
      <Card className="flex items-center gap-4 p-3 transition-colors group-hover:border-primary/40">
        <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-muted">
          {p.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.thumbnailUrl} alt="" className="size-full object-cover" loading="lazy" />
          ) : (
            <div className="grid size-full place-items-center text-muted-foreground"><Scissors className="size-5" /></div>
          )}
          {p.source?.isLive && <span className="absolute left-1 top-1 rounded bg-red-600 px-1.5 text-[10px] font-bold text-white">LIVE</span>}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{p.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            {p.source?.provider === 'UPLOAD' ? 'Archivo subido' : p.source?.provider} · {relativeTime(p.createdAt)}
          </p>
        </div>
        <div className="hidden text-right text-sm sm:block">
          <p className="font-medium">{clips} clips</p>
          {p.processingMs > 0 && <p className="text-xs text-muted-foreground">{formatDuration(p.processingMs / 1000)} de proceso</p>}
        </div>
        <StatusBadge status={p.status} />
      </Card>
    </Link>
  );
}

export function ClipCard({ clip }: { clip: Clip }) {
  return (
    <Card className="group overflow-hidden">
      <Link href={`/clips/${clip.id}`} className="block">
        <div className={cn('relative overflow-hidden bg-muted', clip.aspect === 'VERTICAL' ? 'aspect-[9/16] max-h-80' : clip.aspect === 'SQUARE' ? 'aspect-square' : 'aspect-video')}>
          {clip.thumbnailUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={clip.thumbnailUrl} alt="" className="mx-auto h-full object-cover transition-transform group-hover:scale-[1.02]" loading="lazy" />
          ) : (
            <div className="grid size-full place-items-center text-sm text-muted-foreground">
              {clip.status === 'FAILED' ? <span className="flex items-center gap-1 text-destructive"><XCircle className="size-4" /> Falló el render</span>
                : <span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Renderizando…</span>}
            </div>
          )}
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-xs font-medium text-white">{formatDuration(clip.duration)}</span>
          <span className="absolute left-2 top-2"><ScoreBadge score={clip.score} /></span>
        </div>
      </Link>
      <div className="space-y-2 p-3">
        <Link href={`/clips/${clip.id}`} className="line-clamp-2 text-sm font-semibold hover:text-primary">{clip.title}</Link>
        <p className="line-clamp-2 text-xs text-muted-foreground">{clip.reason}</p>
        <div className="flex items-center justify-between pt-1 text-xs text-muted-foreground">
          <span>{formatDuration(clip.start)} – {formatDuration(clip.end)}</span>
          {clip.downloadUrl && (
            <a href={clip.downloadUrl} className="flex items-center gap-1 font-medium text-primary hover:underline"><Download className="size-3.5" /> MP4</a>
          )}
        </div>
      </div>
    </Card>
  );
}
