'use client';

import { BUILTIN_FONTS, DEFAULT_THUMBNAIL_STYLE } from '@clipmaster/shared';
import type { AspectRatio, ThumbnailStyle } from '@clipmaster/shared';
import { Download, ImageIcon, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Switch } from './ui';
import { api, ApiError, Clip, UserFontRow } from '@/lib/api';
import { formatTimecode } from '@/lib/utils';

interface Config {
  at: number;
  aspect: AspectRatio;
  background: 'frame' | 'ai';
  cutout: boolean;
  prompt: string;
  text: string;
  style: ThumbnailStyle;
}

function initial(clip: Clip): Config {
  const saved = clip.thumbConfig;
  return {
    at: saved?.at ?? Math.min(1, clip.duration / 2),
    aspect: saved?.aspect ?? clip.aspect,
    background: saved?.background ?? 'frame',
    cutout: saved?.cutout ?? true,
    prompt: saved?.prompt ?? '',
    text: saved?.text ?? clip.hookText ?? clip.title,
    style: { ...DEFAULT_THUMBNAIL_STYLE, ...saved?.style },
  };
}

/**
 * Miniatura o portada del clip. Con «Persona recortada», la persona del fotograma elegido se recorta (en el servidor,
 * sin IA externa) y se pone con borde blanco delante de un fondo, con el título al lado o encima. Si no, el fotograma
 * completo o una imagen de IA con el título. Se genera en el render-worker al tamaño de cada red.
 */
