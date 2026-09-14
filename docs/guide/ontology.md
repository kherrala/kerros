# Spaces, zones and portals

## The problem

Say you are setting up door access for an office building. You want to express something simple:

> *The finance team can get into the third floor, but not the server room. Cleaners can get in after
> six, but only through the back entrance.*

A floor plan cannot answer that on its own. A drawing knows there is a rectangle here and a door
there. It does not know that eleven of those rectangles are "the third floor" as far as security is
concerned, that a particular door is the *way in* to one of them, or that going in and coming out are
different questions.

That missing layer is what this page is about. Kerros calls it the **ontology**: a small vocabulary
for what the building *means*, sitting on top of the geometry you already drew.

## Browsing the structure

Open **Structure** in the editor or viewer. Its tabs read the same document as the plan:

- **Spaces** lists buildings, floors and all spaces, including rooms that belong to no semantic zone. Expand a space to see parent/contained objects, zone memberships, served floors and direct portals. The location icon (**Find on map**) selects it and changes floors.
- **Zones** groups named zones by purpose, with nested-zone relationships, expanded membership and perimeter crossings. Edit mode also supports creating, naming and changing zones through the normal undo history.
- **Portals** lists every portal, including open boundaries outside named zones. Optionally enable **Filter by portal group** and inspect endpoints, physical openings, passage direction and crossing evidence. A sealed portal remains visible here.
- **Topology** shows the same nodes and edges used by routing, including authored graph overrides when present. Expand a node for incoming/outgoing connections and transport kinds; filter to isolated nodes to find places with no graph connection. Sealed portals produce no routing edge.

Use the location icon on rows to find buildings, floors, spaces, zones, portals or graph connections on the map. Multi-space groups frame their members on the current relevant floor.

From **Topology**, choose **Open graph view** to replace the map with an interactive navigation graph. It reads the same authored or derived graph as routing. **Auto balance** uses a force layout; drag individual nodes, pan the background and scroll to zoom. **Fit graph** reframes the graph; **Rebalance** restarts the layout. Edge colors distinguish walking, doors, stairs/escalators and elevators; arrows indicate one-way travel. Filter by floor, search for a node, and use its location icon to return to the map. Layout changes are view-only and do not move floor-plan coordinates or modify routes.

Search and floor filters apply independently of the displayed map floor. Large lists load more entries as you scroll; collapsed details render only when opened. Stockmann and Silo derive circulation zones using the same shaft identity as rendering and routing (kind, name and position). Backrooms has an explicit circulation zone and one landing portal on each of the elevator’s five served floors. A single shaft object can therefore mean one zone member serving many floors. Circulation zones describe only lift/stair/escalator groupings; their count is not the number of spaces or connections in the building.

## Three words

**Space** — a place you can stand. A room, a corridor, a lobby, the inside of a lift car. You have
already drawn these; the plan is full of them.

**Zone** — a group of spaces you have given a name. "Finance", "Public areas", "Lift A", "Muster
point B". A zone is *just a list of rooms*.

**Portal** — a way from one space to another. Usually a door, sometimes a gate or a turnstile,
sometimes just an opening in a wall with nothing in it at all.

That is the whole vocabulary. Everything else follows from those three.

## A real building

Here is Northwharf House, described the way a facilities manager would describe it:

> *Two floors. You come in off the street into the ground-floor lobby, past the reception turnstiles.
> Lift A runs from the lobby to both floors. The whole first floor is let to the finance team, and
> the server room up there is theirs alone — nobody else goes in. There's a fire exit at the back of
> the ground floor that pushes out onto the yard. The lobby opens straight onto the café; there's no
> door between them, they just run into each other.*

Every noun in that paragraph maps onto something.

**The rooms** — lobby, café, first-floor open plan, server room, the inside of the lift car on each
floor — are **spaces**. They are the areas already on the plan.

**"The finance team's area"** is a **zone**: a list naming the first-floor open plan and the server
room. Note that it is *not* the same thing as "the first floor" — the floor is a fact about the
building, the zone is a decision about who it belongs to. They happen to coincide today and might not
after the next tenant moves in.

**"The server room is theirs alone"** is a **zone nested inside another zone**. Finance contains the
server room, but — importantly — being inside Finance grants nobody access to it. Nesting describes
the building, not the permissions.

**"Lift A runs from the lobby to both floors"** is a **zone** containing the lift-car space on each
level, marked `connects: 'all'` — meaning any landing reaches any other, because a lift ride is
direct.

**The turnstiles** are **portals** between the street and the lobby. **The server-room door** is a
portal between the open plan and the server room. **The fire exit** is a portal too, but a one-way
one: out only.

