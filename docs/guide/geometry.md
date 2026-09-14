# Space geometry and walls

Kerros uses a **shared network of wall and virtual boundary segments** to keep connected spaces consistent. A space follows an ordered loop of boundary IDs. Moving a shared boundary updates the spaces on both sides; their displayed polygons are calculated from that network.

Independent outlines remain available for imported plans, floor plates and areas that deliberately overlap. Existing documents keep their independent outlines until you explicitly connect them.

New deterministic CAD imports create connected rooms directly from the wall network, using virtual
boundaries across doorless passages. See the [import reference](/reference/import) for registration
and transaction requirements.

This guide explains the editing model. The optional [Mathematical foundations](/guide/geometry-mathematics) page contains the formulas, theorems and proof sketches for academic interest.

## What is stored, and what is generated?

| Part | Authoritative data | Calculated from it |
| --- | --- | --- |
| Junction | ID, floor and `[x, y]` position in metres | The endpoint shared by incident edges |
| Wall or fence | ID, `startId`, `endId`, thickness, height and properties | Centreline, solid footprint and rendered surfaces |
| Virtual boundary | ID, floor, `startId` and `endId` | A division between spaces with no physical wall |
| Space with shared boundaries | Object identity and `geometry.loops`: ordered, directed edge references | Net `rings`, position, width, depth and area |
| Independent space | Its own `rings`, or position, dimensions and rotation for a rectangle | Containment, area and rendered surfaces |
| Door or window | `barrierId`, centre `offset` from the wall's start, width and height | Placement and the opening in the wall |
| Floor | Elevation and height | Vertical placement of its geometry |

A physical edge is the existing `Barrier` record. There is no second copy of its coordinates in a separate topology table. Only unwalled edges need records in `virtualBoundaries`. Both kinds reference the same junction collection.

A [semantic zone](/guide/ontology) is a collection of space IDs; it has no polygon of its own. This differs from the older drawn object kind named `zone`, which is an area.

## Two spaces share one boundary

Suppose a 20 cm partition has its centreline at `x = 3`. Space A and Space B reference that same partition ID in opposite directions. Their usable polygons end at `x = 2.9` and begin at `x = 3.1`.

![Two spaces reference opposite directions of one partition. Their generated usable polygons stop at its faces.](/diagrams/space-geometry.svg)

Moving the partition to `x = 4` updates both polygons. Increasing its thickness changes both inside faces. The spaces keep their identities and bindings because the relationship is explicit; ordinary wall movement does not guess which new polygon overlaps an old room.

The space stores an outer loop and optional hole loops. Each entry is `{ edgeId, reversed? }`. Consecutive edges share junction IDs. The traversal keeps the space on its left: counterclockwise around the outside, clockwise around holes.

The saved `rings` are a **generated cache** for rendering, spatial queries and existing consumers. Edit the referenced boundaries to change a connected space. Writing its cached width or polygon inside a transaction causes the cache to be recomputed. Loading a document with stale caches is rejected.

## Drawing and connecting spaces

### Space from walls

**Space from walls** finds the closed boundary region under your click and connects a room to it. Closed regions may include physical walls, virtual boundaries or both. The usable footprint is the centreline region minus physical wall bodies, including wall thickness and corner closures.

Courtyard loops become holes, and those holes follow their boundaries when moved. A dangling wall does not create an extra topological region; its solid footprint can make a notch in the usable area. A doorway remains an opening attached to a continuous wall, so it does not erase the room division.

Clicking an already connected region reuses its room identity. A click inside a wall body does not create a room.

### Drawing a room outline

The **Room** polygon tool creates shared virtual boundaries along the outline. This lets you draw a room before its walls. Draw a physical wall along a virtual edge later to build that edge; connected spaces then account for its thickness.

Use **Virtual boundary** for an open-plan division. It has zero wall thickness and is shown as a dashed guide in the 2D editor. A line must close a region or cross an existing region to divide space; an unfinished spur alone does not create another room.

### Existing independent outlines