export function ThumbnailMaker({ clip, aiMedia, onChange }: { clip: Clip; aiMedia: boolean; onChange: (c: Clip) => void }) {
  const [c, setC] = useState<Config>(() => initial(clip));
  const [busy, setBusy] = useState(false);
  // Duración real del render (en los clips combinados no incluye el hueco entre tramos).
  const [length, setLength] = useState(clip.duration);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { data: fonts } = useSWR<UserFontRow[]>('/fonts');
  const pending = clip.thumbStatus === 'PENDING';
  const needsFrame = c.cutout || c.background === 'frame';
  const set = <K extends keyof Config>(k: K, v: Config[K]) => setC((x) => ({ ...x, [k]: v }));
  const setStyle = <K extends keyof ThumbnailStyle>(k: K, v: ThumbnailStyle[K]) => setC((x) => ({ ...x, style: { ...x.style, [k]: v } }));

  function seek(t: number) {
    set('at', t);
    if (videoRef.current) videoRef.current.currentTime = t;
  }

  async function generate() {
    setBusy(true);
    try {
      onChange(await api<Clip>(`/clips/${clip.id}/thumbnail`, {
        method: 'POST',
        json: { ...c, prompt: c.background === 'ai' ? c.prompt : null },
      }));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo generar la miniatura');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Miniatura y portada</CardTitle></CardHeader>
      <CardContent className="space-y-4 text-sm">
        {clip.thumbUrl && (
          <div className="flex items-end gap-3">
            <img src={clip.thumbUrl} alt="Miniatura del clip" className="max-h-48 rounded-lg border" />
            {clip.thumbDownloadUrl && <Button size="sm" variant="outline" asChild><a href={clip.thumbDownloadUrl}><Download /> Descargar</a></Button>}
          </div>
        )}
        {pending && <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" /> Generando la miniatura… (comparte la cola con los renders)</p>}
        {clip.thumbStatus === 'FAILED' && clip.thumbError && <p className="text-xs text-destructive">No se pudo generar: {clip.thumbError}</p>}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label htmlFor="th-layout">Diseño</Label>
            <Select id="th-layout" value={c.cutout ? 'cutout' : 'full'} onChange={(e) => set('cutout', e.target.value === 'cutout')}>
              <option value="cutout">Persona recortada + título</option>
              <option value="full">Fotograma completo + título</option>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="th-bg">Fondo</Label>
            <Select id="th-bg" value={c.background} onChange={(e) => set('background', e.target.value as Config['background'])}>
              <option value="frame">{c.cutout ? 'El mismo video, desenfocado' : 'Fotograma del video'}</option>
              <option value="ai" disabled={!aiMedia}>Imagen generada con IA{aiMedia ? '' : ' (actívala en Ajustes)'}</option>
            </Select>
          </div>
        </div>
        {needsFrame && (
          <div className="space-y-2">
            {clip.videoUrl ? (
              <>
                <video ref={videoRef} src={clip.videoUrl} muted playsInline preload="metadata" className="max-h-56 w-full rounded-lg bg-black"
                  onLoadedMetadata={(e) => { const v = e.currentTarget; if (Number.isFinite(v.duration)) setLength(v.duration); v.currentTime = c.at; }} />
                <input type="range" min={0} max={Math.max(0, length - 0.1)} step={0.1} value={c.at} onChange={(e) => seek(Number(e.target.value))} className="w-full" aria-label="Instante del fotograma" />
                <p className="text-xs text-muted-foreground">
                  Fotograma en {formatTimecode(c.at)}, sin subtítulos. {c.cutout ? 'Elige un instante en el que la persona se vea bien: se recorta en tu servidor.' : 'Se encuadra sobre la persona.'}
                </p>
              </>
            ) : <p className="text-xs text-muted-foreground">Espera a que el clip termine de renderizarse para elegir el fotograma.</p>}
          </div>
        )}
        {c.background === 'ai' && (
          <div className="space-y-1">
            <Label htmlFor="th-prompt">Describe el fondo (opcional)</Label>
            <Input id="th-prompt" maxLength={600} placeholder="Vacío: se usa el título del clip para crear el fondo" value={c.prompt} onChange={(e) => set('prompt', e.target.value)} />
            <p className="text-xs text-muted-foreground">
              {aiMedia ? 'Se envía a NVIDIA la descripción (o el título y el gancho del clip); el fotograma no sale del servidor.'
                : <>Requiere <Link href="/ajustes" className="underline">«Funciones de IA de NVIDIA»</Link>.</>}
            </p>
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="th-text">Texto</Label>
          <Input id="th-text" maxLength={120} placeholder="Sin texto" value={c.text} onChange={(e) => set('text', e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1"><Label htmlFor="th-aspect">Formato</Label>
            <Select id="th-aspect" value={c.aspect} onChange={(e) => set('aspect', e.target.value as AspectRatio)}>
              <option value="VERTICAL">9:16 (TikTok, Reels)</option>
              <option value="HORIZONTAL">16:9 (YouTube)</option>
              <option value="SQUARE">1:1</option>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="th-font">Fuente</Label>
            <Select id="th-font" value={c.style.font} onChange={(e) => setStyle('font', e.target.value)}>
              <optgroup label="Incluidas">{BUILTIN_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}</optgroup>
              {!!fonts?.length && <optgroup label="Tus fuentes">{fonts.map((f) => <option key={f.id} value={`custom:${f.id}`}>{f.family}</option>)}</optgroup>}
            </Select></div>
          {!c.cutout && <div className="space-y-1"><Label htmlFor="th-pos">Posición</Label>
            <Select id="th-pos" value={c.style.position} onChange={(e) => setStyle('position', e.target.value as ThumbnailStyle['position'])}>
              <option value="top">Arriba</option><option value="center">Centro</option><option value="bottom">Abajo</option>
            </Select></div>}
          <div className="space-y-1"><Label htmlFor="th-size">Tamaño</Label>
            <Select id="th-size" value={c.style.size} onChange={(e) => setStyle('size', e.target.value as ThumbnailStyle['size'])}>
              <option value="m">Mediano</option><option value="l">Grande</option><option value="xl">Enorme</option>
            </Select></div>
          <div className="space-y-1"><Label htmlFor="th-look">Estilo</Label>
            <Select id="th-look" value={c.style.look} onChange={(e) => setStyle('look', e.target.value as ThumbnailStyle['look'])}>
              <option value="outline">Borde grueso</option><option value="box">Caja de color</option>
            </Select></div>
          <label className="flex items-end justify-between gap-2 pb-2">Mayúsculas<Switch checked={c.style.uppercase} onCheckedChange={(v) => setStyle('uppercase', v)} label="Mayúsculas" /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {([['textColor', 'Texto'], ['strokeColor', c.style.look === 'box' ? 'Caja' : 'Borde']] as const).map(([k, l]) => (
            <label key={k} className="space-y-1 text-xs font-medium">{l}
              <input type="color" value={c.style[k]} onChange={(e) => setStyle(k, e.target.value.toUpperCase())} className="block h-8 w-full cursor-pointer rounded border bg-transparent" />
            </label>
          ))}
        </div>
        <Button className="w-full" disabled={pending || (needsFrame && !clip.videoUrl) || (c.background === 'ai' && !aiMedia)}
          loading={busy} onClick={generate}><ImageIcon /> {clip.thumbUrl ? 'Generar otra miniatura' : 'Generar miniatura'}</Button>
      </CardContent>
    </Card>
  );
}
