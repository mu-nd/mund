// A small SVG scatter chart with error bars (no dependencies).
//
// Identity is carried by colour *and* marker shape, a legend is always shown
// for two or more series, the nearest point answers to the pointer, and every
// value is also available in the tables below the chart.

import { h, clear } from '../core/dom.js';

const MARGIN = { top: 14, right: 16, bottom: 44, left: 62 };
const HEIGHT = 340;
const HIT_RADIUS = 28;

export const SERIES_STYLE = {
  EXP: { color: 'var(--ds-exp)', shape: 'circle' },
  TH: { color: 'var(--ds-th)', shape: 'triangle' },
  CUR: { color: 'var(--ds-cur)', shape: 'square' },
  EVAL: { color: 'var(--ds-eval)', shape: 'diamond' },
};

function markerPath(shape, r) {
  switch (shape) {
    case 'square': { const s = r * 0.9; return `M${-s},${-s}H${s}V${s}H${-s}Z`; }
    case 'triangle': { const s = r * 1.15; return `M0,${-s}L${s},${s * 0.85}L${-s},${s * 0.85}Z`; }
    case 'diamond': { const s = r * 1.2; return `M0,${-s}L${s},0L0,${s}L${-s},0Z`; }
    default: return `M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;
  }
}

function niceStep(span, target) {
  const raw = span / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

function tickText(v) {
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a >= 100000 || a < 0.0001) return v.toExponential().replace('e+', 'e');
  return String(Number(v.toPrecision(6)));
}

function linearScale(min, max, lo, hi) {
  const span = max - min || 1;
  const fn = (v) => lo + ((v - min) / span) * (hi - lo);
  fn.ticks = (count) => {
    const step = niceStep(span, count);
    const out = [];
    for (let v = Math.ceil(min / step - 1e-9) * step; v <= max + step * 1e-9; v += step) {
      out.push(Number(v.toPrecision(12)));
    }
    return out;
  };
  return fn;
}

function logScale(min, max, lo, hi) {
  const a = Math.log10(min);
  const b = Math.log10(max);
  const fn = (v) => (v > 0 ? lo + ((Math.log10(v) - a) / (b - a || 1)) * (hi - lo) : NaN);
  fn.ticks = () => {
    const out = [];
    for (let e = Math.ceil(a - 1e-9); e <= Math.floor(b + 1e-9); e++) out.push(10 ** e);
    return out;
  };
  return fn;
}

/**
 * @param container element that receives the chart
 * @param spec {
 *   series: [{ key, label, context?, points: [{ x, y, lo?, hi?, data }] }],
 *   x: { label, type: 'linear' | 'band', bands?: [{ key, label }], domain?: [min, max] },
 *   y: { label, log?: boolean },
 *   tooltip(point) -> Node, onSelect(point), selected?: (point) => boolean, keyOf?: (point) => string,
 *   emptyText
 * }
 */
export function renderChart(container, spec) {
  const draw = () => drawChart(container, spec);
  if (container._chartObserver) container._chartObserver.disconnect();
  container._chartObserver = new ResizeObserver(() => {
    if (container.clientWidth !== container._chartWidth) draw();
  });
  container._chartObserver.observe(container);
  draw();
}

function drawChart(container, spec) {
  clear(container);
  container.classList.add('chart');
  const width = Math.max(300, container.clientWidth || 600);
  container._chartWidth = container.clientWidth;
  const series = spec.series.filter((s) => s.points.length);
  const all = series.flatMap((s) => s.points.map((p) => ({ ...p, series: s })));
  const usable = all.filter((p) => Number.isFinite(p.y) && (!spec.y.log || p.y > 0));

  if (!usable.length) {
    container.appendChild(h('p', { class: 'chart-empty muted' }, spec.emptyText || 'No data to plot.'));
    return;
  }

  // ---- legend (always, for two or more series) -----------------------------
  if (series.length > 1) {
    container.appendChild(h('div', { class: 'chart-legend' }, series.map((s) => {
      const style = SERIES_STYLE[s.key] || SERIES_STYLE.EXP;
      const r = s.context ? 3 : 5;
      return h('span', { class: 'chart-legend-item' },
        h('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true' },
          h('path', { d: markerPath(style.shape, r), fill: style.color })),
        s.label);
    })));
  }

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;

  // ---- scales ---------------------------------------------------------------
  let xPos;
  let xTicks;
  if (spec.x.type === 'band') {
    const bands = spec.x.bands;
    const bandW = plotW / bands.length;
    const index = new Map(bands.map((b, i) => [b.key, i]));
    // spread the points of one band side by side
    const perBand = new Map();
    for (const p of usable) {
      if (!perBand.has(p.x)) perBand.set(p.x, []);
      perBand.get(p.x).push(p);
    }
    const offsets = new Map();
    for (const points of perBand.values()) {
      const step = Math.min(18, (bandW * 0.8) / points.length);
      points.forEach((p, i) => offsets.set(p, (i - (points.length - 1) / 2) * step));
    }
    xPos = (p) => MARGIN.left + (index.get(p.x) + 0.5) * bandW + (offsets.get(p) || 0);
    xTicks = bands.map((b, i) => ({ px: MARGIN.left + (i + 0.5) * bandW, label: b.label, node: b.node }));
  } else {
    const xs = usable.map((p) => p.x);
    const [x0, x1] = spec.x.domain || [Math.min(...xs), Math.max(...xs)];
    const scale = linearScale(x0, x1, MARGIN.left, MARGIN.left + plotW);
    xPos = (p) => scale(p.x);
    xTicks = scale.ticks(Math.max(4, Math.floor(plotW / 70)))
      .filter((v) => v >= x0 && v <= x1)
      .map((v) => ({ px: scale(v), label: tickText(v) }));
  }

  const lows = usable.map((p) => (Number.isFinite(p.lo) && (!spec.y.log || p.lo > 0) ? p.lo : p.y));
  const highs = usable.map((p) => (Number.isFinite(p.hi) ? p.hi : p.y));
  let yMin = Math.min(...lows);
  let yMax = Math.max(...highs);
  let yScale;
  if (spec.y.log) {
    yMin = 10 ** Math.floor(Math.log10(yMin) + 1e-9);
    yMax = 10 ** Math.ceil(Math.log10(yMax) - 1e-9);
    if (yMin === yMax) { yMin /= 10; yMax *= 10; }
    yScale = logScale(yMin, yMax, MARGIN.top + plotH, MARGIN.top);
  } else {
    const pad = (yMax - yMin) * 0.08 || Math.abs(yMax) * 0.05 || 1;
    yMin -= pad;
    yMax += pad;
    yScale = linearScale(yMin, yMax, MARGIN.top + plotH, MARGIN.top);
  }
  const clampY = (v) => Math.min(MARGIN.top + plotH, Math.max(MARGIN.top, v));

  // ---- frame ----------------------------------------------------------------
  const svg = h('svg', {
    class: 'chart-svg', width, height: HEIGHT, viewBox: `0 0 ${width} ${HEIGHT}`, role: 'img',
    'aria-label': `${spec.y.label} versus ${spec.x.label}. The same values are listed in the tables below.`,
  });
  for (const v of yScale.ticks(6)) {
    const y = yScale(v);
    svg.appendChild(h('line', { class: 'chart-grid', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y, y2: y }));
    svg.appendChild(h('text', { class: 'chart-tick', x: MARGIN.left - 8, y: y + 4, 'text-anchor': 'end' }, tickText(v)));
  }
  svg.appendChild(h('line', {
    class: 'chart-axis', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: MARGIN.top + plotH, y2: MARGIN.top + plotH,
  }));
  for (const t of xTicks) {
    const text = h('text', { class: 'chart-tick', x: t.px, y: MARGIN.top + plotH + 17, 'text-anchor': 'middle' });
    if (t.node) t.node.forEach((n) => text.appendChild(n()));
    else text.textContent = t.label;
    svg.appendChild(text);
  }
  svg.appendChild(h('text', {
    class: 'chart-label', x: MARGIN.left + plotW / 2, y: HEIGHT - 6, 'text-anchor': 'middle',
  }, spec.x.label));
  svg.appendChild(h('text', {
    class: 'chart-label', transform: `translate(14 ${MARGIN.top + plotH / 2}) rotate(-90)`, 'text-anchor': 'middle',
  }, spec.y.label));

  // ---- marks: context series first, then the others --------------------------
  const placed = [];
  const ordered = [...series].sort((a, b) => Number(Boolean(b.context)) - Number(Boolean(a.context)));
  for (const s of ordered) {
    const style = SERIES_STYLE[s.key] || SERIES_STYLE.EXP;
    const group = h('g', { class: `chart-series${s.context ? ' context' : ''}` });
    for (const point of usable) {
      if (point.series !== s) continue;
      const p = point;
      const cx = xPos(point);
      const cy = yScale(p.y);
      if (!s.context && Number.isFinite(p.lo) && Number.isFinite(p.hi)) {
        const yLo = spec.y.log && !(p.lo > 0) ? MARGIN.top + plotH : clampY(yScale(p.lo));
        group.appendChild(h('line', {
          class: 'chart-error', x1: cx, x2: cx, y1: yLo, y2: clampY(yScale(p.hi)), stroke: style.color,
        }));
      }
      const mark = h('path', {
        class: 'chart-mark', d: markerPath(style.shape, s.context ? 2.2 : 4.5),
        transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`, fill: style.color,
      });
      if (spec.keyOf) mark.dataset.key = spec.keyOf(point);
      if (spec.selected && spec.selected(point)) mark.classList.add('selected');
      group.appendChild(mark);
      placed.push({ point, cx, cy, mark });
    }
    svg.appendChild(group);
  }

  // ---- hover: the nearest point within reach -----------------------------------
  const wrap = h('div', { class: 'chart-plot' }, svg);
  const tip = h('div', { class: 'chart-tooltip', role: 'status', hidden: true });
  wrap.appendChild(tip);
  let active = null;
  const nearest = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const py = ((event.clientY - box.top) / box.height) * HEIGHT;
    let best = null;
    let bestD = HIT_RADIUS ** 2;
    for (const item of placed) {
      // context points only answer when nothing else is in reach
      const d = (item.cx - px) ** 2 + (item.cy - py) ** 2 + (item.point.series.context ? 60 : 0);
      if (d < bestD) { best = item; bestD = d; }
    }
    return best;
  };
  const show = (item) => {
    if (active && active !== item) active.mark.classList.remove('hover');
    active = item;
    if (!item) { tip.hidden = true; svg.style.cursor = ''; return; }
    item.mark.classList.add('hover');
    svg.style.cursor = spec.onSelect ? 'pointer' : '';
    clear(tip).appendChild(spec.tooltip(item.point));
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    const left = Math.min(Math.max(4, item.cx + 12), width - tipW - 4);
    tip.style.left = `${item.cx + 12 + tipW > width - 4 ? Math.max(4, item.cx - 12 - tipW) : left}px`;
    tip.style.top = `${Math.max(4, item.cy - tip.offsetHeight - 10)}px`;
  };
  svg.addEventListener('pointermove', (e) => show(nearest(e)));
  svg.addEventListener('pointerleave', () => show(null));
  svg.addEventListener('click', (e) => {
    const item = nearest(e);
    if (item && spec.onSelect) spec.onSelect(item.point);
  });
  container.appendChild(wrap);
}

/** Mark the point with the given key as selected without redrawing the chart. */
export function selectInChart(container, key) {
  for (const mark of container.querySelectorAll('.chart-mark')) {
    mark.classList.toggle('selected', Boolean(key) && mark.dataset.key === key);
  }
}