**"The lobby opens straight onto the café"** is also a portal — one with no door in it at all. Open
boundaries are real connections; you can walk through them, so they need to exist in the model or
routing will think the café is unreachable.

Written out:

```ts
project.zones = [
  { id: 'z-server',  name: 'Server room', spaceIds: ['server-room'] },
  // Finance is the open plan plus everything in the server-room zone.
  { id: 'z-finance', name: 'Finance', spaceIds: ['open-plan-1'], childZoneIds: ['z-server'] },
  { id: 'z-lift-a',  name: 'Lift A', spaceIds: ['car-g', 'car-1'], connects: 'all' },
];

project.portals = [
  { id: 'p-turnstile', a: 'street', b: 'lobby', openingId: 'turnstile-1' },
  { id: 'p-server',    a: 'open-plan-1', b: 'server-room', openingId: 'door-server' },
  { id: 'p-fire',      a: 'lobby', b: 'yard', openingId: 'door-fire', passage: 'a-to-b' },
  { id: 'p-cafe',      a: 'lobby', b: 'cafe' },        // no openingId: an open boundary
  { id: 'p-lift-1',    a: 'car-1', b: 'open-plan-1', openingId: 'door-lift-1', attests: 'none' },
];
```

Note the last one. The lift *zone* says the two car spaces reach each other, but getting out of the
car onto the floor is still a door like any other — and `attests: 'none'` because pressing a button
in a lift says where you meant to go, not where you went.

::: tip This example is a test
`src/model/ontology.test.ts` builds Northwharf House exactly as written above and asserts the claims
made here, so the manual cannot drift away from what the code does. Writing it caught two real bugs:
outdoors is `floorId: null`, so a naive floor comparison turned every front door into a staircase,
and turnstiles were being read as open boundaries rather than ways through.
:::

`zoneSpaces(project, financeZone)` now returns the open plan *and* the server room, because nesting
gathers upwards. But `perimeter(project, serverZone)` returns exactly one portal — the server-room
door — which is the door that has to be controlled separately. Both answers keep working after
somebody redraws the floor, because both are computed from the plan rather than typed out.

## Things you might say, and what they are

| What you'd say out loud | What it is |
| --- | --- |
| "Meeting room 3.14" | a **space** |
| "The third floor" | a **floor** — that already exists in the plan |
| "The bit of the third floor that Finance rents" | a **zone** |
| "Fire compartment 2" | a **zone**, `purpose: 'evacuation'` |
| "Everywhere a contractor may go" | a **zone** — the rooms need not be near each other |
| "The server room, inside the finance floor" | a **zone nested in a zone** |
| "Lift A" | a **zone** of landing spaces, `connects: 'all'` |
| "The main stairwell" | a **zone**, `connects: 'adjacent'` — you pass each level |
| "The lift bank" (three cars, same landings) | a **zone** containing the three lift zones |
| "The door to the server room" | a **portal** |
| "The fire exit" | a **portal**, `passage` one-way |
| "The lobby turnstiles" | **portals** — several, one per lane |
| "Reception opens onto the atrium" | a **portal** with no `openingId` |
| "The front and rear doors of the lift car" | **two portals** out of one car space |
| "All the loading-bay shutters" | a **portal group** |
| "The muster point" | a **space**, usually also in an evacuation **zone** |

Two things are deliberately *not* on that list. **A window** is not a portal — you cannot walk
through it. And **a person's badge** is not anything here at all: the ontology describes the
building, not who may move around it.

## Why a zone is only a list

Calling a zone "just a list of rooms" sounds too simple to be useful. It is exactly why it works.

Because a zone is a list and not a shape, it can contain rooms on **different floors**, in
**different buildings**, or rooms that are **nowhere near each other**. "Everywhere a contractor may
go" is a perfectly good zone even if those rooms are scattered across a site. A shape could never
describe that; a list does it without trying.

It also means one room can belong to **several zones at once**. The third-floor kitchen can be in
"Finance", in "Fire compartment 2", and in "Cleaned nightly", and none of those has to know about the
others.

::: tip Grouping is not permission
Putting a room in a zone does not give anyone access to it. Zones say what things *are*; who may go
where is a separate question, and Kerros deliberately leaves it to you. Mixing the two is a classic
way to create security bugs.
:::

## Why a door has two sides and no direction

Ask which side of a door is the "entrance" and the honest answer is: it depends on where you are
standing. The same door leaf is the way *in* to the office and the way *out* of the corridor.

