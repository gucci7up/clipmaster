'use client';

import { CONTENT_MODES, DEFAULT_SUBTITLE_STYLE, MODES } from '@clipmaster/shared';
import type { AspectRatio, ContentMode, SignalWeights, SubtitleStyle } from '@clipmaster/shared';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { toast } from 'sonner';
import { PageHeader } from '@/components/common';
import { SubtitleControls } from '@/components/subtitle-controls';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select, Skeleton, Switch } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

interface SettingsResponse {
  settings: { defaultMode: ContentMode; defaultAspect: AspectRatio; defaultLanguage: string | null; theme: string; subtitleStyle: Partial<SubtitleStyle> | null };
  ai: { weights: Partial<SignalWeights> | null; visualAnalysis: boolean; semanticLLM: boolean };
  llmProvider: string | null;
}

const SIGNALS: { k: keyof SignalWeights; l: string }[] = [
  { k: 'semantic', l: 'Semántica (texto)' }, { k: 'emotion', l: 'Emoción / risas' }, { k: 'audio', l: 'Energía de audio' },
  { k: 'visual', l: 'Movimiento visual' }, { k: 'chat', l: 'Chat (directos)' }, { k: 'narrative', l: 'Narrativa' }, { k: 'standalone', l: 'Se entiende solo' },
];

function errMsg(err: unknown) {
  return err instanceof ApiError ? err.message : 'No se pudo guardar';
}

