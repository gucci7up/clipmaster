'use client';

import { CONTENT_MODES, detectProvider, DURATION_PRESETS, MODES, PROVIDERS } from '@clipmaster/shared';
import type { AspectRatio, ContentMode } from '@clipmaster/shared';
import { CheckCircle2, FileVideo, Link2, Loader2, Radio, Upload, Wand2, XCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Progress, Select, Switch, Tabs } from '@/components/ui';
import { api, ApiError, ProjectDetail, uploadWithProgress, ValidationResult } from '@/lib/api';
import { cn, formatDuration } from '@/lib/utils';

const ACCEPT = '.mp4,.mov,.m4v,.webm,.mkv,video/mp4,video/quicktime,video/webm,video/x-matroska';
const LANGS = [
  { v: '', l: 'Detección automática' }, { v: 'es', l: 'Español' }, { v: 'en', l: 'Inglés' },
  { v: 'pt', l: 'Portugués' }, { v: 'fr', l: 'Francés' }, { v: 'it', l: 'Italiano' },
];
const ASPECTS: { v: AspectRatio; l: string; box: string }[] = [
  { v: 'VERTICAL', l: '9:16 Vertical', box: 'h-8 w-[18px]' },
  { v: 'HORIZONTAL', l: '16:9 Horizontal', box: 'h-[18px] w-8' },
  { v: 'SQUARE', l: '1:1 Cuadrado', box: 'size-6' },
];