So a portal stores **both** of its sides and settles direction only when you ask a specific question:
"how do I get into the office from here?" This sounds like a technicality, and it is the difference
between being able to say *"badge to get in, push to get out"* and not.

Some ways through only work one way — a fire exit lets you out and never back in. That is a property
of the portal, not of the door.

Applications pull the other way, and it is worth knowing why before resisting it. Software that
attaches a rule to each direction of travel wants **two records** — one per direction of crossing,
each with its own settings — because that is the shape a rule takes. It is the right shape for an
application layer and the wrong one for a plan: the plan has one doorway, and which side is "entry"
depends on the area you are asking about. So Kerros stores the door once, as one portal with two
sides, and a host that needs per-direction behaviour projects it into two records keyed by portal id
and direction. The pull toward two records *in the schema* will keep coming up; resist it here,
expect it in the host.

One more deliberate choice: a portal **references** its door (`openingId`) rather than absorbing it.
One physical leaf can carry more than one portal, and a model that fuses the door into the connection
can no longer say that two crossings share a leaf — which is exactly what you need to say when that
leaf is propped open, serviced, or forced.

## Did they actually go through?

Here is a subtlety that catches people out, and it matters as soon as you try to count who is in a
building.

When a door is unlatched for someone, you know it was *opened for* them. You do not necessarily know
they walked through. They may have held it for a colleague, or changed their mind. If the door has a
sensor, you know. If it does not, you are guessing — reasonably, but guessing.

A lift is the extreme case. Pressing "7" in a lift car says where someone would *like* to go. They
may get out on 4, or ride back down, or not get out at all. **A floor button is a request, not an
observation.** This is why software that counts people in a building cannot treat a lift ride as a
crossing.

Kerros records this on each portal, so software built on it can tell the difference between "we saw
it happen", "we think it happened", and "this was only ever a request".

## What you get for free

Once the building is described this way, some questions that are normally laborious become
computations.

**"Which doors control entry to this zone?"** — the portals with one side inside and one side outside.
Add a door to the plan and the answer updates itself.

**"Which room is on the other side of this door?"** — the plan already knows. You do not have to
tell it.

That second one is worth pausing on. Software without a plan to ask makes an operator enumerate an
area's doors by hand, one at a time — and when the building is redrawn, the list quietly goes stale.
Kerros has the geometry, so it can just read the answer.

**Lifts and stairs** stop being special cases. A lift is a zone containing its landing spaces, with a
note saying "all of these reach each other". A seventeen-storey lift is one line, not a hundred and
thirty-six connections typed out by hand.

And a lift car with doors on **both sides** — common in older buildings, and a genuine headache, since
the two lobbies often belong to different tenants — needs no special support at all. It is one space
with two portals leading out of it. Each lands on its own tenant's boundary automatically.

**Wayfinding** comes out of the same description. If spaces are places and portals are the ways
between them, that is already a map of how to get around; Kerros builds the routing graph from it
rather than making you draw the route network a second time.

---

# How it works

The rest of this page is the technical detail.

## Spaces are the areas you already drew

A space is any object with a footprint — a room, a zone area, a lift car, a parcel. There is no
separate entity: a room *is* a space, and zones and portals refer to it by id.

```ts
import { spaces, spaceAt } from '@kerros/schema';

spaces(project);                                  // every area object
spaceAt(project, 'floor-03', [12.4, -3.1]);       // the smallest space containing a point
```

`spaceAt` returns the *smallest* space containing the point, because a desk pod inside an office
inside a floor plate are all true and only the innermost is useful.

Containment between spaces stays where it was, on `SiteObject.parentId`: one parent, same floor,
geometrically inside. That is the strict containment tree, and every building-modelling standard has
one. Zones are what you reach for when you need anything looser.

## Zones

```ts
project.zones = [
  { id: 'z-secure', name: 'Secure floor', spaceIds: ['room-a', 'room-b'] },
  { id: 'z-lift-a', name: 'Lift A', spaceIds: ['car-g', 'car-1', 'car-2'], connects: 'all' },
];
```

| Field | Meaning |
| --- | --- |
| `spaceIds` | The areas in this zone. May span floors and buildings; need not be contiguous. |
| `childZoneIds` | Zones may nest — as a DAG, not a tree. Several parents are fine, cycles are rejected. |
| `connects` | How the zone's own spaces reach each other. See [lifts and stairs](#lifts-and-stairs). |
| `purpose` | Your vocabulary: `'security'`, `'evacuation'`, `'hvac'`. The core never interprets it. |

## Portals

