'use client';

import { ChevronLeft, ChevronRight, FolderKanban, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import useSWR from 'swr';
import { EmptyState, ErrorState, PageHeader, ProjectRow, STATUS } from '@/components/common';
import { Button, Input, Select, Skeleton } from '@/components/ui';
import type { Paged, Project, ProjectStatus } from '@/lib/api';

export default function ProjectsPage() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: '20', ...(status ? { status } : {}), ...(search ? { search } : {}) });
  const { data, error, isLoading } = useSWR<Paged<Project>>(`/projects?${qs}`, { keepPreviousData: true });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHeader title="Mis proyectos" description="Todos los videos y transmisiones procesados" actions={<Button asChild><Link href="/proyectos/nuevo"><Plus /> Nuevo</Link></Button>} />
      <div className="mb-4 flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Buscar por nombre…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        </div>
        <Select className="sm:w-56" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filtrar por estado">
          <option value="">Todos los estados</option>
          {(Object.keys(STATUS) as ProjectStatus[]).map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
        </Select>
      </div>
      {error && <ErrorState message={error.message} />}
      {isLoading && !data ? (
        <div className="space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : data && data.items.length === 0 ? (
        <EmptyState icon={FolderKanban} title={search || status ? 'Sin resultados' : 'No hay proyectos'} description={search || status ? 'Prueba con otros filtros.' : 'Crea tu primer proyecto para empezar.'} />
      ) : (
        <div className="space-y-2">{data?.items.map((p) => <ProjectRow key={p.id} p={p} />)}</div>
      )}
      {data && pages > 1 && (
        <div className="mt-4 flex items-center justify-center gap-2 text-sm">
          <Button variant="outline" size="icon" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label="Anterior"><ChevronLeft /></Button>
          <span>Página {page} de {pages}</span>
          <Button variant="outline" size="icon" disabled={page >= pages} onClick={() => setPage(page + 1)} aria-label="Siguiente"><ChevronRight /></Button>
        </div>
      )}
    </>
  );
}
