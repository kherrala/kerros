# Graph theory and indoor maps

Part of the optional [Mathematical foundations](/guide/geometry-mathematics) series. These arguments explain the model and its limits; they are not a formal verification of Kerros. The implementation uses finite-precision arithmetic, tolerances and regression tests.

## A floor as an embedded graph

Let a floor's boundary network be a finite graph $G=(V,E)$ with an embedding $p:V\to\mathbb{R}^2$. A junction is a vertex $v\in V$. An edge $e=\{u,v\}$ is represented by the straight segment

$$
\gamma_e(t)=(1-t)p(u)+tp(v),\qquad 0\leq t\leq 1.
$$

Assume distinct vertices have distinct positions, edges have positive length, edge interiors contain no vertices, and distinct edges meet only at shared endpoints. These are the conditions of a plane graph: a crossing in the drawing must first be split into a vertex, and overlapping collinear edges must be resolved.

The connected components of the complement of the embedded graph are its **faces**. One is unbounded. Physical walls and virtual boundaries both contribute edges to this subdivision; wall thickness is applied afterwards.

This is the same mathematical distinction between embedded geometry and incidence used in planar arrangements. A full doubly connected edge list (DCEL) also stores twin half-edges and face incidence; Kerros derives traversal information when needed and persists only the edges and a labelled space's boundary loops. See the [CGAL arrangement definition](https://doc.cgal.org/latest/Arrangement_on_surface_2/classCGAL_1_1Arrangement__2.html).

## Directed boundaries and shared consistency

Each edge has two directed uses, $h=(u,v)$ and its twin $\bar h=(v,u)$. If $\gamma_h$ follows the first direction, then

$$
\gamma_{\bar h}(t)=\gamma_h(1-t).
$$

**Proposition — shared-boundary consistency.** If two spaces reference opposite uses of the same edge, every update of that edge's endpoint positions gives both spaces the same centreline boundary, with opposite traversal.

**Proof.** Both uses evaluate the same two stored positions. After replacing $p$ with updated positions $p'$, the formula above still holds by substituting $1-t$ for $t$. There are no separately stored space-corner coordinates to synchronize. $\square$

This is a local statement about the common boundary. It does not prove that an arbitrary movement preserves planarity, keeps holes inside their outer loop or leaves positive usable area. Those conditions must be checked after an edit.

### Following a face

Sort the outgoing directions around each junction counterclockwise. After arriving along $h$, take the outgoing direction immediately clockwise from $\bar h$. This keeps the incident face on the left. Repeating the operation traces a boundary walk.

A bridge has the same face on both sides and does not create another face. The implementation removes bridges from the boundary-cycle traversal while retaining their physical wall bodies for footprint subtraction. Nested disconnected cycles can contribute holes. The simple-loop space representation requires non-crossing outer and hole loops; arbitrary graph boundary walks can revisit vertices and are not automatically valid space polygons.

## Euler's formula as a topology check

For a finite plane graph with $C$ connected components, count every vertex and edge and every face, including the unbounded face. Euler's relation is

$$
|V|-|E|+|F|=1+C.
$$

Consequently, the number of bounded faces is

$$
F_{\mathrm{bounded}}=|E|-|V|+C.
$$

**Proof sketch.** A spanning forest has $|V|-C$ edges and one face. Each remaining embedded edge closes a cycle and divides a face, increasing both the edge count and the face count by one. Thus the expression is unchanged. This is the spanning-forest argument behind Euler's formula; see [Erickson's planar-graph notes](https://jeffe.cs.illinois.edu/teaching/comptop/2017/chapters/02-planar-graphs.pdf). $\square$

For example, splitting an edge adds one vertex and one edge and therefore leaves the face count unchanged. Adding a divider across one face adds a bounded face. Adding a dangling branch adds one vertex and one edge and creates no face.

The regression suite checks this relation on a graph with crossings, a bridge and a nested disconnected component. It counts graph faces, **not labelled rooms**: unassigned faces and the 1 m² usable-area filter mean the number of rooms may be smaller. Numerical removal of degenerate cycles must also be distinguished from the exact theorem.

## Geometric navigation and shortest paths

Let $R$ be a room's polygonal region, $O$ the union of wall bodies, pools and floor openings, and
$r>0$ the desired clearance. A candidate segment between access points $a,b$ is accepted only when

$$
[a,b]\subseteq R,
\qquad [a,b]\cap O=\varnothing,
\qquad \operatorname{dist}([a,b],\partial O)\ge r.
$$

The implementation checks polygon intersection intervals and segment-to-edge distances. In
particular, a midpoint test alone is insufficient: a segment can leave and re-enter a concave room
while its midpoint remains inside. Candidate waypoints at offset polygon corners make many useful
detours representable without requiring a tessellated navigation mesh.

For the resulting finite graph $G=(V,E)$ with nonnegative edge costs $c(e)$, routing minimizes

$$
d(s,t)=\min_{P:s\leadsto t}\sum_{e\in P}c(e).
$$

**Dijkstra invariant.** When the smallest tentative label is removed from the priority queue, no
unsettled path can improve that vertex's label: any such path must first cross an unsettled vertex
whose tentative cost is at least as large, then add only nonnegative costs. Induction proves that
settled labels are shortest-path costs. A destination's approach cost is included in the stopping
bound. Directed edges preserve one-way crossings; vertical edges add the chosen transport cost.

This proves optimality **within the constructed graph**. It does not prove a globally shortest
continuous path for an arbitrary clearance-offset floor, nor that the waypoint set is complete for
every possible narrow passage. A rejected geometric connection stays absent; drawing a smoother
curve across an obstacle would not repair its absence. Tests exercise concavity, rotation, pools,
floor holes, narrow doorways, one-way crossings and the generated multi-floor layouts.
