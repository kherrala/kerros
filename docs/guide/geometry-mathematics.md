# Mathematical foundations of space geometry

This optional page develops the mathematical background of the [geometry model](/guide/geometry). It is intended for academic interest; none of these derivations are needed to draw a floor plan.

The statements below describe an ideal planar model and explain why shared boundaries reduce maintenance. The proof sketches are not a formal verification of Kerros. The implementation uses finite-precision coordinates, numerical tolerances and validation, and its supported cases are exercised by regression and randomized tests.

## 1. A floor as an embedded graph

Let a floor's boundary network be a finite graph $G=(V,E)$ with an embedding $p:V\to\mathbb{R}^2$. A junction is a vertex $v\in V$. An edge $e=\{u,v\}$ is represented by the straight segment

$$
\gamma_e(t)=(1-t)p(u)+tp(v),\qquad 0\leq t\leq 1.
$$

Assume distinct vertices have distinct positions, edges have positive length, edge interiors contain no vertices, and distinct edges meet only at shared endpoints. These are the conditions of a plane graph: a crossing in the drawing must first be split into a vertex, and overlapping collinear edges must be resolved.

The connected components of the complement of the embedded graph are its **faces**. One is unbounded. Physical walls and virtual boundaries both contribute edges to this subdivision; wall thickness is applied afterwards.

This is the same mathematical distinction between embedded geometry and incidence used in planar arrangements. A full doubly connected edge list (DCEL) also stores twin half-edges and face incidence; Kerros derives traversal information when needed and persists only the edges and a labelled space's boundary loops. See the [CGAL arrangement definition](https://doc.cgal.org/latest/Arrangement_on_surface_2/classCGAL_1_1Arrangement__2.html).

## 2. Directed boundaries and shared consistency

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

## 3. Jordan separation and holes

The polygonal Jordan curve theorem states that a simple closed polygonal curve separates the plane into exactly two connected regions: one bounded and one unbounded, with the curve as their common boundary. A proof is given in Jeff Erickson's [notes on planar graphs](https://jeffe.cs.illinois.edu/teaching/comptop/2017/chapters/02-planar-graphs.pdf).

For a space, let $O$ be the closed region of the outer loop, and let $H_1,\ldots,H_k$ be closed hole regions whose boundaries are pairwise disjoint and lie strictly inside $O$. Its centreline footprint, ignoring choices about boundary-point membership, is

$$
P=O\setminus\bigcup_{i=1}^{k}\operatorname{int}(H_i).
$$

Counterclockwise outer loops and clockwise hole loops place $P$ on the left of each directed boundary. The strict containment and disjointness assumptions matter: a self-intersection, touching hole or hole outside $O$ is not covered by this construction. Kerros validates these relationships rather than treating an arbitrary list of vertices as a valid polygon.

For a machine-checked treatment of a related discrete theorem, see Jean-François Dufourd's [Jordan curve proof using hypermaps](https://arxiv.org/abs/0802.2853). That proof is background literature, not a proof of this codebase.

## 4. Euler's formula as a topology check

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

## 5. Area, holes and virtual splits

For a ring with vertices $q_i=(x_i,y_i)$ and $q_n=q_0$, its signed area is the shoelace sum

$$
A_s(q)=\frac12\sum_{i=0}^{n-1}
\left(x_i y_{i+1}-x_{i+1}y_i\right).
$$

**Derivation.** On one directed segment, parameterize $q(t)=q_i+t(q_{i+1}-q_i)$. Integration gives

$$
\frac12\int_{q_i}^{q_{i+1}}(x\,dy-y\,dx)
=\frac12(x_i y_{i+1}-x_{i+1}y_i).
$$

Summing the segments and applying Green's area formula yields the expression. For correctly oriented outer and hole rings, usable polygon area before wall subtraction is

$$
A(P)=A_s(O)+\sum_{j=1}^{k}A_s(H_j)
=|A_s(O)|-\sum_{j=1}^{k}|A_s(H_j)|.
$$

**Proposition — virtual-split area conservation.** Suppose a simple separator lies inside a space, meets its boundary only at its two distinct endpoints and divides it into regions $P_1$ and $P_2$. Then

$$
A(P)=A(P_1)+A(P_2).
$$

**Proof.** The two regions cover $P$ and intersect only along their common separator. A finite union of line segments has planar area zero, so finite additivity of area gives the result. Equivalently, the separator appears in the two shoelace sums in opposite directions and its contributions cancel. $\square$