export default function NewProjectPage() {
  const router = useRouter();
  const { data: settings } = useSWR<{ settings: { defaultMode: ContentMode; defaultAspect: AspectRatio; defaultLanguage: string | null } }>('/settings');
  const [source, setSource] = useState<'upload' | 'url'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [validating, setValidating] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [name, setName] = useState('');
  const [mode, setMode] = useState<ContentMode>('AUTO');
  const [language, setLanguage] = useState('es');
  const [maxClips, setMaxClips] = useState(8);
  const [preset, setPreset] = useState<'SHORT' | 'MEDIUM' | 'LONG' | 'CUSTOM'>('MEDIUM');
  const [minDuration, setMinDuration] = useState(30);
  const [maxDuration, setMaxDuration] = useState(60);
  const [aspect, setAspect] = useState<AspectRatio>('VERTICAL');
  const [subtitles, setSubtitles] = useState(true);
  const [smart, setSmart] = useState(true);
  const [preference, setPreference] = useState('balanced');
  const [captureLive, setCaptureLive] = useState(true);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setMode(settings.settings.defaultMode);
    setAspect(settings.settings.defaultAspect);
    setLanguage(settings.settings.defaultLanguage ?? '');
  }, [settings]);

  useEffect(() => {
    if (preset !== 'CUSTOM') {
      setMinDuration(DURATION_PRESETS[preset].min);
      setMaxDuration(DURATION_PRESETS[preset].max);
    }
  }, [preset]);

  const detected = useMemo(() => (url ? detectProvider(url) : null), [url]);
  const providerInfo = PROVIDERS.find((p) => p.id === (validation?.provider ?? detected));

  async function validate() {
    setValidating(true);
    setValidation(null);
    try {
      const v = await api<ValidationResult>('/projects/validate-url', { method: 'POST', json: { url } });
      setValidation(v);
      if (v.ok && v.title && !name) setName(v.title.slice(0, 120));
    } catch (err) {
      setValidation({ ok: false, provider: detected, isLive: false, title: null, durationSec: null, thumbnail: null, supportsLive: false, reason: err instanceof ApiError ? err.message : 'Error al validar', notes: null });
    } finally {
      setValidating(false);
    }
  }

  function pickFile(f: File | undefined | null) {
    if (!f) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, '').slice(0, 120));
  }

  const options = { name: name.trim(), mode, language, maxClips, minDuration, maxDuration, aspect, subtitles, smartDetection: smart, preference };
  const durationError = maxDuration < minDuration + 5 ? 'La duración máxima debe superar a la mínima en al menos 5 s' : null;
  const canSubmit = !!options.name && !durationError && !submitting && (source === 'upload' ? !!file : !!validation?.ok && authorized);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      let project: ProjectDetail;
      if (source === 'upload' && file) {
        const form = new FormData();
        Object.entries(options).forEach(([k, v]) => form.append(k, String(v)));
        form.append('file', file);
        setUploadPct(0);
        project = await uploadWithProgress<ProjectDetail>('/projects/upload', form, setUploadPct);
      } else {
        project = await api<ProjectDetail>('/projects', { method: 'POST', json: { ...options, url, authorized, captureLive } });
      }
      toast.success('Proyecto creado. El procesamiento ha comenzado.');
      router.push(`/proyectos/${project.id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'No se pudo crear el proyecto');
      setUploadPct(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <PageHeader title="Nuevo proyecto" description="Sube un video o pega un enlace; la IA detectará los mejores momentos." />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Fuente del video</CardTitle>
              <CardDescription>Procesa sólo contenido propio o para el que tengas autorización.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Tabs value={source} onChange={setSource} items={[{ value: 'upload', label: <span className="flex items-center gap-1.5"><Upload className="size-4" /> Subir MP4</span> }, { value: 'url', label: <span className="flex items-center gap-1.5"><Link2 className="size-4" /> Enlace</span> }]} />
              {source === 'upload' ? (
                <div
                  onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                  onDragLeave={() => setDrag(false)}
                  onDrop={(e) => { e.preventDefault(); setDrag(false); pickFile(e.dataTransfer.files[0]); }}
                  onClick={() => inputRef.current?.click()}
                  className={cn('flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors', drag ? 'border-primary bg-primary/5' : 'hover:border-primary/50')}
                >
                  <input ref={inputRef} type="file" accept={ACCEPT} className="hidden" onChange={(e) => pickFile(e.target.files?.[0])} />
                  <FileVideo className="size-10 text-primary" />
                  {file ? (
                    <><p className="mt-3 font-medium">{file.name}</p><p className="text-sm text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB · haz clic para cambiar</p></>
                  ) : (
                    <><p className="mt-3 font-medium">Arrastra tu video aquí o haz clic</p><p className="text-sm text-muted-foreground">MP4, MOV, WEBM o MKV</p></>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex gap-2">
                    <Input placeholder="https://www.youtube.com/watch?v=… · twitch.tv/… · kick.com/… · .m3u8 · .mp4" value={url} onChange={(e) => { setUrl(e.target.value); setValidation(null); }} />
                    <Button type="button" variant="secondary" onClick={validate} disabled={!detected || validating} loading={validating}>Validar</Button>
                  </div>
                  {url && (
                    <p className="text-xs text-muted-foreground">
                      {detected ? <>Plataforma detectada: <b>{PROVIDERS.find((p) => p.id === detected)?.label}</b></> : 'Plataforma no compatible'}
                    </p>
                  )}
                  {validation && (
                    <div className={cn('flex gap-3 rounded-lg border p-3 text-sm', validation.ok ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5')}>
                      {validation.ok ? <CheckCircle2 className="size-5 shrink-0 text-success" /> : <XCircle className="size-5 shrink-0 text-destructive" />}
                      <div className="min-w-0 space-y-1">
                        {validation.ok && validation.deferred ? (
                          <>
                            <p className="font-medium">Enlace aceptado</p>
                            <p className={validation.agentOnline ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}>{validation.notes}</p>
                          </>
                        ) : validation.ok ? (
                          <>
                            <p className="font-medium">{validation.title ?? 'Contenido accesible'}</p>
                            <p className="text-muted-foreground">
                              {validation.isLive ? <span className="inline-flex items-center gap-1 font-semibold text-red-500"><Radio className="size-3.5" /> En vivo</span> : `Video grabado · ${formatDuration(validation.durationSec)}`}
                            </p>
                          </>
                        ) : (
                          <p>{validation.reason}</p>
                        )}
                        {providerInfo?.notes && <p className="text-xs text-muted-foreground">{providerInfo.notes}</p>}
                      </div>
                    </div>
                  )}
                  {validation?.ok && validation.isLive && (
                    <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                      <span>Capturar el directo y generar clips de forma incremental</span>
                      <Switch checked={captureLive} onCheckedChange={setCaptureLive} label="Capturar directo" />
                    </label>
                  )}
                  <label className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
                    <span>Confirmo que soy propietario de este contenido o tengo autorización para procesarlo.</span>
                  </label>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Detalles</CardTitle></CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2 sm:col-span-2"><Label htmlFor="name">Nombre del proyecto</Label><Input id="name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required /></div>
              <div className="space-y-2">
                <Label htmlFor="mode">Tipo de contenido</Label>
                <Select id="mode" value={mode} onChange={(e) => setMode(e.target.value as ContentMode)}>
                  {CONTENT_MODES.map((m) => <option key={m} value={m}>{MODES[m].label}</option>)}
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="lang">Idioma</Label>
                <Select id="lang" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGS.map((l) => <option key={l.v} value={l.v}>{l.l}</option>)}
                </Select>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Clips</CardTitle></CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <div className="flex justify-between text-sm"><Label>Cantidad máxima</Label><span className="font-medium">{maxClips}</span></div>
                <input type="range" min={1} max={30} value={maxClips} onChange={(e) => setMaxClips(Number(e.target.value))} className="w-full" aria-label="Cantidad máxima de clips" />
              </div>
              <div className="space-y-2">
                <Label>Duración</Label>
                <Select value={preset} onChange={(e) => setPreset(e.target.value as typeof preset)}>
                  <option value="SHORT">Cortos (15–30 s)</option>
                  <option value="MEDIUM">Medianos (30–60 s)</option>
                  <option value="LONG">Largos (60–180 s)</option>
                  <option value="CUSTOM">Personalizada</option>
                </Select>
                {preset === 'CUSTOM' && (
                  <div className="grid grid-cols-2 gap-2">
                    <Input type="number" min={5} max={180} value={minDuration} onChange={(e) => setMinDuration(Number(e.target.value))} aria-label="Duración mínima" />
                    <Input type="number" min={10} max={300} value={maxDuration} onChange={(e) => setMaxDuration(Number(e.target.value))} aria-label="Duración máxima" />
                  </div>
                )}
                {durationError && <p className="text-xs text-destructive">{durationError}</p>}
              </div>
              <div className="space-y-2">
                <Label>Formato de salida</Label>
                <div className="grid grid-cols-3 gap-2">
                  {ASPECTS.map((a) => (
                    <button type="button" key={a.v} onClick={() => setAspect(a.v)} className={cn('flex flex-col items-center gap-2 rounded-lg border p-3 text-xs transition-colors', aspect === a.v ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-muted')}>
                      <span className={cn('rounded-sm border-2 border-current', a.box)} />{a.l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="pref">Preferencia de selección</Label>
                <Select id="pref" value={preference} onChange={(e) => setPreference(e.target.value)}>
                  <option value="balanced">Equilibrada</option>
                  <option value="quality">Calidad (menos clips, más exigente)</option>
                  <option value="quantity">Cantidad (más clips)</option>
                </Select>
              </div>
              <label className="flex items-center justify-between text-sm"><span>Subtítulos automáticos</span><Switch checked={subtitles} onCheckedChange={setSubtitles} label="Subtítulos" /></label>
              <label className="flex items-center justify-between text-sm">
                <span>Detección inteligente<span className="block text-xs text-muted-foreground">Análisis visual y semántico avanzado</span></span>
                <Switch checked={smart} onCheckedChange={setSmart} label="Detección inteligente" />
              </label>
            </CardContent>
          </Card>
          {uploadPct != null && (
            <Card className="p-4">
              <div className="mb-2 flex items-center justify-between text-sm"><span className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Subiendo video</span><span>{Math.round(uploadPct * 100)}%</span></div>
              <Progress value={uploadPct} />
            </Card>
          )}
          <Button type="submit" size="lg" className="w-full" disabled={!canSubmit} loading={submitting}><Wand2 /> Iniciar procesamiento</Button>
        </div>
      </div>
    </form>
  );
}
