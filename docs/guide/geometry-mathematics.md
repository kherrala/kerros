# Mathematical foundations

This optional series develops the academic background of Kerros geometry, topology, validation and image import. The practical [geometry guide](./geometry) and [import guide](./ai-import) do not require these derivations.

| Topic | Questions covered |
| --- | --- |
| [Graph theory](/academic/graph-theory) | Embedded graphs, shared directed boundaries, face traversal, Euler’s formula and shortest paths |
| [Computational topology](/academic/computational-topology) | Jordan separation, holes, wall subtraction, connectivity and stability under perturbations |
| [Geometric computation](/academic/geometric-computation) | Area formulas, robust predicates, rounding error, mitred joins and constrained snapping |
| [Geometry and topology validation](/academic/validation) | Transaction invariants, implemented checks, opening intervals, hierarchy cycles and reachability |
| [Image analysis and calibration](/academic/image-analysis) | Coordinate transforms, scale uncertainty, thresholding, wall/OCR evidence and reconstruction accuracy |

The proof sketches state assumptions about an ideal mathematical model. They are not a formal verification of the code. The implementation uses finite-precision coordinates, numerical tolerances and validation, supported by regression and randomized tests.

Three distinctions run through the series: geometric position differs from topological incidence; passing the implemented validator differs from satisfying every possible building constraint; and a valid reconstruction can still misinterpret its source drawing.
