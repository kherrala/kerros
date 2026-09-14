# Computational topology

Part of the optional [Mathematical foundations](/guide/geometry-mathematics) series. These arguments explain the model and its limits; they are not a formal verification of Kerros. The implementation uses finite-precision arithmetic, tolerances and regression tests.

## Jordan separation and holes

The polygonal Jordan curve theorem states that a simple closed polygonal curve separates the plane into exactly two connected regions: one bounded and one unbounded, with the curve as their common boundary. A proof is given in Jeff Erickson's [notes on planar graphs](https://jeffe.cs.illinois.edu/teaching/comptop/2017/chapters/02-planar-graphs.pdf).

For a space, let $O$ be the closed region of the outer loop, and let $H_1,\ldots,H_k$ be closed hole regions whose boundaries are pairwise disjoint and lie strictly inside $O$. Its centreline footprint, ignoring choices about boundary-point membership, is

$$
P=O\setminus\bigcup_{i=1}^{k}\operatorname{int}(H_i).
$$

Counterclockwise outer loops and clockwise hole loops place $P$ on the left of each directed boundary. The strict containment and disjointness assumptions matter: a self-intersection, touching hole or hole outside $O$ is not covered by this construction. Kerros validates these relationships rather than treating an arbitrary list of vertices as a valid polygon.

For a machine-checked treatment of a related discrete theorem, see Jean-François Dufourd's [Jordan curve proof using hypermaps](https://arxiv.org/abs/0802.2853). That proof is background literature, not a proof of this codebase.

## Wall thickness and net footprints

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

## Small displacement can change topology

Suppose two compact geometric sets have separation $d>0$, and each is perturbed by at most
$\varepsilon$ in Hausdorff distance. The triangle inequality gives

$$
\operatorname{dist}(\widehat A,\widehat B)\ge d-2\varepsilon.
$$

Thus $d>2\varepsilon$ suffices to keep this pair disjoint. It does not certify the topology of an
entire floor. At an intended junction $d=0$, independent endpoint estimates can disconnect the
walls; snapping nearby endpoints can instead close a real opening. Junction resolution and
validation are necessary after interpreting raster evidence. Global gap closing has no general
topology-preservation guarantee.
