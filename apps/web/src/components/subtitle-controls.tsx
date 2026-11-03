'use client';

import type { SubtitleStyle } from '@clipmaster/shared';
import { Input, Label, Select, Switch } from './ui';

export function SubtitleControls({ style, setStyle }: { style: SubtitleStyle; setStyle: <K extends keyof SubtitleStyle>(k: K, v: SubtitleStyle[K]) => void }) {
  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label htmlFor="preset">Estilo</Label>
          <Select id="preset" value={style.preset} onChange={(e) => setStyle('preset', e.target.value as SubtitleStyle['preset'])}>
            <option value="tiktok">TikTok (palabra resaltada)</option>
            <option value="karaoke">Karaoke</option>
            <option value="clean">Limpio</option>
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
      </div>
      <div className="grid grid-cols-3 gap-3">
        {([['primaryColor', 'Texto'], ['highlightColor', 'Resaltado'], ['outlineColor', 'Borde']] as const).map(([k, l]) => (
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