Select an area and use **Space geometry → Shared boundaries** to connect its drawn outline. This creates virtual boundaries where no matching edges exist. **Use surrounding walls** explicitly adopts the region with the greatest overlap with that outline; an ambiguous match is refused.

**Independent outline** keeps the current polygon and stops following boundary edits. This is useful for overlapping departments, incomplete imports and containing floor plates. It does not delete boundaries that other spaces may still use.

## Crossings, splitting and merging

Every geometry transaction normalizes changed floors. It splits crossing edges, shares one junction at a T or four-way crossing, replaces overlapping collinear segments with one edge, and updates every affected space reference. A physical edge takes precedence over an overlapping virtual edge. Attached openings retain their position along the replacement wall segment.

A new boundary across a connected space creates separate usable regions. The largest usable region keeps the original ID, name and live-feed binding. Other regions get new IDs and names, inherit semantic zone membership, and start without a copied live-feed binding.

**Split room** extends the cut line across the selected space. A physical split places partition segments across its solid spans, skipping holes. A virtual split uses zero-thickness separators. Physical splits subtract the new wall area; virtual splits conserve the represented area when all resulting pieces meet the usable-area minimum.

Removing a referenced wall replaces it with a virtual boundary. Both spaces keep their identities. **Merge** is a separate choice that removes the shared virtual division and keeps the chosen survivor's identity. It recovers the floor area previously occupied by the removed wall. Remove the physical dividing wall before merging connected spaces.

Two spaces sharing opposite sides of a virtual boundary are connected through an open passage. No door object or manually authored portal is required: routing and the structure panel derive the connection directly from the shared edge, including narrow openings such as an 80 cm closet entrance. A shared corner alone does not connect spaces. Building a wall on that edge removes the inferred passage; explicit passage restrictions still take precedence.

Legacy independent spaces retain polygon-based split and merge operations. Their area follows the authored outline rather than automatically subtracting every wall. Connect them when you need wall-aware usable-area measurements.

## Minimum space area

A newly created or resized area needs **at least 1 m² of usable area**. For connected spaces this is measured after subtracting wall bodies and holes; independent outlines subtract their holes. Each newly created split space must meet the same minimum.

The boundary network can contain smaller regions and holes. Automatic subdivision leaves regions below 1 m² unlabelled instead of creating sliver rooms. If an explicit split cannot create another usable space, it is refused. An existing connected space cannot silently disappear or shrink below the minimum; an invalid drop restores its previous position.

Small independent areas in older imported documents remain readable and can be renamed or have metadata edited. Creating or changing their area applies the current minimum.

The space-area limit is separate from the **1 cm wall-segment minimum**. Short returns and jambs are still valid. A hole also need not be 1 m²: it is an exclusion from a space, not another labelled space.

## What validation guarantees

Every editor commit goes through `transact`:

1. Clone the current document and apply the edit.
2. Normalize changed boundary geometry and regenerate connected space footprints.
3. Check structure, geometry, boundary references and caches, openings, parent containment, ontology and navigation.
4. Return the complete, validated result, or leave the original document untouched and report the reason.

The checks include closed ordered loops on the correct floor, loop orientation, valid polygons and holes, and at most one connected space on each directed side of an edge. Edges and attached openings are updated together when a crossing splits a wall. A junction cannot cut through an opening.

Unfinished strokes remain drafts. Invalid polygon clicks keep the last usable draft. Wall, junction and outline drags show a lightweight snapped preview without running model validation while the pointer moves. Releasing the pointer validates the requested drop once. If it is invalid, the original geometry returns and the editor explains why; no partial move enters history or persistence. Undo and redo restore boundary references together with the generated footprints.

### Current limits

The model permits incomplete floors and independent overlapping areas. Passing validation does **not** certify that every square metre is assigned to exactly one space, or that an imported independent outline follows walls.

A thick wall can close a narrow gap before its centreline reaches the other boundary. If that leaves one connected space with disconnected usable pieces, the edit is refused: extend the wall to the boundary to make the division explicit. Crossings that would produce a wall segment shorter than 1 cm must also be repositioned. These refusals preserve the previous valid plan and allow the next edit.

