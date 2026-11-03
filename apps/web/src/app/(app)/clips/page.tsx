'use client';

import { ChevronLeft, ChevronRight, Film } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { ClipCard, EmptyState, ErrorState, PageHeader } from '@/components/common';
import { Button, Skeleton } from '@/components/ui';
import type { Clip, Paged } from '@/lib/api';

export default function ClipsPage() {
  const [page, setPage] = useState(1);
  const { data, error, isLoading } = useSWR<Paged<Clip>>(`/clips?page=${page}&pageSize=24`, { keepPreviousData: true });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="Clips generados" description={data ? `${data.total} clips en total` : undefined} />
      {error && <ErrorState message={error.message} />}
      {isLoading && !data ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-80" />)}</div>
      ) : data && data.items.length === 0 ? (
        <EmptyState icon={Film} title="Todavía no hay clips" description="Cuando un proyecto termine de procesarse, sus clips aparecerán aquí." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {data?.items.map((c) => (
            <div key={c.id} className="space-y-1">
              <p className="truncate px-1 text-xs text-muted-foreground">{c.project.name}</p>
              <ClipCard clip={c} />
            </div>
          ))}
        </div>
      )}
      {data && pages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-2 text-sm">
          <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Anterior"><ChevronLeft /></Button>
          <span>Página {page} de {pages}</span>
          <Button variant="outline" size="icon" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Siguiente"><ChevronRight /></Button>
        </div>
      )}
    </>
  );
}
