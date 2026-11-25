// A small SVG scatter chart with error bars (no dependencies).
//
// Identity is carried by colour *and* marker shape, a legend is always shown
// for two or more series, the nearest point answers to the pointer, and every
// value is also available in the tables below the chart.

import { h, replace } from '../core/dom.js';

const MARGIN = { top: 14, right: 16, bottom: 44, left: 62 };
const HEIGHT = 340;
const HIT_RADIUS = 28;

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

// A scale maps a value to a position; its ticks are [{ value, text }].

/** Ticks at the multiples of a round step, all written with the decimals of the step: 0.68, 0.70, 0.72. */
function linearScale(min, max, lo, hi) {
  const span = max - min || 1;
  const fn = (v) => lo + ((v - min) / span) * (hi - lo);
  fn.ticks = (count) => {
    const step = niceStep(span, count);
    const decimals = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    const out = [];
    for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) {
      const value = Number((k * step).toPrecision(12));
      out.push({ value, text: value.toFixed(decimals) });
    }
    return out;
  };
  return fn;
}

/** Ticks at the powers of ten: 0.001 … 10000, beyond that 1e-5, 1e5. */
function logScale(min, max, lo, hi) {
  const a = Math.log10(min);
  const b = Math.log10(max);
  const fn = (v) => (v > 0 ? lo + ((Math.log10(v) - a) / (b - a || 1)) * (hi - lo) : NaN);
  fn.ticks = () => {
    const out = [];
    for (let e = Math.ceil(a - 1e-9); e <= Math.floor(b + 1e-9); e++) {
      const value = 10 ** e;
      out.push({ value, text: value >= 100000 || value < 0.0001 ? value.toExponential().replace('e+', 'e') : String(Number(value.toPrecision(6))) });
    }
    return out;
  };
  return fn;
}

/**
 * Draw a chart into `container` and redraw it when the width changes.
 *
 * @param container element that receives the chart
 * @param spec {
 *   series: [{ label, color, shape, context?, points: [{ x, y, lo?, hi?, data }] }],
 *       shape is 'circle' | 'triangle' | 'square' | 'diamond'; a context series
 *       is drawn small, without error bars
 *   x: { label, type: 'linear', domain: [min, max] }
 *    | { label, type: 'band', bands: [{ key, label: () => [SVG nodes] }] },
 *   y: { label, log?: boolean },
 *   tooltip(point) -> Node, onSelect(point),
 *   keyOf(point) -> string, selectedKey?: string,
 *   emptyText
 * }
 * @returns a function that stops the redrawing
 */
export function renderChart(container, spec) {
  let drawnWidth = -1;
  let dismiss;
  const draw = () => {
    drawnWidth = container.clientWidth;
    dismiss = drawChart(container, spec);
  };
  const observer = new ResizeObserver(() => { if (container.clientWidth !== drawnWidth) draw(); });
  observer.observe(container);
  draw();
  const escape = (e) => {
    if (e.key === 'Escape' && dismiss?.()) e.stopPropagation();
  };
  document.addEventListener('keydown', escape, true);
  return () => { observer.disconnect(); document.removeEventListener('keydown', escape, true); };
}

