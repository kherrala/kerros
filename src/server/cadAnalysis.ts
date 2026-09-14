import type { PlanEntity } from '../import/types';
import { vectorBounds, type SourceCandidate, type VectorCommand } from './analysis';

export function extractCadVectors(entities: PlanEntity[]) {
  const candidates: SourceCandidate[] = [],
    warnings = new Set<string>();
  entities.forEach((e, index) => {
    let path: VectorCommand[] = [],
      kind: SourceCandidate['kind'] = 'path';
    let uncertainty: string | undefined;
    if (e.type === 'LINE' && e.a && e.b)
      path = [
        ['M', ...e.a],
        ['L', ...e.b],
      ];
    else if (e.type === 'POLYLINE' && e.points?.length)
      path = [
        ['M', ...e.points[0]],
        ...e.points.slice(1).map(p => ['L', ...p] as VectorCommand),
        ...(e.closed ? [['Z'] as VectorCommand] : []),
      ];
    else if (e.type === 'TEXT' && e.at) {
      kind = 'label';
      path = [['M', ...e.at]];
    } else if ((e.type === 'ARC' || e.type === 'CIRCLE') && e.center && e.r && e.r > 0) {
      const start = e.type === 'CIRCLE' ? 0 : (e.start ?? 0);
      let sweep = e.type === 'CIRCLE' ? 2 * Math.PI : (e.end ?? start) - start;
      while (sweep <= 0) sweep += Math.PI * 2;
      const count = Math.min(16, Math.max(1, Math.ceil(sweep / (Math.PI / 2))));
      const at = (t: number): [number, number] => [
        e.center![0] + e.r! * Math.cos(t),
        e.center![1] + e.r! * Math.sin(t),
      ];
      path.push(['M', ...at(start)]);
      for (let i = 0; i < count; i++) {
        const a = start + (sweep * i) / count,
          b = start + (sweep * (i + 1)) / count,
          k = (4 / 3) * Math.tan((b - a) / 4) * e.r;
        const p = at(a),
          q = at(b);
        path.push([
          'C',
          p[0] - k * Math.sin(a),
          p[1] + k * Math.cos(a),
          q[0] + k * Math.sin(b),
          q[1] - k * Math.cos(b),
          ...q,
        ]);
      }
      if (e.type === 'CIRCLE') path.push(['Z']);
      uncertainty = 'Arc represented by cubic Bézier segments; do not calibrate from its control-point bounds.';
    } else {
      warnings.add(`Unsupported ${e.type} entities omitted from vector candidates.`);
      return;
    }
    candidates.push({
      id: `cad-${index}`,
      kind,
      path,
      bounds: vectorBounds(path),
      layer: e.layer,
      evidence: `CAD entity ${index} (${e.type})`,
      ...(e.text ? { text: e.text.slice(0, 2000) } : {}),
      ...(e.h ? { strokeWidth: e.h } : {}),
      ...(uncertainty ? { uncertainty } : {}),
    });
  });
  warnings.add(
    'DWG metres follow the extractor unit/plot-scale settings. Confirm a known dimension before adopting the layout.',
  );
  return { candidates, warnings: [...warnings] };
}