```ts
project.portals = [
  { id: 'p-1', a: 'lobby', b: 'office', openingId: 'door-12', attests: 'assumed' },
  { id: 'p-2', a: 'stair', b: 'street', passage: 'a-to-b' },   // fire exit: out only
];
```

### Direction is asked, not stored

```ts
import { entryInto } from '@kerros/schema';

entryInto(portal, 'office');   // 'a-to-b'  — this is how you get in
entryInto(portal, 'stair');    // null      — one-way; you cannot come back
```

`passage` limits what is possible at all: `'both'` (default), `'a-to-b'`, `'b-to-a'`, `'none'`.

### `attests` — how far to trust a crossing

| Value | Meaning |
| --- | --- |
| `'confirmed'` | A sensor saw it — a door monitor opening and closing. |
| `'assumed'` | Inferred from a grant. Nobody watched. The sensible default for a plain door. |
| `'none'` | The crossing is a **request**, not an event. Lifts. |

### Portals are inferred from your plan

You usually do not write portals by hand:

```ts
import { inferPortals } from '@kerros/schema';

project.portals = inferPortals(project);
```

For each door, gate and turnstile, this probes across the wall it sits in and finds the space on
either side. Openings it cannot resolve are **skipped rather than guessed at** — a door with no room
on one side is a real gap in the plan, and inventing a portal would hide it. Windows are never
portals; you cannot walk through one.

### Most connections have no door in them

Doors are the minority. A department store is mostly open plan; a lift car meets its lobby with
nothing between them; a café runs into a lobby. Those are all real ways through, and none of them has
a door object to find:

```ts
project.portals = [...inferPortals(project), ...inferOpenBoundaries(project)];
```

`inferOpenBoundaries` reads shared virtual edges directly for connected spaces. This also finds
narrow openings that outline sampling can miss near adjoining wall ends. `effectivePortals(project)`
combines these connections with stored portals, respecting sealed and one-way passage; routing,
zone boundaries and the structure panel use this view even when an older import omitted a portal.
Re-reading portals persists the same derived connections.

For independent outlines, inference walks each outline and records unwalled shared runs.
Runs long enough to walk through become portals; two rooms
brushing at a corner do not. They are marked `attests: 'none'` — nothing watches an open edge, so a
crossing there can never be observed.

The difference on a real building is not marginal. On the Stockmann demo, doors alone leave **1,323
of 1,494 spaces with no way in or out**, and every one of its lift shafts a dead end — you can ride
between floors but never get out. Adding open boundaries connects **all of them**. (These numbers are
asserted in `app/demo/demo.test.ts`, so they move with the building or not at all.)

::: warning If routing says nowhere is reachable
This is almost always why. Door-only inference describes a building made entirely of corridors and
closed rooms, which is not the building you drew.
:::

## Authoring zones

Portals are read off the plan; zones are the part someone has to decide. The editor's structure panel
does this, and so can you:

```ts
import { addZone, setZoneMembers, nestZone, removeZone, refreshPortals } from '@kerros/schema';

const finance = addZone(project, 'Finance', ['open-plan-1'], 'security');
setZoneMembers(project, finance.id, ['meeting-3'], true);   // add
setZoneMembers(project, finance.id, ['meeting-3'], false);  // and remove
nestZone(project, finance.id, serverRoom.id);               // false if it would make a cycle
removeZone(project, finance.id);                            // also clears any nesting reference
refreshPortals(project);                                    // re-read from the plan
```

A few behaviours worth knowing, all of them deliberate:

- **`addZone` drops ids that are not spaces.** A selection usually has a camera or a door in it
  alongside the rooms, and losing the whole gesture over that would be tiresome.
- **Membership is a set.** Adding twice is not an error, and neither is removing something that was
  never a member.
- **`nestZone` returns `false` rather than making a cycle.** Zones are a DAG; a cycle is the one shape
  the validator rejects outright.
- **`removeZone` clears nesting references to it**, because a dangling `childZoneIds` entry fails
  validation.
- **`refreshPortals` keeps what a person decided.** Portals you authored yourself survive wholesale,
  and on re-inferred ones the `passage`, `attests`, `name` and `metadata` you set are carried onto
  the replacement — sealing a doorway survives the plan being redrawn around it. Inference is cheap
  and the plan changes; a decision someone made by hand is neither, so it wins. A portal the plan no
  longer describes goes, and its edits go with it.

## Walls and spaces

A wall drawn across a space **divides it**. Without that, both halves are the same place: routing
walks straight through the wall, they cannot belong to different zones, and occupancy counts them
once.

