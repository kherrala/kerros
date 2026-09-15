import type { Map as GLMap } from 'maplibre-gl';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Tool } from '../model/types';

interface PlannerKeyboardOptions {
  graphView: boolean;
  editing: boolean;
  threeD: boolean;
  walk: boolean;
  hasDraft: boolean;
  hasSelection: boolean;
  mapRef: RefObject<GLMap | null>;
  chooseTool: (tool: Tool) => void;
  stepFloor: (direction: 1 | -1) => void;
  commands: Record<
    | 'undo'
    | 'redo'
    | 'undoPoint'
    | 'export'
    | 'cancel'
    | 'finish'
    | 'help'
    | 'view'
    | 'edit'
    | 'walk'
    | 'live'
    | 'cycleView'
    | 'toggleStack'
    | 'toggleSidebar'
    | 'toggleInspector'
    | 'toggleFullscreen'
    | 'toggleNavigation'
    | 'toggleTheme'
    | 'deleteSelection'
    | 'duplicate',
    () => void
  >;
}

/** Routes chrome shortcuts without taking movement keys from the map or walker. */
export function usePlannerKeyboard({
  graphView,
  editing,
  threeD,
  walk,
  hasDraft,
  hasSelection,
  mapRef,
  chooseTool,
  stepFloor,
  commands,
}: PlannerKeyboardOptions) {
  const [showKeys, setShowKeys] = useState(false);
  const walkRef = useRef(walk);
  walkRef.current = walk;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, dialog, [role="tab"]')) return;
      if (graphView) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && e.key.toLowerCase() === 'z' && editing) {
        e.preventDefault();
        if (hasDraft && !e.shiftKey) commands.undoPoint();
        else if (e.shiftKey) commands.redo();
        else commands.undo();
        return;
      }
      if (cmd && e.key.toLowerCase() === 's') {
        e.preventDefault();
        commands.export();
        return;
      }
      if (e.key === 'Escape') {
        commands.cancel();
      }
      if (e.key === 'Enter' && hasDraft) {
        e.preventDefault();
        commands.finish();
      }
      // Chrome shortcuts work in every mode; single letters stay free because tools use their own set.
      // While walking, only the keys that change mode are ours — the rest belong to the walker.
      if (!cmd) {
        if (walkRef.current && !['t', '1', '2', '3', '4', '[', ']'].includes(e.key.toLowerCase())) return;
        const key = e.key.toLowerCase();
        if (e.key === '?') {
          commands.help();
          return;
        }
        if (e.key === '1') {
          commands.view();
          return;
        }
        if (e.key === '2') {
          commands.edit();
          return;
        }
        if (e.key === '3') {
          commands.walk();
          return;
        }
        if (e.key === '4') {
          commands.live();
          return;
        }
        if (key === 't') {
          commands.cycleView();
          return;
        }
        if (key === 'x' && threeD && !walk) {
          commands.toggleStack();
          return;
        }
        if (key === 'b') {
          commands.toggleSidebar();
          return;
        }
        if (key === 'i') {
          commands.toggleInspector();
          return;
        }
        if (key === 'f') {
          commands.toggleFullscreen();
          return;
        }
        if (key === 'g') {
          commands.toggleNavigation();
          return;
        }
        if (key === 'n') {
          commands.toggleTheme();
          return;
        }
        if (e.key === '[') {
          stepFloor(-1);
          return;
        }
        if (e.key === ']') {
          stepFloor(1);
          return;
        }
      }
      if (!editing) return;
      if ((e.key === 'Backspace' || e.key === 'Delete') && hasDraft) {
        e.preventDefault();
        commands.undoPoint();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && hasSelection) {
        e.preventDefault();
        commands.deleteSelection();
      }
      if (cmd && e.key.toLowerCase() === 'd') {
        e.preventDefault();
        commands.duplicate();
      }
      if (!cmd && !e.shiftKey) {
        const shortcut: Record<string, Tool> = {
          v: 'select',
          h: 'pan',
          w: 'wall',
          p: 'partition',
          d: 'door',
          c: 'camera',
          z: 'zone',
          m: 'measure',
          s: 'split',
          e: 'enclose',
        };
        if (shortcut[e.key.toLowerCase()]) chooseTool(shortcut[e.key.toLowerCase()]);
      }
    };
    // Shift+Up/Down steps floors — registered in capture phase so it wins over MapLibre's
    // shift-pitch handling when the map canvas has focus. AltGr symbols are avoided on purpose.
    const floorKeys = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, dialog, [role="tab"]')) return;
      if (graphView) return;
      // Walking owns the movement keys outright. The walker stops these events before they get here,
      // but "before" depends on listener registration order, and losing that race pans the map 140 px
      // under the walker on every arrow — which reads as the arrows moving faster than W and S.
      if (walkRef.current) return;
      const m = mapRef.current;
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.shiftKey)
          m?.panBy(
            [
              e.key === 'ArrowLeft' ? -140 : e.key === 'ArrowRight' ? 140 : 0,
              e.key === 'ArrowUp' ? -140 : e.key === 'ArrowDown' ? 140 : 0,
            ],
            { duration: 250 },
          );
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') stepFloor(e.key === 'ArrowUp' ? 1 : -1);
        else m?.easeTo({ bearing: m.getBearing() + (e.key === 'ArrowRight' ? 45 : -45), duration: 450 });
        return;
      }
      if (e.shiftKey && threeD && m && (e.key.toLowerCase() === 'w' || e.key.toLowerCase() === 's')) {
        e.preventDefault();
        e.stopPropagation();
        m.easeTo({
          pitch: Math.max(0, Math.min(75, m.getPitch() + (e.key.toLowerCase() === 'w' ? 10 : -10))),
          duration: 300,
        });
      }
    };
    // Holding Shift reveals each dock tool's shortcut as a badge on the button.
    const shiftDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShowKeys(true);
    };
    const shiftUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') setShowKeys(false);
    };
    const blur = () => setShowKeys(false);
    window.addEventListener('keydown', handler);
    window.addEventListener('keydown', floorKeys, true);
    window.addEventListener('keydown', shiftDown);
    window.addEventListener('keyup', shiftUp);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('keydown', floorKeys, true);
      window.removeEventListener('keydown', shiftDown);
      window.removeEventListener('keyup', shiftUp);
      window.removeEventListener('blur', blur);
    };
  });
  return showKeys;
}
