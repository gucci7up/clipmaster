'use client';

import { Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Button } from './ui';
import { api, ApiError, uploadWithProgress, UserFontRow } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

/** Subida y gestión de fuentes propias para los subtítulos. */
export function FontManager() {
  const { data: fonts, mutate } = useSWR<UserFontRow[]>('/fonts');
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);

  async function upload(file: File) {
    if (file.size > 10 * 1024 * 1024) return toast.error('La fuente supera 10 MB');
    const form = new FormData();
    form.append('file', file);
    setProgress(0);
    try {
      const font = await uploadWithProgress<UserFontRow>('/fonts', form, setProgress);
      await mutate();
      toast.success(`Fuente «${font.family}» añadida`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo subir la fuente');
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  return (
    <div className="space-y-2">
      {!!fonts?.length && (
        <ul className="divide-y rounded-lg border text-sm">
          {fonts.map((f) => (
            <li key={f.id} className="flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0 truncate"><span className="font-medium">{f.family}</span> <span className="text-xs text-muted-foreground">· {f.fileName} · {formatBytes(f.sizeBytes)}</span></span>
              <Button size="sm" variant="ghost" aria-label={`Borrar ${f.family}`} onClick={async () => {
                try { await api(`/fonts/${f.id}`, { method: 'DELETE' }); await mutate(); } catch (err) { toast.error(err instanceof ApiError ? err.message : 'No se pudo borrar'); }
              }}><Trash2 className="size-4" /></Button>
            </li>
          ))}
        </ul>
      )}
      <input ref={input} type="file" accept=".ttf,.otf,font/ttf,font/otf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
      <Button type="button" variant="outline" loading={progress !== null} onClick={() => input.current?.click()}>
        <Upload /> {progress !== null ? `Subiendo ${Math.round(progress * 100)} %` : 'Subir fuente'}
      </Button>
    </div>
  );
}