```ts
import { divideSpaces, spacesRejoinedBy, mergeSpaces } from '@kerros/schema';

divideSpaces(project, floorId, a, b);   // split whatever this wall crosses
```

Only walls divide — a fence outdoors separates nothing you could stand in. A wall that stops halfway
across leaves the space whole: that is a stub, not a partition.

### Removing a wall asks

The reverse is **not** symmetric, and the editor never decides it for you. When you delete a wall that
was the only thing between two spaces, it asks:

```ts
const pair = spacesRejoinedBy(project, wallId);   // the two spaces, or null
mergeSpaces(project, keep.id, absorbed.id);        // only when someone has chosen
```

Splitting is safe — one space becomes two and both inherit everything. Merging destroys an identity:
the absorbed space loses its name, its feed binding, and any zones it had joined. That is not
something to do as a side effect of deleting a wall, and it is not undone by drawing the wall back.

So the choice is offered explicitly — keep both spaces (now simply open to each other), or merge, and
say which name survives.

## Zone boundaries, derived

```ts
import { perimeter, captive } from '@kerros/schema';

perimeter(project, zone);   // portals with one side in, one side out — these are the ways in
captive(project, zone);     // portals wholly inside — crossing one does not change zone
```

The distinction is not cosmetic: anything that tracks where somebody ended up needs to know that
crossing a captive door does not move you anywhere.

## Lifts and stairs

```ts
{ id: 'z-lift', name: 'Lift A', spaceIds: [...17 landings], connects: 'all' }
```

| `connects` | Meaning |
| --- | --- |
| `'all'` | Every space mutually reachable — a lift, where a ride is direct. |
| `'adjacent'` | Reachable in elevation order — a stair, where you pass each level in turn. |
| `'up'` / `'down'` | Adjacent but one-way — an escalator, which carries you in a single direction. |

### A car with front and rear doors

```ts
// One car space on level 3, two portals, two different lobbies.
{ id: 'p-front', a: 'car-3', b: 'lobby-front', openingId: 'door-f', attests: 'none' }
{ id: 'p-rear',  a: 'car-3', b: 'lobby-rear',  openingId: 'door-r', attests: 'none' }
```

`perimeter()` then puts each opening on its own tenant's boundary automatically, because they are
portals into different zones. There is no `side: 'front' | 'rear'` field anywhere.

::: warning Authorize the landing, never the car
In a destination-dispatch lift bank the access decision happens at the kiosk, and only afterwards
does the group controller assign a car. Which car serves which landing is a **reachability fact, not
an authorization one** — a rule keyed to a car is a rule keyed to a scheduling accident. Key lift
rules to the landing's zone.
:::

## Navigation is derived from all this

Spaces are nodes, portals are edges, and `connects` supplies the vertical ones. If a document has no
authored `navNodes`/`navEdges`, routing uses this derived graph automatically:

```ts
import { derivedGraph } from '@kerros/schema';

const { nodes, edges } = derivedGraph(project);
```

::: tip Spatial completeness
A derived graph only has nodes where spaces are. If your corridors are not drawn as spaces, routes
cannot pass through them. Drawing circulation as real areas is worth doing anyway — it is what makes
the plan describe the building rather than just depict it.
:::

## Where the line is

The schema models **topology** — what exists, what contains what, what connects to what, in which
direction, and how far a crossing can be trusted.

It does not model **policy** — who may pass, when, or why; who is where; what any of it should cost
or trigger. Those are yours, attached by id. The same topology serves wayfinding, evacuation planning,
HVAC zoning, space reservation and occupancy analysis without preferring any of them.

A few things are deliberately absent, each because its price is a second description of the building
that can drift from the first:

- **Zones have no geometry.** A zone with a shape of its own is a second spatial decomposition to
  keep consistent with the spaces, and every query must then ask which one it means. The rule that
  keeps the two concepts apart: contiguous with a shape → a space; a scattered set → a zone.
- **The hole is not modelled.** A door sits on a wall; there is no separate "opening void" entity
  between them. Formats whose walls are solid geometry need one, because a door must be subtracted
  from the solid before it can be filled. A plan does not.
- **Connections are not heavyweight entities.** A portal is two foreign keys and a metadata bag, not
  an object with its own lifecycle. The same expressiveness at a fraction of the entity count.
- **One connectivity layer.** Spaces and portals form a single graph. Parallel layered graphs —
  sensor coverage, say — are a host concern until a real second layer exists.

---

The join between this description and whatever you build on it is an id. Keep your rules in your own
store, keyed by a space, zone or portal id, and the two halves stay independently changeable —
somebody redraws a floor, and your application is still about the same zone.
