import { FlameNode } from './analyzer';

/**
 * Render an area/timeline chart showing activity kinds (SOQL, DML, Methods, Callouts, Code Units)
 * over the execution time. Colors indicate kind; hover shows details; click jumps to log line.
 */
export function renderAreaChartHtml(root: FlameNode): string {
  const width = 1200;
  const height = 200;
  const padding = { top: 10, right: 10, bottom: 30, left: 40 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const totalDurationMs = Math.max(root.durationMs, 0.001);

  // Flatten tree to leaf-ish spans (ignore root, keep meaningful activities)
  const spans: FlameSpan[] = [];
  collectSpans(root, root.startNs, spans);

  if (!spans.length) {
    return `<p class="muted">No activity data to chart.</p>`;
  }

  // Sample the timeline into N buckets; for each bucket compute which kinds are active
  const numBuckets = 300; // horizontal resolution
  const bucketDurationMs = totalDurationMs / numBuckets;
  const buckets: BucketCounts[] = [];
  for (let i = 0; i < numBuckets; i++) {
    buckets.push({ code_unit: 0, method: 0, soql: 0, dml: 0, callout: 0 });
  }

  for (const span of spans) {
    const startBucket = Math.max(0, Math.floor(span.startMs / bucketDurationMs));
    const endBucket = Math.min(numBuckets - 1, Math.ceil(span.endMs / bucketDurationMs));
    for (let i = startBucket; i <= endBucket; i++) {
      if (span.kind !== 'root') {
        buckets[i][span.kind] = (buckets[i][span.kind] || 0) + 1;
      }
    }
  }

  // Max stack depth for y-scale
  const maxStack = Math.max(
    1,
    ...buckets.map(b => b.code_unit + b.method + b.soql + b.dml + b.callout)
  );

  // Build stacked paths — each kind is a filled polygon
  const kinds: Array<keyof BucketCounts> = ['code_unit', 'method', 'soql', 'dml', 'callout'];
  const colors: Record<keyof BucketCounts, string> = {
    code_unit: '#6b7280',   // gray
    method:    '#22c55e',   // green
    soql:      '#3b82f6',   // blue
    dml:       '#f97316',   // orange
    callout:   '#ef4444'    // red
  };
  const labels: Record<keyof BucketCounts, string> = {
    code_unit: 'Code Unit',
    method:    'Method',
    soql:      'SOQL',
    dml:       'DML',
    callout:   'Callout'
  };

  const bucketWidth = chartWidth / numBuckets;

  // For each kind, build a filled polygon stacked on top of the previous
  const paths: string[] = [];
  const runningTop = new Array(numBuckets).fill(chartHeight); // y starts at bottom
  for (const kind of kinds) {
    const topPoints: string[] = [];
    const bottomPoints: string[] = [];

    for (let i = 0; i < numBuckets; i++) {
      const count = buckets[i][kind];
      const x = padding.left + i * bucketWidth;
      const bottomY = runningTop[i];
      const topY = bottomY - (count / maxStack) * chartHeight;
      topPoints.push(`${x.toFixed(2)},${topY.toFixed(2)}`);
      bottomPoints.push(`${x.toFixed(2)},${bottomY.toFixed(2)}`);
      runningTop[i] = topY;
    }
    // Create polygon: top points left->right, then bottom points right->left
    const polyPoints = [...topPoints, ...bottomPoints.reverse()].join(' ');
    paths.push(
      `<polygon points="${polyPoints}" fill="${colors[kind]}" fill-opacity="0.65" stroke="${colors[kind]}" stroke-width="0.5" />`
    );
  }

  // X-axis ticks (0ms, 25%, 50%, 75%, 100%)
  const xTicks: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const x = padding.left + (i / 4) * chartWidth;
    const ms = (i / 4) * totalDurationMs;
    xTicks.push(
      `<line x1="${x}" y1="${padding.top + chartHeight}" x2="${x}" y2="${padding.top + chartHeight + 4}" stroke="var(--vscode-foreground)" stroke-opacity="0.5" />`,
      `<text x="${x}" y="${padding.top + chartHeight + 18}" font-size="10" fill="var(--vscode-foreground)" text-anchor="middle" opacity="0.7">${ms.toFixed(0)}ms</text>`
    );
  }

  // Legend
  const legendHtml = kinds
    .map(k => `<span class="legend-item"><span class="legend-dot" style="background:${colors[k]}"></span>${labels[k]}</span>`)
    .join('');

  // Also render clickable span markers below the chart so users can jump to important events
  type MarkerKind = 'soql' | 'dml' | 'callout';
  const significantSpans = spans
    .filter((s): s is FlameSpan & { kind: MarkerKind } =>
      (s.kind === 'soql' || s.kind === 'dml' || s.kind === 'callout') && s.endMs - s.startMs > 0
    )
    .slice(0, 80); // cap
  const spanMarkers: string[] = significantSpans.map(s => {
    const x = padding.left + (s.startMs / totalDurationMs) * chartWidth;
    const w = Math.max(2, ((s.endMs - s.startMs) / totalDurationMs) * chartWidth);
    return `<rect class="activity-marker" data-name="${escapeAttr(s.name)}" data-kind="${s.kind}" data-line="${s.lineNumber ?? ''}" data-duration="${(s.endMs - s.startMs).toFixed(2)}" x="${x.toFixed(2)}" y="${padding.top + chartHeight + 24}" width="${w.toFixed(2)}" height="6" fill="${colors[s.kind]}" style="cursor:pointer" />`;
  });

  return `<div id="area-chart-container">
    <div class="chart-legend">${legendHtml}</div>
    <div id="chart-tooltip" class="flame-tooltip" style="display:none"></div>
    <svg id="area-chart-svg" viewBox="0 0 ${width} ${height + 40}" preserveAspectRatio="none"
         style="width:100%; height:${height + 40}px; background: var(--vscode-editorWidget-background); border-radius: 6px;">
      ${paths.join('\n')}
      ${xTicks.join('\n')}
      ${spanMarkers.join('\n')}
    </svg>
    <p class="muted" style="margin-top:4px">Y-axis = concurrent activity count. Thin bars below chart = SOQL / DML / Callout events (click to jump to log line).</p>
    <script>
      (function() {
        const svg = document.getElementById('area-chart-svg');
        const tooltip = document.getElementById('chart-tooltip');
        svg.addEventListener('mousemove', (e) => {
          const m = e.target.closest('.activity-marker');
          if (!m) { tooltip.style.display = 'none'; return; }
          const name = m.getAttribute('data-name');
          const kind = m.getAttribute('data-kind');
          const line = m.getAttribute('data-line');
          const dur = m.getAttribute('data-duration');
          tooltip.innerHTML = '<strong>' + name + '</strong><br><span style="opacity:0.7">' + kind + ' · ' + dur + ' ms' + (line ? ' · line ' + line : '') + '</span>';
          tooltip.style.display = 'block';
          tooltip.style.left = (e.pageX + 12) + 'px';
          tooltip.style.top = (e.pageY + 12) + 'px';
        });
        svg.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
        svg.addEventListener('click', (e) => {
          const m = e.target.closest('.activity-marker');
          if (!m) return;
          const line = parseInt(m.getAttribute('data-line') || '0', 10);
          if (line && window.acquireVsCodeApi) {
            // already acquired at the top of the webview; posting via global vscode
          }
          if (line) vscode.postMessage({ command: 'jumpToLine', line });
        });
      })();
    </script>
  </div>`;
}

interface BucketCounts {
  code_unit: number;
  method: number;
  soql: number;
  dml: number;
  callout: number;
}

interface FlameSpan {
  name: string;
  kind: 'code_unit' | 'method' | 'soql' | 'dml' | 'callout' | 'root';
  startMs: number;
  endMs: number;
  lineNumber?: number;
}

function collectSpans(node: FlameNode, rootStartNs: number, out: FlameSpan[]) {
  if (node.kind !== 'root') {
    const startMs = (node.startNs - rootStartNs) / 1e6;
    const endMs = (node.endNs - rootStartNs) / 1e6;
    if (endMs > startMs) {
      out.push({
        name: node.name,
        kind: node.kind,
        startMs, endMs,
        lineNumber: node.lineNumber
      });
    }
  }
  for (const child of node.children) {collectSpans(child, rootStartNs, out);}
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}