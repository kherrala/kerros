# Rendering engine review (2026-09-12)

## Reopened verification — 2026-09-13

The earlier statement that every finding was closed was too broad. The sections below preserve
the original findings and the reported fix passes; their old line numbers describe that checkpoint.
They are not a current open-item checklist.

- **Fixed and browser-tested:** selecting an object from the list in Walk now turns the walker
  toward it without moving the eye. The plan-camera focus ease previously moved the POV far away.
- **Added and browser-tested:** a horizontal POV field-of-view control, 60–120° with a 90° default.
  Changing it or resizing the viewport preserves the eye position and height; exiting Walk restores
  the map lens, and the preference survives reloads.
- **Still open:** walk collision uses active-floor walls and fixtures. Lift shells, escalator rails,
  walls beneath a mezzanine and plate edges need a shared collision representation.
- **Under investigation:** the reported underground and entresol appearance problems. A browser
  capture pass exercises the entresol, ground hall, Herkku and P1/P2 without WebGL or geometry
  exceptions. That smoke check does not establish that their visual geometry is correct.

Checkpoint commit: `25b65fe`. Two background workflows were running when this was written:
a verify pass over the findings below, and an implementation pass on the demo data and the
camera. Anything uncommitted on top of `25b65fe` is that work.

Findings below came from seven independent reviewers reading the engine against the
Stockmann demo. Each names a file, the failure, and the proposed fix. They are ordered by
severity. Unticked items are not yet done.

## Historical closure report

The earlier pass reported the list closed. The current verification above supersedes that claim.
The list below is kept as a record of what was wrong and where.

The work landed over several passes. The last one verified each remaining item against the code
before touching it, and found that most of the low-severity tail had already been swept up by the
earlier structural fixes — the escalator comb plates, the flight pitch, the oversized escalator
voids and the doubled entresol slab were all closed by then, and the 3D edit handles had been
gated with the rest. What genuinely remained:

- **One depth mapping.** `present()` now applies whenever the view is buried rather than only in
  the stack, and the scene is built in the authored frame so `relative()` and the shaft offsets
  share that one mapping by construction instead of by a second formula. A `sceneElevation` helper
  states it once, and the excavation, its strata and the cage all go through it. This is a no-op
  above about 96 m of depth, which is why Stockmann looks identical; a synthetic project reaching
  -400 m pins it.
- **Ramps belong to both ends.** A sloped zone is filed on one level, so the deck it arrives at
  never drew it. A ramp is now claimed by the levels its slope ends at — not every storey the
  incline crosses, which would run the Mannerheimintie driveway through the food hall — and the
  deck it leaves is cut, because the ramp dives under that plate the moment it starts falling.
- Two repairs that cut exposed: a surface with no rings after clipping threw and took a whole
  storey with it, and the void pre-filter tested corners rather than bounding boxes, so a long
  ramp crossing an aisle at right angles missed it entirely and the plate bridged the trench.

## Historical status after the fix pass

Four agents worked the list in disjoint files. Everything below marked **fixed** landed in the
commit this note sits in; the rest are still open.

**Fixed — demo data.** Escalator banks moved clear of the atrium (y -15.5 / 23.5) and the run
re-sized from the tallest climb the bank actually makes, so every flight is now at or under 30°.
Both mezzanines given standable heights: the ground hall is 5.6 m with the entresol at 2.8 h2.8,
Herkku 4.8 m with the pharmacy gallery at -6.6 h2.4, and everything from level 01 up shifted 1.4 m.
Shafts now serve only levels they can actually land on, enforced by a new validation rule. Office
partitions on 07-09 clear the shafts. The garage stair runs along its lobby, the two inter-deck
ramps have separate lanes, and the duplicate spiral stairs are gone.

**Fixed — camera.** The 512-px tile constant in fit, re-aim on tilt and rotate instead of re-fit,
the aim preserved across 3D/2D, leaving walk mode returns to where the walker stood, startPose
uses the floor point at screen centre, focus and route eases carry the depth aim, and the 3D edit
handles are gated.

