# Geometry and topology validation

Part of the optional [Mathematical foundations](/guide/geometry-mathematics) series. These arguments explain the model and its limits; they are not a formal verification of Kerros. The implementation uses finite-precision arithmetic, tolerances and regression tests.

## Transactions and the scope of the guarantee

Let $\mathcal V$ be the set of documents accepted by the current validator. A transaction applies an edit, synchronizes derived geometry and either returns a validated result or retains the original document:

$$
T:\mathcal V\times\mathrm{Edit}\longrightarrow\mathcal V.
$$

**Inductive argument.** If the initial document belongs to $\mathcal V$ and every published edit passes through this gate, then every subsequently published document belongs to $\mathcal V$: the next result is either checked and accepted, or is the preceding valid document. $\square$

This establishes closure under the implemented validation contract. It does not establish that the validator is complete, that every requested gesture is feasible, or that every accepted document is a complete floor partition. Tests cover normalization, both sides of a moving wall, holes, opening attachments, minimum area, identity preservation, persistence, and recovery after refused operations. The mathematical arguments explain the intended invariants; the tests and validation check their implementation.

## Geometry, topology and the validation contract

Geometry describes positions, lengths and regions. Topology describes incidence and connectivity:
which endpoints are shared, which directed edges bound a space, and which spaces a portal joins.
The zone hierarchy is another graph, distinct from both the planar boundary graph and the navigation
graph. A valid hierarchy need not be connected, and a valid floor need not make every room reachable.

Write document acceptance schematically as a conjunction of predicates:

$$
V(P)=V_{\mathrm{schema}}(P)\land V_{\mathrm{references}}(P)
\land V_{\mathrm{geometry}}(P)\land V_{\mathrm{boundaries}}(P)
\land V_{\mathrm{ontology}}(P)\land V_{\mathrm{navigation}}(P).
$$

These predicates have different responsibilities. The following describes the implemented contract,
not a claim that the validator decides every property of a building.

| Layer | Conditions checked | Mathematical purpose |
| --- | --- | --- |
| Coordinates and references | Finite, bounded coordinates; positive dimensions where required; unique IDs; valid floor, building and object references | Exclude undefined constructions and dangling incidence |
| Area rings | Nondegenerate simple rings; holes inside the outer ring; no intersecting or nested holes | Represent a polygonal region with the separation assumptions in [the related argument](/academic/computational-topology#jordan-separation-and-holes) |
| Shared boundaries | Valid edge references and closed walks on the same floor; correct orientation; one derived face per bound space; at most one owner of each directed edge side | Keep face incidence consistent with the boundary network |
| Derived footprints | Recomputed wall subtraction, rings, position and dimensions agree with stored derived values; disconnected usable pieces require division | Keep cached geometry consistent with its source |
| Openings | Valid host kind and floor; opening fits its host segment; attached openings do not overlap | Preserve the one-dimensional attachment constraints below |
| Zones and portals | Existing, distinct memberships; acyclic zone nesting; portals connect distinct existing spaces; valid opening kinds and passage directions | Keep semantic incidence well defined |
| Authored navigation | Existing distinct endpoints, valid costs and coordinates, compatible floor transitions and object bindings | Define a usable weighted graph for routing |

The concrete rules live in `validateProject`, `validateSpaceBoundaries` and `transact`. Some are
state invariants; others constrain a transition. In particular, new or resized spaces require at
least $1\,\mathrm{m}^2$ of usable area, while an unchanged smaller legacy area can remain readable
and be renamed. This is a policy threshold, not a geometric theorem.

Thus the acceptance gate in [the related argument](/academic/validation#transactions-and-the-scope-of-the-guarantee) is more precisely described using both the old and proposed states:

$$
\operatorname{accept}(P,P')=V(P')\land A(P,P'),
$$

where $A$ includes edit-specific rules such as the area policy. Synchronization runs before this
test. A transient drag preview or unaccepted AI proposal is not a published document.

### Opening fit is an interval problem

Parameterize a host wall by distance $t\in[0,L]$. An opening with centre offset $o_i$ and width $w_i$
occupies the interval $I_i=[o_i-w_i/2,o_i+w_i/2]$. In ideal arithmetic, containment and nonoverlap are

$$
\frac{w_i}{2}\le o_i\le L-\frac{w_i}{2},
\qquad
|o_i-o_j|\ge\frac{w_i+w_j}{2}\quad(i\ne j).
$$

The first follows by requiring both interval endpoints to belong to $[0,L]$; the second follows
by ordering two interval centres and comparing the adjacent endpoints. The implementation allows
a small numerical tolerance. If a wall is split or shortened, these inequalities must be checked
against the resulting host segment, not its former length.

### Hierarchy cycles and physical reachability

Zone nesting must form a directed acyclic graph. During depth-first traversal, an edge to a vertex
already on the active recursion path closes a directed cycle. Conversely, traversing a directed
cycle must encounter such an active vertex before finishing that cycle. This justifies the
validator's active/finished traversal sets.

No cycle in the zone hierarchy does **not** imply that rooms are mutually reachable. Reachability
is a separate question on the navigation graph, with portal directions, barriers and vertical
transport taken into account. Nor do local reference checks prove that arbitrary independent
space polygons form a complete, nonoverlapping partition. The plane-graph theorems above require
their stated embedding assumptions; an Euler count alone cannot certify those assumptions.
