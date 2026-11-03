'use client';

import { BUILTIN_FONTS } from '@clipmaster/shared';
import type { SubtitleStyle } from '@clipmaster/shared';
import useSWR from 'swr';
import type { UserFontRow } from '@/lib/api';
import { Input, Label, Select, Switch } from './ui';

const PRESETS: { v: SubtitleStyle['preset']; l: string }[] = [
  { v: 'tiktok', l: 'TikTok (palabra resaltada)' },
  { v: 'karaoke', l: 'Karaoke' },
  { v: 'neon', l: 'Neón (brillo)' },
  { v: 'podcast', l: 'Podcast (caja)' },
  { v: 'minimal', l: 'Minimal' },
  { v: 'clean', l: 'Limpio' },
];

export function SubtitleControls({ style, setStyle }: { style: SubtitleStyle; setStyle: <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]) => void }) {
  const { data: fonts } = useSWR<UserFontRow[]>('/fonts');
  const font = style.font ?? 'Montserrat';
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="preset">Plantilla</Label>
          <Select id="preset" value={style.preset} onChange={(e) => setStyle('preset', e.target.value as SubtitleStyle['preset'])}>
            {PRESETS.map((p) => <option key={p.v} value={p.v}>{p.l}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="font">Fuente</Label>
          <Select id="font" value={font} onChange={(e) => setStyle('font', e.target.value)}>
            <optgroup label="Incluidas">
              {BUILTIN_FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
            </optgroup>
            {!!fonts?.length && (
              <optgroup label="Tus fuentes">
                {fonts.map((f) => <option key={f.id} value={`custom:${f.id}`}>{f.family}</option>)}
              </optgroup>
            )}
            {font.startsWith('custom:') && fonts && !fonts.some((f) => `custom:${f.id}` === font) && <option value={font}>Fuente eliminada</option>}
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="pos">Posición</Label>
          <Select id="pos" value={style.position} onChange={(e) => setStyle('position', e.target.value as SubtitleStyle['position'])}>
            <option value="top">Arriba</option><option value="center">Centro</option><option value="bottom">Abajo</option>
          </Select>
        </div>
        <div className="space-y-1"><Label htmlFor="fs">Tamaño</Label><Input id="fs" type="number" min={24} max={160} value={style.fontSize} onChange={(e) => setStyle('fontSize', Number(e.target.value))} /></div>
        <div className="space-y-1"><Label htmlFor="wpl">Palabras/línea</Label><Input id="wpl" type="number" min={1} max={10} value={style.maxWordsPerLine} onChange={(e) => setStyle('maxWordsPerLine', Number(e.target.value))} /></div>
        <div className="space-y-1"><Label htmlFor="ow">Borde</Label><Input id="ow" type="number" min={0} max={12} step={0.5} value={style.outlineWidth} onChange={(e) => setStyle('outlineWidth', Number(e.target.value))} /></div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {([['primaryColor', 'Texto'], ['highlightColor', style.preset === 'neon' ? 'Brillo' : 'Resaltado'], ['outlineColor', style.preset === 'podcast' ? 'Caja' : 'Borde']] as const).map(([k, l]) => (
          <label key={k} className="space-y-1 text-xs font-medium">
            {l}
            <input type="color" value={style[k]} onChange={(e) => setStyle(k, e.target.value.toUpperCase())} className="block h-8 w-full cursor-pointer rounded border bg-transparent" />
          </label>
        ))}
      </div>
      <label className="flex items-center justify-between text-sm"><span>Mayúsculas</span><Switch checked={style.uppercase} onCheckedChange={(v) => setStyle('uppercase', v)} label="Mayúsculas" /></label>
    </div>
  );
}
