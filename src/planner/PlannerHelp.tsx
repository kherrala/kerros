import { Modal } from '../components/controls';

export function PlannerHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="A few tools. A whole new perspective."
      subtitle="Everything you need to model and monitor your site."
      onClose={onClose}
    >
      <div className="help-content">
        <h3>Start with your sources</h3>
        <p>
          Import footprint GeoJSON or an architectural PNG, JPEG, or PDF. Align two image points to two map points, then
          trace walls and zones. Choose a drawing in Reference drawings to fine-tune its position.
        </p>
        <h3>Connected by design</h3>
        <p>
          Rooms follow shared walls and virtual boundaries. New spaces need at least 1 m² of usable area. Doors and
          windows attach to walls; gates attach to fences. Select an area and use “Cut a hole” for courtyards or
          exclusions. Parent zones must contain their children.
        </p>
        <h3>Explore and monitor</h3>
        <p>
          Switch to 3D for a floor cutaway or a building stack. Basement cutaways rebase the view while preserving saved
          elevations. Select any bound object to inspect its live status.
        </p>
        <div className="shortcut-grid">
          {[
            ['1 · 2 · 4', 'Viewer · Editor · Live'],
            ['3', 'Walk through at eye level'],
            ['T', '2D / 3D / Walk'],
            ['X', 'Cutaway / all floors'],
            ['⇧ ↑ / ⇧ ↓', 'Floor up / down'],
            ['⇧ ← / ⇧ →', 'Rotate map'],
            ['↑ ↓ ← →', 'Pan map · walk and turn'],
            ['W A S D', 'Pan in 2D · walk and turn in POV'],
            ['⇧ W / ⇧ S', 'Tilt 3D camera'],
            ['N', 'Dark / light mode'],
            ['B', 'Side panel'],
            ['I', 'Properties panel'],
            ['G', 'Navigate & directions'],
            ['F', 'Full-screen map'],
            ['⇧ (hold)', 'Show shortcuts'],
            ['V', 'Select'],
            ['H', 'Pan'],
            ['W / D / S', 'Drawing: wall / door / split (while a drawing tool is active)'],
            ['C', 'Camera'],
            ['Z', 'Zone'],
            ['M', 'Measure'],
            ['Enter', 'Finish drawing'],
            ['Esc', 'Close panel / cancel'],
            ['⌘/Ctrl Z', 'Undo'],
            ['⌘/Ctrl ⇧ Z', 'Redo'],
            ['⌘/Ctrl D', 'Duplicate'],
            ['⌘/Ctrl S', 'Export'],
          ].map(([key, name]) => (
            <div key={key}>
              <span>{name}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
        <p className="helper">
          Projects save in this browser. Export a portable JSON backup to move projects and their reference drawings
          between them.
        </p>
      </div>
    </Modal>
  );
}
