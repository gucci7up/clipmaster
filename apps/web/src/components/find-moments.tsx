'use client';

import { Loader2, Play, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Select } from './ui';
import { api, ApiError, Clip } from '@/lib/api';
import { formatTimecode } from '@/lib/utils';

interface Moment { at: number; start: number; end: number; text: string; matches: string[]; score: number }
interface MomentsResponse { query: string; total: number; moments: Moment[] }

/**
 * «Encontrar momentos»: busca una palabra o frase en la transcripción, salta a ese instante del original
 * y crea un clip a partir de ahí. La búsqueda es local (no envía nada fuera del servidor).
 */
export function FindMoments({ projectId, sourceDuration, onSeek }: { projectId: string; sourceDuration: number | null; onSeek?: (t: number) => void }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [length, setLength] = useState(30);
  const [result, setResult] = useState<MomentsResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState<number | null>(null);

  async function search(e: FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (query.length < 2) return;
    setSearching(true);
    try {
      setResult(await api<MomentsResponse>(`/projects/${projectId}/moments?q=${encodeURIComponent(query)}`));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo buscar');
    } finally {
      setSearching(false);
    }
  }

  async function create(m: Moment) {
    // Empieza un poco antes de la frase para dar contexto.
    let start = Math.max(0, Math.round((m.at - 3) * 10) / 10);
    let end = start + length;
    if (sourceDuration && end > sourceDuration) {
      end = Math.floor(sourceDuration * 10) / 10;
      start = Math.max(0, end - length);
    }
    setCreating(m.at);
    try {
      const clip = await api<Clip>(`/projects/${projectId}/clips`, { method: 'POST', json: { start, end, title: m.text.slice(0, 80) } });
      toast.success('Clip creado. Se está renderizando.');
      router.push(`/clips/${clip.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear el clip');
    } finally {
      setCreating(null);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Encontrar momentos</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={search} className="flex gap-2">
          <Input aria-label="Qué buscas" placeholder="Escribe lo que se dice: «capicúa», «doble seis», «no lo puedo creer»…" maxLength={200} value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" disabled={q.trim().length < 2} loading={searching}><Search /> Buscar</Button>
        </form>
        {result && (
          result.total === 0 ? <p className="text-sm text-muted-foreground">Este proyecto aún no tiene transcripción.</p>
            : result.moments.length === 0 ? <p className="text-sm text-muted-foreground">No se dice «{result.query}» en el video. Prueba con otra palabra.</p>
              : (
                <>
                  <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{result.moments.length} {result.moments.length === 1 ? 'momento' : 'momentos'}</span>
                    <label className="flex items-center gap-2">Duración del clip
                      <Select aria-label="Duración del clip" value={String(length)} onChange={(e) => setLength(Number(e.target.value))} className="h-8 w-20">
                        {[15, 30, 45, 60, 90].map((n) => <option key={n} value={n}>{n} s</option>)}
                      </Select>
                    </label>
                  </div>
                  <ul className="max-h-96 space-y-2 overflow-y-auto">
                    {result.moments.map((m) => (
                      <li key={m.at} className="rounded-lg border p-3 text-sm">
                        <p><span className="mr-2 font-mono text-xs text-primary">{formatTimecode(m.at)}</span><Highlighted text={m.text} matches={m.matches} /></p>
                        <div className="mt-2 flex gap-2">
                          {onSeek && <Button size="sm" variant="secondary" onClick={() => onSeek(Math.max(0, m.at - 1))}><Play /> Ver</Button>}
                          <Button size="sm" variant="outline" disabled={creating !== null} onClick={() => create(m)}>
                            {creating === m.at ? <Loader2 className="animate-spin" /> : <Plus />} Crear clip de {length} s
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )
        )}
      </CardContent>
    </Card>
  );
}

function Highlighted({ text, matches }: { text: string; matches: string[] }) {
  const set = new Set(matches);
  return <>{text.split(/(\s+)/).map((part, i) => (set.has(part) ? <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">{part}</mark> : part))}</>;
}