Hosts must edit through `transact` or `applyMutations`; directly changing a saved document bypasses synchronization. `validateProject` checks a document without repairing it. Portal inference remains separate: call `refreshPortals` when the host needs to update inferred connections.

## Why not store a mesh?

The floor model is a **shared planar subdivision**, represented with segments and directed boundary loops. It supplies the useful consistency property of a mesh: adjacent spaces reference the same boundary.

It is not a stored triangle mesh. Triangles describe how to draw a surface; they do not by themselves express wall thickness, opening offsets, room identity or virtual divisions. Keeping those concepts explicit makes edits and serialized documents easier to maintain.

The 3D viewer generates meshes from this 2D model plus elevations and heights: a **2.5D** representation. Rendering tessellation can change without changing space IDs or the editing model.

## Precision and snapping

The editor offers a 0.5 m positioning grid and 15° directions relative to the floor's main axis, including 45° and 90° directions. Geometry snapping reuses junctions and projects onto receiving boundaries. Disable snapping or hold Shift during a drag for details that the grid would suppress.

Dragging a junction preserves a nearby existing wall axis before falling back to the grid. Moving a
whole wall slides it along its normal and snaps where adjoining segments become collinear or reach
a nearby 15° floor direction. Preview and release use the same snapping; the preview becomes a saved
position only after release passes validation. Connected wall surfaces meet at shared
mitred corners; very acute joins use a bounded bevel to avoid long spikes.

Coordinates are **not globally rounded to centimetres**. Rotated intersections often need extra decimal places to stay on their edges. The calculated intersection is shared by ID rather than rounded separately on each adjoining wall.

Numerical tolerances are centralized in `model/precision.ts`. Junction normalization uses a 1 micrometre tolerance; authoring joins absorb sub-millimetre noise. Derived polygon clipping rounds its inputs to 0.1 mm and scales them before clipping. This cleanup does not change the stored junction coordinates and is distinct from the input grid.

See [Core concepts](/guide/concepts), [Spaces, zones & portals](/guide/ontology), the [schema reference](/reference/schema#geometry), and the optional [mathematical background](/guide/geometry-mathematics).

## Open passages and door swings

Draw a **Virtual boundary** along a wall to open that span. The editor splits the wall at the stroke's
ends and replaces the covered pieces with virtual edges. Both spaces retain their identity and
boundary references, while their usable outlines expand into the open passage. The opening is full
wall height; use a door or window for a framed opening with a lintel.

A fully covered door or window is removed with the replaced wall section. A stroke ending inside an
existing opening is rejected as one transaction; extend it to cover the opening or move the endpoint
clear. Undo restores the wall and attached openings.

Door placement is an offset along a physical wall. Hinge and swing are separate properties:
`doorHinge` picks the start or end of the segment, and `doorSwing` picks a side of its directed axis.
Changing either does not alter the shared room boundaries or the doorway width. Door dragging keeps
a small dead zone around the centreline so sliding along the wall does not accidentally flip the leaf.

## Walking paths inside rooms

Connectivity and the walking path answer different questions. Portals identify which spaces connect;
the core library's `buildRoomNavigation` finds clear segments between their access points. An empty
room permits a direct doorway-to-doorway path. Concave corners, pools and floor holes introduce
waypoints only where a direct segment would leave the walkable area. Wall thickness and a 40 cm
centreline clearance keep paths away from jambs and drop edges. A route from the visitor's position
uses the same checks when joining the graph.

This graph is derived from room geometry and supplied access points. It adds no rendering triangles
or independent room outlines. Rebuild it after edits using the public schema API; the Backrooms sample
uses that API rather than a separate room-routing algorithm. Door and vertical edges retain their
direction and physical-object binding. The shortest-path search uses a priority queue and stops once
it has proved the best destination cost; it need not search every remaining room.

POV playback walks the physical stair/landing centreline and follows escalator direction. For a lift,
it calls the car, waits for an open doorway, enters, requests the destination, waits for arrival and
exits. The reference application's simulated call-to-board delay is at most two seconds; external
hosts provide their own lift readings and commands. Missing controls or a blocked traversal stop
playback instead of skipping the vertical connection.
