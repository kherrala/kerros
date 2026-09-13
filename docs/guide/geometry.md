# Space geometry and walls

Kerros stores a floor as **connected wall segments and separate space polygons**. Walls share junctions by ID. A space stores its own outline as coordinates; its corners do not reference those junctions. The editor keeps certain outlines aligned with the walls through drawing and refitting operations.

This is a floor-plan model with elevations and heights, often called **2.5D**. The 3D viewer generates meshes from it. There is no single stored mesh whose faces are all the spaces on a floor.

## What is stored, and what is generated?

| Part | Stored in the document | Calculated from it |
| --- | --- | --- |
| Wall junction | ID, floor and `[x, y]` position in local metres | Where every attached wall starts or ends |
| Wall or fence | `startId`, `endId`, thickness and height | Centreline, wall faces and rendered surfaces |
| Space | Object ID, floor, outer polygon and optional holes in `rings` | Containment, area, floor plate and labels |
| Door or window on a wall | `barrierId`, centre `offset` in metres from the wall's start, width and height | Position and rotation along the wall, and the visible opening |
| Floor | Elevation and height | Vertical placement of its geometry |

An object without explicit `rings` uses the rectangle described by its position, width, depth and rotation. A space is an object with a footprint; a [semantic zone](/guide/ontology) is a collection of spaces and has no outline of its own.

## A wall junction is shared; a space corner is not

Suppose two rooms sit either side of a 20 cm partition. The partition's centreline is at `x = 3`. Spaces taken from its faces end at `x = 2.9` and start at `x = 3.1`.

![Two space polygons stop at the faces of a partition. Its centreline joins two shared wall junctions, while each space stores separate corner coordinates.](/diagrams/space-geometry.svg)

The partition stores `startId: "j1"` and `endId: "j2"`. The wall segments meeting it at the top also reference `j1`; those at the bottom reference `j2`. Moving either junction changes every incident wall because they all read the same position.

The rooms' polygons contain coordinate pairs such as `[2.9, 0.1]`. They contain no wall IDs, junction IDs, or references to the room next door. Even when two space corners have identical coordinates, editing one does not inherently move the other.

When a new wall **ends on an existing wall**, the drawing tools split the receiving segment and reuse one junction for the connection. A fourth wall snapped to that T uses the same junction. Merely drawing two lines across each other is not a general operation that subdivides every crossing into a shared graph vertex.

## How spaces follow walls

### Taking a space from walls

**Space from walls** computes the closed region under your click:

1. Give each barrier centreline a solid footprint using its thickness, extending the ends enough to close corners.
2. Subtract those footprints from a rectangle surrounding the floor's barriers.
3. Discard regions that reach the outside of that rectangle, and very small regions.
4. Take the smallest enclosed region containing the click and store its outline on a room object.

The resulting outline follows the **inside faces** of the surrounding barriers. A doorway does not break the enclosure: its opening is attached to a continuous wall segment. A gap in the barrier run can open the region to the outside and prevent enclosure detection.

This stores a polygon, not a permanent list of bounding walls. Clicking inside an existing room with the tool can refit that room while preserving its identity.

### Moving or thickening walls

For supported wall edits, the editor compares enclosed regions before and after the change. A room whose outer outline closely matched an old region can adopt the corresponding new region. Its ID, name and bindings survive; its outline, position and dimensions change.

Matching uses polygon overlap. It is an inference, not a stored constraint. Freehand spaces that did not match an enclosure stay where you drew them. If the enclosure disappears, or two rooms claim the same replacement region, refitting leaves their previous outlines in place instead of choosing a new meaning for them.

Wall endpoint drags also keep attached openings fitted along the changed segments. If a target position would fail validation, the drag stops at a valid intermediate position.

### Dividing and joining spaces

A wall drawn across an eligible space tries to divide its polygon. A wall stopping inside it does not divide it, and fence drawing does not automatically split spaces. Containing spaces with explicit child objects are left intact by automatic division. Cuts that cannot produce suitable pieces leave the space whole.

**Split room** clips the polygon along the line you draw and can add a partition across the solid spans, skipping holes. The original keeps its ID; the other piece gets a new ID and no copied live-feed binding.

