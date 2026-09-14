import { lazy, Suspense } from 'react';
import type { NavigatePanelProps } from '../components/NavigatePanel';
import type { NavigationGraphProps } from '../components/NavigationGraph';
import type { InspectorProps } from '../components/Inspector';

const Directions = lazy(() => import('../components/NavigatePanel').then(m => ({ default: m.NavigatePanel })));
const Graph = lazy(() => import('../components/NavigationGraph').then(m => ({ default: m.NavigationGraph })));
const Details = lazy(() => import('../components/Inspector').then(m => ({ default: m.Inspector })));
const NOOP = () => {};
export type NavigationPanelProps = Omit<NavigatePanelProps, 'editing'>;
export type { NavigationGraphProps };
export type ReadOnlyInspectorProps = Pick<
  InspectorProps,
  | 'project'
  | 'floorId'
  | 'selected'
  | 'statuses'
  | 'monitoring'
  | 'renderStatusPanel'
  | 'onClose'
  | 'onSelect'
  | 'onFloor'
>;

/** The editor's directions panel, with no authoring controls. */
export function NavigationPanel(props: NavigationPanelProps) {
  return (
    <Suspense fallback={<p role="status">Loading directions…</p>}>
      <Directions {...props} editing={false} />
    </Suspense>
  );
}
/** A view of the routing graph; force layout never changes the document's node coordinates. */
export function NavigationGraph(props: NavigationGraphProps) {
  return (
    <Suspense fallback={<p role="status">Loading navigation graph…</p>}>
      <Graph {...props} />
    </Suspense>
  );
}
/** The same geometry, relationships and status details as the editor, without mutation callbacks. */
export function ReadOnlyInspector(props: ReadOnlyInspectorProps) {
  return (
    <Suspense fallback={<p role="status">Loading properties…</p>}>
      <Details
        {...props}
        editing={false}
        live={false}
        onUpdateObject={NOOP}
        onUpdateBarrier={NOOP}
        onUpdateDrawing={NOOP}
        onUpdateFloor={NOOP}
        onSetInitialFloor={NOOP}
        onDeleteFloor={NOOP}
        onDuplicate={NOOP}
        onDelete={NOOP}
        onTraceFootprint={NOOP}
      />
    </Suspense>
  );
}
