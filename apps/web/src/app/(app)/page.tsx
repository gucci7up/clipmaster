'use client';

import { Activity, Clock, Film, FolderKanban, HardDrive, Plus, Timer, Video } from 'lucide-react';
import Link from 'next/link';
import useSWR from 'swr';
import { EmptyState, ErrorState, PageHeader, ProjectRow } from '@/components/common';
import { Button, Card, CardContent, CardHeader, CardTitle, Progress, Skeleton } from '@/components/ui';
import type { Overview } from '@/lib/api';
import { formatBytes, formatDuration } from '@/lib/utils';

function Stat({ icon: Icon, label, value, hint }: { icon: React.ElementType; label: string; value: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        {label}
        <span className="grid size-8 place-items-center rounded-lg bg-primary/10 text-primary"><Icon className="size-4" /></span>
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight">{value}</p>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </Card>
  );
}

export default function DashboardPage() {
  const { data, error, isLoading } = useSWR<Overview>('/stats/overview', { refreshInterval: 30_000 });

  return (
    <>
      <PageHeader
        title="Inicio"
        description="Resumen de tu actividad"
        actions={<Button asChild><Link href="/proyectos/nuevo"><Plus /> Nuevo proyecto</Link></Button>}
      />
      {error && <ErrorState message={error.message} />}
      {isLoading || !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28" />)}</div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Stat icon={FolderKanban} label="Proyectos" value={data.projects} />
            <Stat icon={Video} label="Videos procesados" value={data.videosProcessed} />
            <Stat icon={Film} label="Clips generados" value={data.clipsGenerated} />
            <Stat icon={Activity} label="Procesamientos activos" value={data.activeProcessing} hint={data.activeProcessing > 0 ? 'En curso ahora' : 'Nada en cola'} />
            <Stat
              icon={HardDrive}
              label="Espacio utilizado"
              value={formatBytes(data.storageUsedBytes)}
              hint={<div className="space-y-1"><Progress value={data.storageUsedBytes / Math.max(1, data.storageQuotaBytes)} /><span>de {formatBytes(data.storageQuotaBytes)}</span></div>}
            />
            <Stat icon={Clock} label="Tiempo de video procesado" value={formatDuration(data.mediaDurationSec)} hint={<span className="flex items-center gap-1"><Timer className="size-3" /> {formatDuration(data.processingMs / 1000)} de cómputo</span>} />
          </div>
          <Card className="mt-6">
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>Últimos proyectos</CardTitle>
              <Link href="/proyectos" className="text-sm text-primary hover:underline">Ver todos</Link>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.recentProjects.length === 0 ? (
                <EmptyState
                  title="Aún no tienes proyectos"
                  description="Sube un video o pega un enlace y la IA encontrará los mejores momentos."
                  action={<Button asChild><Link href="/proyectos/nuevo"><Plus /> Crear el primero</Link></Button>}
                />
              ) : (
                data.recentProjects.map((p) => <ProjectRow key={p.id} p={p} />)
              )}
            </CardContent>
          </Card>
        </>
      )}
    </>
  );
}