export default function SettingsPage() {
  const { data, mutate } = useSWR<SettingsResponse>('/settings');
  const { theme, setTheme } = useTheme();
  const [mode, setMode] = useState<ContentMode>('AUTO');
  const [aspect, setAspect] = useState<AspectRatio>('VERTICAL');
  const [language, setLanguage] = useState('es');
  const [style, setStyleState] = useState<SubtitleStyle>(DEFAULT_SUBTITLE_STYLE);
  const [customWeights, setCustomWeights] = useState(false);
  const [weights, setWeights] = useState<SignalWeights>(MODES.AUTO.weights);
  const [visual, setVisual] = useState(true);
  const [llm, setLlm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });

  useEffect(() => {
    if (!data) return;
    setMode(data.settings.defaultMode);
    setAspect(data.settings.defaultAspect);
    setLanguage(data.settings.defaultLanguage ?? '');
    setStyleState({ ...DEFAULT_SUBTITLE_STYLE, ...data.settings.subtitleStyle });
    setCustomWeights(!!data.ai.weights);
    setWeights({ ...MODES.AUTO.weights, ...data.ai.weights });
    setVisual(data.ai.visualAnalysis);
    setLlm(data.ai.semanticLLM);
  }, [data]);

  async function run(key: string, fn: () => Promise<unknown>, ok: string) {
    setBusy(key);
    try {
      await fn();
      await mutate();
      toast.success(ok);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="space-y-4"><Skeleton className="h-10 w-48" /><Skeleton className="h-64" /></div>;

  const setStyle = <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]) => setStyleState((s) => ({ ...s, [k]: v }));

  return (
    <>
      <PageHeader title="Ajustes" description="Preferencias de tu cuenta y del motor de IA" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Apariencia</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-3 gap-2">
              {([['light', 'Claro', Sun], ['dark', 'Oscuro', Moon], ['system', 'Sistema', Monitor]] as const).map(([v, l, Icon]) => (
                <button key={v} type="button" onClick={() => { setTheme(v); void api('/settings', { method: 'PUT', json: { theme: v } }).catch(() => undefined); }}
                  className={cn('flex flex-col items-center gap-1.5 rounded-lg border p-3 text-sm', theme === v ? 'border-primary bg-primary/5 text-primary' : 'hover:bg-muted')}>
                  <Icon className="size-5" />{l}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Valores predeterminados</CardTitle><CardDescription>Se aplican al crear un proyecto nuevo.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1"><Label htmlFor="dm">Modo</Label>
                <Select id="dm" value={mode} onChange={(e) => setMode(e.target.value as ContentMode)}>{CONTENT_MODES.map((m) => <option key={m} value={m}>{MODES[m].label}</option>)}</Select></div>
              <div className="space-y-1"><Label htmlFor="da">Formato</Label>
                <Select id="da" value={aspect} onChange={(e) => setAspect(e.target.value as AspectRatio)}><option value="VERTICAL">9:16</option><option value="HORIZONTAL">16:9</option><option value="SQUARE">1:1</option></Select></div>
              <div className="space-y-1"><Label htmlFor="dl">Idioma</Label>
                <Select id="dl" value={language} onChange={(e) => setLanguage(e.target.value)}><option value="">Automático</option><option value="es">Español</option><option value="en">Inglés</option><option value="pt">Portugués</option></Select></div>
            </div>
            <Button loading={busy === 'defaults'} onClick={() => run('defaults', () => api('/settings', { method: 'PUT', json: { defaultMode: mode, defaultAspect: aspect, defaultLanguage: language } }), 'Preferencias guardadas')}>Guardar</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Subtítulos predeterminados</CardTitle><CardDescription>Estilo que se aplica a los clips nuevos.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <SubtitleControls style={style} setStyle={setStyle} />
            <Button loading={busy === 'style'} onClick={() => run('style', () => api('/settings', { method: 'PUT', json: { subtitleStyle: style } }), 'Estilo guardado')}>Guardar estilo</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Motor de IA</CardTitle><CardDescription>{data.llmProvider?.startsWith('nvidia:') ? 'Transcripción, señales y render se ejecutan en tu servidor. El LLM usa la API de NVIDIA.' : 'Todo se ejecuta en tu servidor.'}</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            <label className="flex items-center justify-between gap-4 text-sm"><span>Análisis visual<span className="block text-xs text-muted-foreground">Movimiento, cambios de escena y rostros (OpenCV)</span></span><Switch checked={visual} onCheckedChange={setVisual} label="Análisis visual" /></label>
            <label className="flex items-center justify-between gap-4 text-sm"><span>LLM semántico<span className="block text-xs text-muted-foreground">{!data.llmProvider ? 'El administrador no ha configurado ningún proveedor (Ollama o NVIDIA).' : data.llmProvider.startsWith('nvidia:') ? `NVIDIA (${data.llmProvider.slice(7)}): los fragmentos de transcripción de los candidatos se envían a NVIDIA.` : `Ollama local (${data.llmProvider.slice(7)}): no sale nada del servidor.`}</span></span><Switch checked={llm} onCheckedChange={setLlm} disabled={!data.llmProvider && !llm} label="LLM semántico" /></label>
            <label className="flex items-center justify-between gap-4 text-sm"><span>Pesos personalizados<span className="block text-xs text-muted-foreground">Si está desactivado se usan los pesos de cada modo</span></span><Switch checked={customWeights} onCheckedChange={setCustomWeights} label="Pesos personalizados" /></label>
            {customWeights && (
              <div className="space-y-2 rounded-lg border p-3">
                {SIGNALS.map(({ k, l }) => (
                  <div key={k} className="grid grid-cols-[1fr_120px_36px] items-center gap-2 text-sm">
                    <span>{l}</span>
                    <input type="range" min={0} max={1} step={0.05} value={weights[k] ?? 0} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} aria-label={l} />
                    <span className="text-right font-mono text-xs">{(weights[k] ?? 0).toFixed(2)}</span>
                  </div>
                ))}
              </div>
            )}
            <Button loading={busy === 'ai'} onClick={() => run('ai', () => api('/settings/ai', { method: 'PUT', json: { visualAnalysis: visual, semanticLLM: llm, weights: customWeights ? weights : null } }), 'Ajustes de IA guardados')}>Guardar</Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Cambiar contraseña</CardTitle><CardDescription>Se cerrarán todas tus sesiones.</CardDescription></CardHeader>
          <CardContent>
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              void run('pw', async () => { await api('/auth/change-password', { method: 'POST', json: pw }); window.location.href = '/login'; }, 'Contraseña actualizada');
            }}>
              <div className="space-y-1"><Label htmlFor="cp">Contraseña actual</Label><Input id="cp" type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></div>
              <div className="space-y-1"><Label htmlFor="np">Nueva contraseña</Label><Input id="np" type="password" autoComplete="new-password" minLength={10} required value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></div>
              <Button type="submit" loading={busy === 'pw'}>Actualizar contraseña</Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