**Fixed — engine, levels.** One presentation frame: ramps, the excavation pit, the cage and the
outdoor geometry all follow the rebased floor in walk mode. The walk ceiling sits at the storey's
real underside and can never fall below eye height. The stack overview is gated on real depth
compression rather than a level count, so a basement no longer collapses the tower to wire rings.
Shell slabs survive the garage decks and are hidden above grade. A mezzanine is now drawn from the
storey it hangs inside, so flights to the entresol arrive somewhere.

**Fixed — engine, circulation.** Plate voids and ceiling voids use separate predicates, so flights
at the top and bottom of a run are visible. Shafts are clamped to the drawn levels above grade.
Primary verticals survive the stack's shell skip. Switchback lanes are symmetric, comb plates are
flush, and escalator voids are cut to the headroom zone.

**At that checkpoint:** the low-severity items at the end of this note were still open, plus anything
the reviewers never reached — two of the seven lenses (visibility and materials) never reported.

## Confirmed and fixed already (in 25b65fe)

- Excavation built 1,055 separate soil pits because `polygonClipping.union` threw on ~1,000
  garage-bay rings and the fallback returned every ring. Now merged per level, with contained
  rings dropped (`src/map/underground.ts`).
- Garage bays are nested under their deck plate, so `floorOutline` returns the deck, not 400 bays.
- Leaving walk mode kept the walk scene: `props.walk` was missing from the sync effect's deps.
- Car fixture was modelled across its short axis.
- Walk-mode ceiling voids opened onto the sky; a well lid one storey up now closes them.

## Original findings — high

1. **Ground hall never draws the entresol** (`src/map/SceneLayer.ts:1280`). `under` only carries a
   level downward. On `floor-ground`, all 12 shafts serve `floor-entresol` (2.4 m), so 12 flights
   end in mid-air. Mirror `under` with an `over` that draws any mezzanine inside the active storey.
2. **Sloped ramps use absolute elevation while walk rebases the floor to 0**
   (`src/map/SceneLayer.ts:1358`). On P1 the ramps sit 12.6 m under the walker. Define
   `ground = stack ? 0 : rebase - active.elevation` and add it to the lift passed to
   `slopedSurface`, to the pit/cage, and to `relative(null)`.
3. **Excavation pit and cage are at absolute elevations in walk** (`src/map/SceneLayer.ts:1565`),
   so a walked basement appears to stand at grade at the lip of a hole. Same `ground` offset, or
   skip both when walking.
4. **Walking a mezzanine puts the ceiling lid below the eye** (`src/map/SceneLayer.ts:1452`).
   Entresol height 1.6 m, eye 2.03 m. Clamp the soffit to at least eye + 0.35 and give the demo
   mezzanines standable heights.
5. **Flights at the top and bottom of a run are invisible** (`src/model/vertical.ts:134`).
   `passesThrough` requires served levels both below and above, and both the plate voids and the
   walk-lid voids use it. Split the predicate: plate voids need a level below, lid voids a level above.
6. **Below-grade flights and lift shafts draw over the basemap in above-ground views**
   (`src/map/SceneLayer.ts:1309`): verticals are exempt from the below-grade skip. Clamp what a
   shaft may show when `!buried`.
7. **"All floors" from a basement collapses the building to wire rings**
   (`src/map/SceneLayer.ts:1184`): `structureOverview` trips on `levels.length > 16` (Stockmann has
   17) rather than on actual depth. Gate on `view.compressed`.
8. **Stack view never draws a stair, escalator or lift unless the active floor is the primary
   twin's own floor** (`src/map/SceneLayer.ts:1313`): shafts are filed under the lowest served
   level, which is in `shellBelow`. Exempt primary verticals from that skip.
9. **Shell-slab union throws for every garage deck** (`src/map/SceneLayer.ts:1427`), so in the
   stack the decks below have no plate. Snap to 1e-4 before the union and fall back to the level's
   largest area, not to nothing.
10. **Ground cutaway: the 12 stairwell voids open onto the basemap**
    (`src/map/SceneLayer.ts:1545`) with basement flights hanging beneath. Include the storey below
    in the envelope when it is below grade, or cap the wells.

## Original findings — medium

- Outdoor geometry (parcel, fences, shadow plane) rides up to the walked storey because
  `relative(null)` is 0 (`SceneLayer.ts:1287`). Same `ground` offset.
