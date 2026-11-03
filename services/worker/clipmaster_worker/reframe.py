"""
Reencuadre inteligente: calcula una trayectoria suavizada del sujeto principal (rostros, o centro de
movimiento si no hay rostros) y la convierte en una expresión FFmpeg por tramos lineales para el
filtro crop. Si no hay señal suficiente se usa recorte central (o la posición manual).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .visual_signals import VisualSample


@dataclass
class CropPlan:
    crop_w: int
    crop_h: int
    x_expr: str
    y_expr: str
    out_w: int
    out_h: int
    keyframes: list[tuple[float, float, float]]  # (t, cx, cy) normalizados
    mode: str


def _even(v: float) -> int:
    return max(2, int(v) // 2 * 2)


def subject_track(samples: list[VisualSample], clip_start: float) -> list[tuple[float, float, float]]:
    """(t relativo, cx, cy) por muestra: rostro más grande; si no, centro de movimiento; si no, None."""
    raw: list[tuple[float, float | None, float | None]] = []
    for s in samples:
        if s.faces:
            f = max(s.faces, key=lambda b: b.w * b.h)
            raw.append((s.t - clip_start, f.cx, f.cy))
        elif s.motion_cx is not None and s.motion > 0.02:
            raw.append((s.t - clip_start, s.motion_cx, s.motion_cy))
        else:
            raw.append((s.t - clip_start, None, None))
    known = [r for r in raw if r[1] is not None]
    if len(known) < max(2, len(raw) * 0.2):
        return []
    # Relleno hacia delante/atrás de huecos y suavizado (EMA bidireccional + zona muerta).
    xs, ys = [], []
    last = (known[0][1], known[0][2])
    for _, x, y in raw:
        if x is not None:
            last = (x, y)
        xs.append(last[0])
        ys.append(last[1])
    xs_a, ys_a = _ema_bidir(np.array(xs, dtype=float), 0.25), _ema_bidir(np.array(ys, dtype=float), 0.25)
    xs_a = _deadzone(xs_a, 0.04)
    ys_a = _deadzone(ys_a, 0.04)
    return [(raw[i][0], float(xs_a[i]), float(ys_a[i])) for i in range(len(raw))]


def _ema_bidir(x: np.ndarray, alpha: float) -> np.ndarray:
    if len(x) == 0:
        return x
    f = x.copy()
    for i in range(1, len(x)):
        f[i] = alpha * x[i] + (1 - alpha) * f[i - 1]
    b = f.copy()
    for i in range(len(x) - 2, -1, -1):
        b[i] = alpha * f[i] + (1 - alpha) * b[i + 1]
    return b


def _deadzone(x: np.ndarray, dz: float) -> np.ndarray:
    """Mantiene el encuadre quieto mientras el sujeto se mueve menos que dz (evita temblores)."""
    if len(x) == 0:
        return x
    out = x.copy()
    anchor = x[0]
    for i in range(len(x)):
        if abs(x[i] - anchor) > dz:
            anchor = x[i] - np.sign(x[i] - anchor) * dz
        out[i] = anchor
    return out


def simplify(points: list[tuple[float, float]], tol: float, max_points: int = 24) -> list[tuple[float, float]]:
    """Douglas–Peucker sobre (t, v) para limitar el tamaño de la expresión FFmpeg."""
    if len(points) <= 2:
        return points

    def rdp(pts: list[tuple[float, float]], eps: float) -> list[tuple[float, float]]:
        if len(pts) <= 2:
            return pts
        (t0, v0), (t1, v1) = pts[0], pts[-1]
        best_i, best_d = 0, -1.0
        for i in range(1, len(pts) - 1):
            t, v = pts[i]
            interp = v0 + (v1 - v0) * (t - t0) / max(1e-9, t1 - t0)
            d = abs(v - interp)
            if d > best_d:
                best_i, best_d = i, d
        if best_d <= eps:
            return [pts[0], pts[-1]]
        return rdp(pts[: best_i + 1], eps)[:-1] + rdp(pts[best_i:], eps)

    eps = tol
    out = rdp(points, eps)
    while len(out) > max_points:
        eps *= 1.6
        out = rdp(points, eps)
    return out


def piecewise_expr(points: list[tuple[float, float]]) -> str:
    """Expresión FFmpeg (variable t) que interpola linealmente entre puntos (t, valor en píxeles)."""
    if not points:
        return "0"
    if len(points) == 1:
        return f"{points[0][1]:.1f}"
    expr = f"{points[-1][1]:.1f}"
    for (t0, v0), (t1, v1) in reversed(list(zip(points[:-1], points[1:]))):
        slope = (v1 - v0) / max(1e-6, t1 - t0)
        seg = f"({v0:.1f}+({slope:.4f})*(t-{t0:.3f}))"
        expr = f"if(lt(t\\,{t1:.3f})\\,{seg}\\,{expr})"
    return expr


def plan_crop(src_w: int, src_h: int, target_w: int, target_h: int, *, mode: str, track: list[tuple[float, float, float]],
              manual_x: float | None, manual_y: float | None, max_upscale: float) -> CropPlan:
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h
    if src_ratio > target_ratio:  # fuente más ancha: recorte horizontal
        crop_h = _even(src_h)
        crop_w = _even(src_h * target_ratio)
    else:  # fuente más estrecha/alta: recorte vertical
        crop_w = _even(src_w)
        crop_h = _even(src_w / target_ratio)
    # Sin prometer calidad irrecuperable: escalado máximo limitado.
    scale = min(target_w / crop_w, target_h / crop_h, max_upscale)
    out_w, out_h = _even(crop_w * scale), _even(crop_h * scale)
    max_x, max_y = src_w - crop_w, src_h - crop_h

    def px(cx: float) -> float:
        return float(np.clip(cx * src_w - crop_w / 2, 0, max_x))

    def py(cy: float) -> float:
        return float(np.clip(cy * src_h - crop_h / 2, 0, max_y))

    if mode == "manual" and manual_x is not None:
        x = px(manual_x)
        y = py(manual_y if manual_y is not None else 0.5)
        return CropPlan(crop_w, crop_h, f"{x:.1f}", f"{y:.1f}", out_w, out_h, [(0, manual_x, manual_y or 0.5)], "manual")
    if mode == "auto" and track and (max_x > 0 or max_y > 0):
        xs = simplify([(t, px(cx)) for t, cx, _ in track], tol=max(4.0, crop_w * 0.02))
        ys = simplify([(t, py(cy)) for t, _, cy in track], tol=max(4.0, crop_h * 0.02))
        return CropPlan(crop_w, crop_h, piecewise_expr(xs) if max_x > 0 else "0", piecewise_expr(ys) if max_y > 0 else "0",
                        out_w, out_h, track, "auto")
    return CropPlan(crop_w, crop_h, f"{max_x / 2:.1f}", f"{max_y / 2:.1f}", out_w, out_h, [(0, 0.5, 0.5)], "center")
