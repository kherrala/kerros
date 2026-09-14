# Image analysis and calibration

Part of the optional [Mathematical foundations](/guide/geometry-mathematics) series. These arguments explain the model and its limits; they are not a formal verification of Kerros. The implementation uses finite-precision arithmetic, tolerances and regression tests.

## Source coordinates, calibration and uncertainty

Image evidence starts in original source pixels; PDF evidence uses original page coordinates.
Resizing a preview does not change that coordinate frame. For a crop whose source origin is $b$
and whose raster scale factors are $r_x,r_y>0$, a raster pixel centre $(i+1/2,j+1/2)$ maps back to

$$
p=b+\left(\frac{i+1/2}{r_x},\frac{j+1/2}{r_y}\right).
$$

Calibrated source geometry is then mapped to metres by a similarity, allowing an axis reflection:

$$
q=t+sRF(p-o),\qquad s>0,\qquad R^\mathsf{T}R=I,
\qquad F=\begin{pmatrix}1&0\\0&-1\end{pmatrix}.
$$

Here $o$ is a source origin, $t$ a target translation, $R$ a rotation, and $F$ converts a downward
source axis to an upward model axis. For a source already using an upward axis, use $F=I$.

**Proposition — consistent similarity preserves incidence.** This map is bijective and continuous
with continuous inverse. It maps segments to segments, intersections to intersections and connected
sets to connected sets. Lengths scale by $s$, and areas by $s^2$.

**Proof.** The linear part $sRF$ is invertible. Affine maps preserve segment interpolation, and
injectivity gives $f(A\cap B)=f(A)\cap f(B)$. Orthogonality gives
$\|sRFv\|=s\|v\|$; the absolute determinant is $s^2$. Continuity in both directions preserves
connectedness. $\square$

This statement assumes the **same** map is applied to all related geometry before numerical
rounding. It cannot restore a missing wall, identify a doorway or correct a wrongly chosen scale.

For a confirmed source distance $d$ corresponding to real distance $D$, or a confirmed exterior
polygon area $a$ corresponding to real footprint $A$, calibration gives

$$
s=\frac{D}{d},\qquad\text{or}\qquad s=\sqrt{\frac{A}{a}}.
$$

The references must be positive and describe the same feature. A bounding rectangle is not the
area of an L-shaped footprint. Conflicting dimensions cannot be resolved by independently
stretching the axes while still claiming a similarity.

For small measurement errors, first-order relative scale error satisfies

$$
\frac{\Delta s}{s}\approx\frac{\Delta D}{D}-\frac{\Delta d}{d},
\qquad
\frac{\Delta s}{s}\approx\frac12\left(\frac{\Delta A}{A}-\frac{\Delta a}{a}\right)
$$

for length and area calibration respectively. Taking absolute values and adding the two terms
gives a first-order upper estimate. With fixed origins and orientation, source-point error
$\|\Delta p\|\le\varepsilon_p$ and scale error $|\Delta s|\le\varepsilon_s$ give the exact bound

$$
\|\widehat q-q\|\le s\varepsilon_p+
\varepsilon_s\|p-o\|+\varepsilon_s\varepsilon_p.
$$

Expand $(s+\Delta s)(p+\Delta p-o)-s(p-o)$ and apply the triangle inequality to obtain it.
Scale error therefore grows with distance from the chosen origin. Origin and angle errors would
add further terms; centimetre snapping does not remove them.

## Raster detection proposes evidence

For grayscale intensity $I(x)$ and threshold $\tau$, an idealized dark-ink mask is

$$
M_\tau(x)=\mathbf1\{I(x)\le\tau\}.
$$

The clean-image profile uses Otsu thresholding, choosing a threshold that minimizes weighted
within-class intensity variance:

$$
\tau^*\in\operatorname*{arg\,min}_{\tau}
\bigl(\omega_0(\tau)\sigma_0^2(\tau)+\omega_1(\tau)\sigma_1^2(\tau)\bigr).
$$

The scan profile combines a local adaptive threshold with intensity guards. Both optimize or
filter image contrast, not the meaning of a wall. OpenCV documents these methods in its
[thresholding tutorial](https://docs.opencv.org/4.x/d7/d4d/tutorial_py_thresholding.html).

The [OpenCV line-segment detector](https://docs.opencv.org/4.x/db/d73/classcv_1_1LineSegmentDetector.html)
then proposes stroke faces. For approximately parallel faces $a+tu$ and $c+tu$, with unit normal
$n\perp u$, their perpendicular separation and midpoint locus are

$$
w=|(c-a)\cdot n|,\qquad m(t)=\frac{a+c}{2}+tu.
$$

Kerros tests angular agreement, separation, overlap and sampled ink occupancy inside and outside
the pair. An occupancy statistic has the form $\rho=N^{-1}\sum_{k=1}^{N}M_\tau(x_k)$.
Partly filled, hatched and double-line strokes require different support from solid walls.
One long face can support disjoint portions at a T junction; consuming it after the first match
would discard other legitimate portions. The detector retains those portions without joining
across empty gaps.

These thresholds and scores are heuristics. Furniture, dimension lines and wall strokes can have
the same local image pattern. OCR adds similarly uncertain text evidence; its score is not a
calibrated probability that a room name or dimension is correct. Word-box size and shape filters
reject implausible detections but can also omit real labels. Image quality and segmentation affect
recognition, as described in [Tesseract's quality guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html).
Neither OCR numbers nor the minimum-room rule establish real-world scale.

See [topology under small perturbations](./computational-topology#small-displacement-can-change-topology) for why threshold changes and endpoint snapping can alter room connectivity.

## Valid reconstruction is not faithful reconstruction

The import pipeline can be written schematically as

$$
I\xrightarrow{D_\theta}C\xrightarrow{\Phi}\mathcal E,
\qquad P_{k+1}=T(P_k,e_k),\quad e_k\in\mathcal E.
$$

$D_\theta$ extracts source candidates using detection parameters $\theta$; $\Phi$ interprets them
as proposed edits. Interpretation can involve the user, an LLM or deterministic tools. Every
accepted geometry change passes the same transaction gate as a manual edit. Candidate previews
also bind to the project and calibration versions so that stale previews cannot be applied.

The inductive argument in [the related argument](/academic/validation#transactions-and-the-scope-of-the-guarantee) is independent of who proposed the edit. It proves closure under
validation, not correspondence with the source. A perfectly valid rectangle at half the intended
scale can describe the wrong building. A valid plan with a missing doorway can have the wrong
navigation graph.

Evaluation must therefore separate model acceptance from source accuracy. With manually annotated
reference features and an explicit matching tolerance, wall detection can report

$$
\operatorname{precision}=\frac{TP}{TP+FP},\qquad
\operatorname{recall}=\frac{TP}{TP+FN},
$$

when the denominators are nonzero. Endpoint displacement, thickness error, OCR transcription error
and missing or spurious adjacencies measure different failures. More detected segments alone do
not establish better accuracy. Offline synthetic and real-drawing regressions supply practical
evidence; they are not a proof that arbitrary architectural drawings will be reconstructed correctly.