- Switchback stair lanes overlap by 0.55 m and the landing overhangs the footprint
  (`SceneLayer.ts:917`). Offset both lanes symmetrically; size the landing to `o.width`.
- Walk collision ignores lift shells, escalators, under-floor walls on a mezzanine, and the plate
  edge (`MapCanvas.tsx:1553`).
- Ghost shell slabs of below-grade floors are drawn under the basemap in the non-buried stack
  (`SceneLayer.ts:1419`). Add a `!buried && belowGrade(fid)` skip.
- Single-floor buried view draws nothing beneath the active level and cuts the pit an arbitrary
  6 m down, so ramps end in mid-air (`SceneLayer.ts:1580`).
- Pit veil alpha is inverted relative to its comment (`UndergroundContext.ts:172`): densest at the
  inspected floor, invisible at grade.
- Cage columns come from the first level above, which for Herkku is a 40 m gallery, so a 110 m
  building is caged by a mezzanine's four corners (`SceneLayer.ts:1610`).
- Camera: `pitchend` re-fits instead of re-aiming, throwing away zoom and pan on every non-ground
  floor; rotation never re-aims; 3D→2D keeps the depth-aimed centre (`MapCanvas.tsx:1243-1250`).
- Camera: `fit()` uses the 256-px tile constant with 512-px tiles, so the depth-zoom compensation
  is half strength (`MapCanvas.tsx:1471`).
- Camera: leaving walk leaves the camera at the walk pose (`MapCanvas.tsx:1956`).
- `startPose` stands the walker at the ground aim point, not the floor point at screen centre
  (`MapCanvas.tsx:1595`).
- Demo data: escalator landings hang over the atrium void on every floor above ground
  (`app/demo/demo.ts:555`); Lift C/D and Stair East/West serve mezzanines they stand outside of
  (`demo.ts:303`); office partitions on 07-09 cross the escalator wells
  (`stockmannOffices.ts:172`); the garage stair runs across its lobby because `rotation` is set
  for a width-axis object (`stockmannGarage.ts:263`); spiral stairs exist twice and routing picks
  a different twin than rendering (`demo.ts:667`).

## Original findings — low

- Escalator comb plates stand 0.2-0.32 m proud of both floors; criss-cross flights share a
  coincident landing and their trusses interpenetrate (`SceneLayer.ts:759, 802`).
- Escalator pitch is 35° where the demo sized it for 30°, because `depth` includes the comb pads
  (`SceneLayer.ts:786`).
- `shaftVoids` punches the whole 8 m escalator footprint through every intermediate floor
  (`vertical.ts:150`).
- Entresol cutaway draws the ground floor twice (`under` plus the envelope) (`SceneLayer.ts:1549`).
- Depth compression applies only in the stack, but the single-floor buried view rebases to the
  compressed elevation (`SceneLayer.ts:453`) — only bites below -96 m.
- 3D edit handles (move/rotate/coverage) sit on the ground plane while the object is at floor
  elevation (`MapCanvas.tsx:1988`).
- focusId and the route-step ease centre on the raw ground position in 3D.

## Added after the note was first written (fifth reviewer)

- **Walk lid sits 0.33 m below the storey's underside** (`SceneLayer.ts:1452`): the soffit is
  `rebase + height - SLAB`, but fixtures are authored against the storey, so the garage's 3.1 m
  luminaires and 4.2 m pillars poke through the ceiling. Use `soffit = rebase + height + LIFT`
  and derive `wellHead` from the next storey's own elevation.
- **Garage ramps** (`stockmannGarage.ts:270`): the P2→P3 ramp ends outside the P3 deck ring, both
  inter-deck ramps share one strip, and a ramp is only drawn on the deck it starts from — never
  cut from the plate it arrives under. Offset the second ramp to its own lane, assert
  `pointInRing(lowEnd, to.ring)`, and include a ramp in `visibleObjects` for every level it spans.
- **The street ramps are invisible from the site view** (`SceneLayer.ts:1309`): a sloped zone whose
  `slope.high >= 0` reaches grade and should be exempt from the below-grade skip, so the garage
  mouths read at street level.