This applies to represented geometry before discarding undersized regions. If a sliver remains unlabelled, the sum of **labelled** room areas need not equal the original area. A physical partition also occupies positive floor area, so its usable-area accounting is different.

## 6. Wall thickness and net footprints

Let a wall start at $a$, have length $\ell>0$, thickness $w>0$, unit tangent $\mathbf u$ and unit normal $\mathbf n$. The rectangular swept body used for footprint clipping extends by half a thickness at each end:

$$
\begin{aligned}
W_e&=a+I\mathbf u+J\mathbf n,\\
I&=\left[-\frac w2,\ell+\frac w2\right],\\
J&=\left[-\frac w2,\frac w2\right].
\end{aligned}
$$

Here interval scaling and addition denote the set of all $a+t\mathbf u+s\mathbf n$ with $t\in I$ and $s\in J$.

For centreline space region $P$ and physical edges $E_{\mathrm{physical}}$, the net footprint is

$$
N(P)=P\setminus\bigcup_{e\in E_{\mathrm{physical}}}W_e.
$$

The wall union avoids counting overlap at corners twice. A virtual edge contributes no $W_e$. A wall added to a previously unwalled divider therefore reduces usable area by the part of its body inside the old net footprint.

**Proposition — disjoint interiors remain disjoint under wall subtraction.** If $P_1$ and $P_2$ have disjoint interiors, so do $N(P_1)$ and $N(P_2)$.

**Proof.** Each net footprint is a subset of its centreline region. Subtracting a set cannot introduce a point into either region or create an interior intersection. $\square$

This is conditional on a valid subdivision. Checking that an edge side has one owner is useful, but that check alone cannot establish planarity or exclude overlap between unrelated independent polygons.

Subtraction does not preserve connectivity: a thick wall can seal a narrow neck before its centreline reaches another edge. Kerros refuses a connected space with multiple usable components and asks for an explicit division. A mathematical face and a usable room are therefore distinct objects.

## 7. Numerical predicates and coordinate precision

The orientation determinant of three points is

$$
\operatorname{orient}(a,b,c)=
(b_x-a_x)(c_y-a_y)-(b_y-a_y)(c_x-a_x).
$$

Its sign distinguishes left turn, right turn and collinearity in exact arithmetic. Near zero, floating-point roundoff can change that sign and therefore change a topology decision. Shewchuk's [adaptive robust predicates](https://www.cs.cmu.edu/~quake/robust.html) explain this failure mode and algorithms that compute the predicate sign reliably.

Robust predicates and robust coordinate constructions are separate requirements. An accurate orientation sign does not make a computed intersection an exact rational coordinate. Kerros currently uses tolerances and clipping-input cleanup; it does not claim an exact-arithmetic arrangement kernel.

### Why centimetre rounding is not a topology proof

For square-grid spacing $\delta$, rounding each coordinate to its nearest grid point gives

$$
\|\widehat p-p\|_\infty\leq\frac\delta2,
\qquad
\|\widehat p-p\|_2\leq\frac\delta{\sqrt2}.
$$

The first inequality follows coordinate by coordinate; the second follows by summing the two squared errors. Even for $\delta=0.01\,\mathrm m$, this nonzero displacement can move a computed intersection off an oblique line or collapse distinct nearby vertices. A distance bound alone gives no topology guarantee without further separation assumptions.

Stored junction positions retain their computed coordinates. Derived clipping inputs are rounded at 0.1 mm and scaled before polygon operations. Intersection outputs retain finer precision. These choices improve practical numerical behavior but are approximations, so tests compare within tolerances rather than asserting exact real-number equality.

## 8. Transactions and the scope of the guarantee

Let $\mathcal V$ be the set of documents accepted by the current validator. A transaction applies an edit, synchronizes derived geometry and either returns a validated result or retains the original document:

$$
T:\mathcal V\times\mathrm{Edit}\longrightarrow\mathcal V.
$$

**Inductive argument.** If the initial document belongs to $\mathcal V$ and every published edit passes through this gate, then every subsequently published document belongs to $\mathcal V$: the next result is either checked and accepted, or is the preceding valid document. $\square$

This establishes closure under the implemented validation contract. It does not establish that the validator is complete, that every requested gesture is feasible, or that every accepted document is a complete floor partition. Tests cover normalization, both sides of a moving wall, holes, opening attachments, minimum area, identity preservation, persistence, and recovery after refused operations. The mathematical arguments explain the intended invariants; the tests and validation check their implementation.
