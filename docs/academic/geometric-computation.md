# Geometric computation and numerical precision

Part of the optional [Mathematical foundations](/guide/geometry-mathematics) series. These arguments explain the model and its limits; they are not a formal verification of Kerros. The implementation uses finite-precision arithmetic, tolerances and regression tests.

## Area, holes and virtual splits

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

## Numerical predicates and coordinate precision

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

## Rendered joins and constrained alignment

The rendering surface and the editing graph answer different questions. The graph records which
walls meet; a mitre constructs where their offset faces meet. Let two rays leaving a junction have
unit directions $u,v$, and let $a,b$ be points on the two faces bordering one wedge. Define the planar
cross product by $x\times y=x_1y_2-x_2y_1$. When $u\times v\ne0$, their intersection is

$$
t=\frac{(b-a)\times v}{u\times v},\qquad q=a+tu.
$$

**Derivation.** Substitute $a+tu=b+sv$ and take the cross product with $v$. The term $sv\times v$
vanishes, giving the formula. Both adjacent wall pieces use the same computed $q$, so their joined
faces share a corner exactly. Nearly parallel rays make the denominator small; the renderer bounds
the mitre and uses a common bevel point for acute joins and very short returns. This is a rendering
construction, not a change to the stored centreline graph or the footprint-subtraction rule in [the related argument](/academic/computational-topology#wall-thickness-and-net-footprints).

A wall sliding without rotating has one degree of freedom. An attached endpoint starts at $p$ and
moves along the selected wall's unit normal $n$ by displacement $s$. For an adjoining segment to point
along a target direction $d$ from its fixed end $c$, solve

$$
(p+sn-c)\times d=0,
\qquad
s=\frac{(c-p)\times d}{n\times d},\quad n\times d\ne0.
$$

The editor tests directions at 15° intervals relative to the floor's main axis and the selected
wall's own direction. It accepts a nearby displacement within the screen-derived snapping tolerance,
then applies the full geometry validation on release. A rejected drop preserves the preceding valid
document; the transient pointer preview is not a model state. Remote endpoints remain fixed. Incompatible constraints
need not have a common solution; snapping does not prove that every adjoining wall can be aligned
simultaneously.