function drawChart(container, spec) {
  replace(container);
  const width = Math.max(300, container.clientWidth || 600);
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
      const r = s.context ? 3 : 5;
      return h('span', { class: 'chart-legend-item' },
        h('svg', { width: 14, height: 14, viewBox: '-7 -7 14 14', 'aria-hidden': 'true' },
          h('path', { d: markerPath(s.shape, r), fill: s.color })),
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
    const stride = Math.max(1, Math.ceil(40 / bandW));  // room for a superscript mass number and element symbol
    xTicks = bands.flatMap((b, i) => i % stride === 0 ? [{ px: MARGIN.left + (i + 0.5) * bandW, nodes: b.label() }] : []);
  } else {
    const xs = usable.map((p) => p.x);
    const [x0, x1] = spec.x.domain || [Math.min(...xs), Math.max(...xs)];
    const scale = linearScale(x0, x1, MARGIN.left, MARGIN.left + plotW);
    xPos = (p) => scale(p.x);
    xTicks = scale.ticks(Math.max(4, Math.floor(plotW / 70)))
      .filter((t) => t.value >= x0 && t.value <= x1)
      .map((t) => ({ px: scale(t.value), label: t.text }));
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
  for (const t of yScale.ticks(6)) {
    const y = yScale(t.value);
    svg.appendChild(h('line', { class: 'chart-grid', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: y, y2: y }));
    svg.appendChild(h('text', { class: 'chart-tick', x: MARGIN.left - 8, y: y + 4, 'text-anchor': 'end' }, t.text));
  }
  svg.appendChild(h('line', {
    class: 'chart-axis', x1: MARGIN.left, x2: MARGIN.left + plotW, y1: MARGIN.top + plotH, y2: MARGIN.top + plotH,
  }));
  for (const t of xTicks) {
    const text = h('text', { class: 'chart-tick', x: t.px, y: MARGIN.top + plotH + 17, 'text-anchor': 'middle' });
    if (t.nodes) t.nodes.forEach((n) => text.appendChild(n));
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
    const group = h('g', { class: `chart-series${s.context ? ' context' : ''}` });
    for (const point of usable) {
      if (point.series !== s) continue;
      const p = point;
      const cx = xPos(point);
      const cy = yScale(p.y);
      if (!s.context && Number.isFinite(p.lo) && Number.isFinite(p.hi)) {
        const yLo = spec.y.log && !(p.lo > 0) ? MARGIN.top + plotH : clampY(yScale(p.lo));
        group.appendChild(h('line', {
          class: 'chart-error', x1: cx, x2: cx, y1: yLo, y2: clampY(yScale(p.hi)), stroke: s.color,
        }));
      }
      const mark = h('path', {
        class: 'chart-mark', d: markerPath(s.shape, s.context ? 2.2 : 4.5),
        transform: `translate(${cx.toFixed(1)} ${cy.toFixed(1)})`, fill: s.color,
      });
      mark.dataset.key = spec.keyOf(point);
      if (spec.selectedKey && mark.dataset.key === spec.selectedKey) mark.classList.add('selected');
      group.appendChild(mark);
      placed.push({ point, cx, cy, mark });
    }
    svg.appendChild(group);
  }

  // ---- hover: the nearest point within reach -----------------------------------
  const wrap = h('div', { class: 'chart-plot' }, svg);
  const tip = h('div', { class: 'chart-tooltip', hidden: true });
  wrap.appendChild(tip);
  let active = null;
  const nearest = (event) => {
    const box = svg.getBoundingClientRect();
    const px = ((event.clientX - box.left) / box.width) * width;
    const py = ((event.clientY - box.top) / box.height) * HEIGHT;
    let best = null;
    let bestD = HIT_RADIUS ** 2;
    for (const item of placed) {
      if (item.mark === event.target) return item;
      const d = (item.cx - px) ** 2 + (item.cy - py) ** 2;
      if (d <= bestD) { best = item; bestD = d; }
    }
    return best;
  };
  const show = (item) => {
    if (active && active !== item) active.mark.classList.remove('hover');
    active = item;
    if (!item) { tip.hidden = true; svg.style.cursor = ''; return; }
    item.mark.classList.add('hover');
    svg.style.cursor = spec.onSelect ? 'pointer' : '';
    replace(tip, spec.tooltip(item.point));
    tip.hidden = false;
    const tipW = tip.offsetWidth;
    const scale = svg.clientWidth / width;
    const x = item.cx * scale, y = item.cy * scale;
    tip.style.left = `${Math.max(0, Math.min(x - tipW / 2, wrap.clientWidth - tipW))}px`;
    tip.style.top = `${y >= tip.offsetHeight + 3 ? y - tip.offsetHeight - 3 : y + 3}px`;
  };
  svg.addEventListener('pointermove', (e) => show(nearest(e)));
  wrap.addEventListener('pointerleave', () => show(null));
  svg.addEventListener('click', (e) => {
    const item = nearest(e);
    if (item && spec.onSelect) spec.onSelect(item.point);
  });
  container.appendChild(wrap);
  return () => {
    if (!active) return false;
    show(null);
    return true;
  };
}

/** Mark the point with the given key as selected without redrawing the chart. */
export function selectInChart(container, key) {
  for (const mark of container.querySelectorAll('.chart-mark')) {
    mark.classList.toggle('selected', Boolean(key) && mark.dataset.key === key);
  }
}