These cut polygons meet along the **cut line**. They are not automatically inset by half the new wall thickness. Consequently, a split or manually drawn space can have different area conventions from a space taken from wall faces. `objectArea` measures the stored polygon; it is not an unconditional measurement of usable floor area.

When removing a wall, the editor offers to keep both spaces or merge them if it detects that they become connected. It does not silently discard a space's identity. Merging unites the footprints and keeps the selected survivor's name and bindings.

## What validation guarantees

Every editor commit runs through `transact`: clone the current document, apply the change, validate the result, and accept it only if the checks pass. A rejected transaction leaves the previous document untouched. Unfinished polygon strokes remain editor drafts until committed.

The checks include non-degenerate wall segments, polygon self-intersections, valid holes, explicit parent containment, valid references, and attached openings that fit without overlapping. They protect the saved document from those errors.

**Passing validation does not prove that all spaces form a complete, gap-free floor partition.** It does not enforce a permanent relationship between every space edge and wall face, prohibit all overlaps between independent spaces, or verify that every wall crossing shares a junction. Intentional nested and open-plan spaces are also possible.

A host changing the document programmatically must invoke the appropriate geometry operations as well as validation. `transact` alone does not discover rooms, refit outlines or refresh inferred portals. The schema exposes `enclosedRegions` and `refitEnclosedRooms` for before/after refitting; `refreshPortals` updates inferred connections separately.

### Current limits

- Enclosure detection defaults to a minimum region area of **1 m²**. The split tool uses **0.5 m²** for its candidate pieces. These are tool thresholds, separate from the **1 cm wall segment** minimum.
- Enclosure detection currently returns outer rings only. A walled island inside a larger space is detected separately, but its hole is not automatically subtracted from the surrounding room. Model the hole explicitly when it matters.
- Refitting updates the outer ring and preserves existing holes. Moving courtyard walls does not automatically move those holes.
- Refitting is currently for objects of kind `room`; other drawn area kinds remain independent.

## Why not store a mesh?

“Mesh” can mean two different things here.

A **rendering mesh** is a collection of vertices and triangles used to draw surfaces. Kerros already creates these for the 3D view. Storing those triangles as the editing model would not, by itself, say which surface is a wall, which opening belongs to it, or which space is a corridor. Those relationships would still need a model. Segments, dimensions and polygons express the edits directly and keep the JSON independent of rendering detail.

A **shared planar subdivision** is more relevant to consistency: one network of vertices and edges, with spaces represented by its faces. Adjacent faces reference the same boundary, so moving that boundary updates both sides. That would offer stronger guarantees for a floor that must be completely partitioned into adjoining spaces.

The current independent polygons make it straightforward to draw a lobby before its walls, outline an open department, nest a space inside a floor plate, or import an incomplete plan. They also avoid making every semantic boundary a physical wall. A subdivision could support these uses too, but it would need explicit rules for virtual boundaries, nesting, incomplete floors and wall thickness.

The tradeoff is real: **simpler stored geometry requires explicit synchronization work**. Shared wall junctions solve wall-to-wall attachment; room refitting handles some wall-to-space updates; validation catches defined failures. These are useful mechanisms, but they do not amount to a shared space mesh.

If every adjacent space must follow every boundary edit exactly, an explicit boundary-to-space topology would be a stronger future model. That can still generate the same 3D meshes; changing the drawing triangles alone would not provide that guarantee.

## Precision and snapping

The drawing grid, angle snapping and numerical precision solve different problems. The editor offers a 0.5 m positioning grid and 15° directions relative to the floor's main axis. Geometry snapping reuses junctions and projects onto receiving walls. Turn snapping off for small details that the positioning grid would suppress.

A **1 cm input grid** can be a useful drawing option, but coordinates are not globally rounded to centimetres. An intersection on a rotated wall often needs more decimal places to stay on that wall. Rounding each result separately can move a join off its wall, disturb an angle, or collapse a valid short diagonal segment.

Keep shared connections through their IDs and preserve the computed intersection. Limited numerical cleanup inside polygon operations is separate from the user's drawing grid; it is not a maximum precision for the saved document.

See [Core concepts](/guide/concepts), [Spaces, zones & portals](/guide/ontology) and the [schema reference](/reference/schema#geometry) for the surrounding model and APIs.
