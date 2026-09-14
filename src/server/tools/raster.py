"""Local, bounded floor-plan evidence extraction. No metric guesses or model mutations.

OpenCV LSD finds stroke faces; cross-sectional ink tests propose filled or double-line
walls. No morphological closing: a missing doorway must stay missing. All scores are
heuristics. This deliberately does not claim door, room or junction topology.
"""
import csv
import io
import json
import math
import subprocess
import sys

try:
    import cv2
    import numpy as np
except ImportError:
    sys.exit("OpenCV/numpy are unavailable. Use the API Docker image or install python3-opencv.")


def main():
    source, output, profile, ocr, symbol_json = sys.argv[1:]
    cv2.setNumThreads(1)
    cv2.setRNGSeed(0)
    image = cv2.imread(source, cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("Cannot read analysis image.")
    h, w = image.shape
    if min(w, h) < 16 or max(w, h) > 2400 or w * h > 5760000:
        raise ValueError("Use an analysis region from 16 to 2400 pixels per side.")
    warnings = ["Detection scores are heuristics, not probabilities. Confirm walls/outline and scale before constructing geometry."]
    candidates = []

    def add(kind, path, evidence, **extra):
        coords = [p[i:i + 2] for p in path for i in range(1, len(p), 2)]
        c = dict(id="r-%s-%d" % (kind, len(candidates)), kind=kind, path=path,
                 bounds=[min(p[0] for p in coords), min(p[1] for p in coords),
                         max(p[0] for p in coords), max(p[1] for p in coords)], evidence=evidence, **extra)
        candidates.append(c)
        return c["id"]

    if profile == 'scan':
        gray = cv2.medianBlur(image, 3)
        # Suppress low-contrast paper texture, retaining localized faint lines.
        local = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 12)
        mask = cv2.bitwise_or(cv2.bitwise_and(local, cv2.inRange(gray, 0, 210)), cv2.inRange(gray, 0, 100))
    else:
        _, mask = cv2.threshold(image, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    symbol = json.loads(symbol_json)
    if symbol:
        region, box = symbol['region'], symbol['bounds']
        if box[0] < region[0] or box[1] < region[1] or box[2] > region[2] or box[3] > region[3]:
            raise ValueError('Symbol exemplar must be inside the analysed source region.')
        x0, x1 = [int(round((x - region[0]) * w / (region[2] - region[0]))) for x in (box[0], box[2])]
        y0, y1 = [int(round((y - region[1]) * h / (region[3] - region[1]))) for y in (box[1], box[3])]
        tw, th = x1 - x0, y1 - y0
        if min(tw, th) < 16 or max(tw, th) > 400 or tw * th > w * h * .15:
            raise ValueError('Choose a tight symbol exemplar between 16 and 400 analysis pixels per side, under 15% of the region.')
        template = 255 - image[y0:y1, x0:x1]
        if template.std() < 12 or (template > 100).mean() < .02:
            raise ValueError('The exemplar has too little contrast/ink for reliable symbol matching.')
        rectangle = lambda x, y, ww, hh: [['M', x, y], ['L', x + ww, y], ['L', x + ww, y + hh], ['L', x, y + hh], ['Z']]
        exemplar = add('image-region', rectangle(x0, y0, tw, th), 'Caller-selected symbol exemplar; label is an interpretation.',
                       text=symbol['label'], layer='symbol-exemplar', stroke='#a21caf')
        hits = []
        target = 255 - image
        for mirrored in (False, True):
            for turn in range(4):
                oriented = np.rot90(np.fliplr(template) if mirrored else template, -turn)
                for scale in (.9, 1, 1.1):
                    sample = cv2.resize(np.ascontiguousarray(oriented), None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
                    sh, sw = sample.shape
                    if sh >= h or sw >= w:
                        continue
                    scores = cv2.matchTemplate(target, sample, cv2.TM_CCOEFF_NORMED)
                    maxima = cv2.dilate(scores, np.ones((9, 9), np.uint8))
                    ys, xs = np.where((scores >= .72) & (scores >= maxima))
                    best = sorted(zip(ys, xs), key=lambda p: -scores[p[0], p[1]])[:100]
                    hits.extend((float(scores[y, x]), int(x), int(y), sw, sh, turn * 90, mirrored, scale) for y, x in best)

        def overlaps(a, b):
            x, y, ww, hh = a
            xx, yy, w2, h2 = b
            intersection = max(0, min(x + ww, xx + w2) - max(x, xx)) * max(0, min(y + hh, yy + h2) - max(y, yy))
            return intersection / max(1, min(ww * hh, w2 * h2)) > .35

        kept = [(x0, y0, tw, th)]  # Do not count the exemplar itself as a discovery.
        for score, x, y, sw, sh, rotation, mirror, scale in sorted(hits, key=lambda v: (-v[0], v[2], v[1])):
            if any(overlaps((x, y, sw, sh), b) for b in kept):
                continue
            kept.append((x, y, sw, sh))
            add('symbol', rectangle(x, y, sw, sh),
                'Template correlation; rotation %d degrees clockwise in raster frame, mirror %s, scale %.1f.' % (rotation, mirror, scale),
                text=symbol['label'], score=round(min(1, score), 3), evidenceIds=[exemplar], layer='symbol-candidates', stroke='#a21caf',
                uncertainty='Visual match only. Confirm symbol meaning, host wall and opening direction; no geometry or portal was created.')
            if len(kept) > 40:
                warnings.append('Symbol matches limited to 40; focus the analysis region for more.')
                break
        warnings.append('Symbol search tests quarter-turn rotations, mirrors and scales 0.9/1/1.1 only. Different drawing conventions and oblique symbols can be missed.')

    if ocr == 'ocr':
        try:
            langs = subprocess.run(['tesseract', '--list-langs'], capture_output=True, text=True, timeout=5, check=True).stdout.splitlines()
            selected = [lang for lang in ('fin', 'eng', 'swe') if lang in langs]
            if len(selected) != 3:
                raise ValueError("Install Tesseract eng, fin and swe language data, or request ocr:false.")
            process = subprocess.run(['tesseract', source, 'stdout', '-l', '+'.join(selected), '--psm', '11', 'tsv'],
                                     capture_output=True, text=True, timeout=25, check=True)
        except FileNotFoundError:
            raise ValueError("Tesseract is unavailable. Use the API Docker image or request ocr:false for geometry only.")
        if len(process.stdout) > 4 * 1024 * 1024:
            raise ValueError("OCR output is too large; analyse a smaller region.")
        words = list(csv.DictReader(io.StringIO(process.stdout), delimiter='\t', quoting=csv.QUOTE_NONE))
        # Drawing strokes can be confidently misread as giant letters. Derive a page's
        # typical word height from plausible high-confidence boxes, not from the sheet size.
        heights = [int(row['height']) for row in words if row['level'] == '5' and float(row['conf']) >= 70
                   and any(c.isalnum() for c in row.get('text', '')) and 4 <= int(row['height']) < h * .08
                   and int(row['width']) < max(1, len(row.get('text', ''))) * int(row['height']) * 2]
        typical_height = float(np.median(heights)) if heights else h * .025
        rejected_words = 0
        for row in words:
            text = row.get('text', '').strip()
            if row['level'] != '5' or not text or not any(c.isalnum() for c in text) or float(row['conf']) < 50:
                continue
            x, y, tw, th = (int(row[k]) for k in ('left', 'top', 'width', 'height'))
            if tw > w * .7 or th > min(h * .15, max(12, typical_height * 2.5)) or th < 4 or tw > len(text) * th * 2:
                rejected_words += 1
                continue
            # Never erase an intact drawing rule merely because OCR called it a word.
            # A normal glyph can fill a column; only reject rules longer than text height.
            roi = mask[max(0, y - 1):min(h, y + th + 1), max(0, x - 1):min(w, x + tw + 1)]
            if ((th > typical_height * 2 and (roi > 0).mean(axis=0).max() > .95)
                    or (tw > typical_height * 2.5 and (roi > 0).mean(axis=1).max() > .95)):
                rejected_words += 1
                continue
            add('label', [['M', x, y], ['L', x + tw, y], ['L', x + tw, y + th], ['L', x, y + th], ['Z']],
                'Tesseract word box; read labels/dimensions as evidence, never as automatic scale.',
                text=text[:200], strokeWidth=th, score=round(float(row['conf']) / 100, 3), layer='labels',
                uncertainty='OCR may misread letters, decimal separators or units.')
            # Only plausible confident word boxes are masked; unknown text remains uncertain.
            mask[max(0, y - 1):min(h, y + th + 1), max(0, x - 1):min(w, x + tw + 1)] = 0
            if len(candidates) >= 1000:
                warnings.append('OCR labels limited to 1000; use a smaller region for the rest.')
                break
        if rejected_words:
            warnings.append('%d implausible OCR boxes omitted; their drawing strokes were retained. Some genuine large labels may also be omitted.' % rejected_words)
    else:
        warnings.append('OCR disabled: text and dimension strokes may remain among line candidates.')

    # Pixel centres are converted to source pixel-edge coordinates (+0.5) at the boundary.
    found = cv2.createLineSegmentDetector(cv2.LSD_REFINE_STD).detect(mask)[0]
    lines = []
    minimum = max(18, min(w, h) * .025)
    for row in ([] if found is None else found):
        a, b = row[0][:2].astype(float) + .5, row[0][2:].astype(float) + .5
        if tuple(a) > tuple(b):
            a, b = b, a
        length = float(np.linalg.norm(b - a))
        if length >= minimum:
            lines.append((a, b, length))
    lines.sort(key=lambda l: (-round(l[2], 1), *l[0], *l[1]))
    if len(lines) > 1000:
        warnings.append('Line evidence limited to 1000 longest segments. Analyse a smaller region for detail.')
    lines = lines[:1000]
    ids = []
    for a, b, length in lines:
        ids.append(add('path', [['M', *np.round(a, 3)], ['L', *np.round(b, 3)]],
                       'OpenCV line-segment detector: image stroke face.', layer='wall-faces', stroke='#a0a7b4',
                       uncertainty='May be a wall face, annotation, furniture or border; not a centreline.'))

    def occupancy(points):
        xy = np.floor(points).astype(int)
        valid = (xy[:, 0] >= 0) & (xy[:, 0] < w) & (xy[:, 1] >= 0) & (xy[:, 1] < h)
        values = np.zeros(len(points), dtype=float)
        values[valid] = mask[xy[valid, 1], xy[valid, 0]] / 255
        return values

    proposals = []
    max_thickness = max(8, min(w, h) * .035)
    for i, (a, b, length) in enumerate(lines):
        u = (b - a) / length
        n = np.array([-u[1], u[0]])
        for j in range(i + 1, len(lines)):
            c, d, other = lines[j]
            v = (d - c) / other
            if abs(float(np.dot(u, v))) < math.cos(math.radians(1.5)):
                continue
            distances = np.array([np.dot(c - a, n), np.dot(d - a, n)])
            separation = abs(float(distances.mean()))
            if separation < max(3.5, min(w, h) * .004) or separation > max_thickness or abs(distances[0] - distances[1]) > 2:
                continue
            lo, hi = sorted([float(np.dot(c - a, u)), float(np.dot(d - a, u))])
            lo, hi = max(2, lo + 2), min(length - 2, hi - 2)
            if hi - lo < max(minimum, min(length, other) * .65):
                continue
            normal = n if distances.mean() > 0 else -n
            samples = a + np.linspace(lo, hi, min(150, max(12, int(hi - lo))))[:, None] * u
            interior = np.mean([occupancy(samples + normal * separation * f) for f in (.2, .4, .6, .8)])
            outside = np.mean([occupancy(samples - normal * 2), occupancy(samples + normal * (separation + 2))])
            # A majority-filled section includes rasterized hatching/grey infill.
            solid = interior > .6 and outside < .25
            # Hollow pairing spans both thin boundary strokes; the outside must be clear.
            faces = min(np.mean(occupancy(samples + normal * 1.5)), np.mean(occupancy(samples + normal * (separation - 1.5))))
            hollow = separation >= 8 and interior <= .6 and faces > .65 and outside < .2
            if not solid and not hollow:
                continue
            p, q = a + lo * u + normal * separation / 2, a + hi * u + normal * separation / 2
            score = round(float(.9 - outside * .2 if solid else .65 - interior * .2), 3)
            proposals.append((score, hi - lo, i, j, p, q, separation, solid))
    proposals.sort(key=lambda p: (-p[0], -p[1], p[2], p[3]))
    accepted = []
    used = {}
    for score, length, i, j, a, b, thickness, solid in proposals:
        # One long face can support several disjoint segments, for example on the
        # uninterrupted side of a T junction. Reusing its occupied part is forbidden.
        spans = []
        for index in (i, j):
            origin, end, face_length = lines[index]
            direction = (end - origin) / face_length
            spans.append(tuple(sorted((float(np.dot(a - origin, direction)), float(np.dot(b - origin, direction))))))
        if any(min(hi, old_hi) - max(lo, old_lo) > 3
               for index, (lo, hi) in zip((i, j), spans) for old_lo, old_hi in used.get(index, [])):
            continue
        # Suppress overlapping alternative pairings, never join across empty gaps.
        duplicate = False
        u = (b - a) / length
        for p, q, t in accepted:
            v = q - p
            if abs(float(np.dot(u, v / np.linalg.norm(v)))) < .999:
                continue
            distance = abs(float(u[0] * (p - a)[1] - u[1] * (p - a)[0]))
            lo, hi = sorted([float(np.dot(p - a, u)), float(np.dot(q - a, u))])
            if distance < max(t, thickness) * .6 and min(length, hi) - max(0, lo) > minimum:
                duplicate = True
                break
        if duplicate:
            continue
        for index, span in zip((i, j), spans):
            used.setdefault(index, []).append(span)
        accepted.append((a, b, thickness))
        add('wall', [['M', *np.round(a, 3)], ['L', *np.round(b, 3)]],
            'Paired stroke faces with %s cross-sectional ink support.' % ('filled' if solid else 'double-line'),
            layer='wall-centrelines', stroke='#2563eb', strokeWidth=1, thickness=round(thickness, 3), score=score,
            evidenceIds=[ids[i], ids[j]],
            uncertainty='Proposed centreline only; endpoints need junction resolution. ' +
                        ('Filled furniture/annotations can resemble walls.' if solid else 'Parallel objects may resemble a hollow wall.'))

    contours, hierarchy = cv2.findContours(mask, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    def page_border(contour):
        x, y, cw, ch = cv2.boundingRect(contour)
        return x < w * .025 and y < h * .025 and x + cw > w * .975 and y + ch > h * .975

    # A page frame must not hide the actual exterior contour nested inside it.
    outlines = []
    for index, contour in enumerate(contours):
        parent = hierarchy[0][index][3]
        while parent >= 0 and page_border(contours[parent]):
            parent = hierarchy[0][parent][3]
        if parent == -1:
            outlines.append(contour)
    outlines = sorted(outlines, key=cv2.contourArea, reverse=True)[:32]
    for contour in outlines:
        area = cv2.contourArea(contour)
        x, y, cw, ch = cv2.boundingRect(contour)
        if area < w * h * .03 or area < cw * ch * .25:
            continue
        polygon = cv2.approxPolyDP(contour, max(1, min(w, h) * .0015), True)[:, 0, :]
        if len(polygon) > 128 or len(polygon) < 3:
            continue
        border = page_border(contour)
        path = [['M' if i == 0 else 'L', float(p[0]) + .5, float(p[1]) + .5] for i, p in enumerate(polygon)] + [['Z']]
        add('path' if border else 'outline', path, 'Exterior contour of connected ink; concavities retained.',
            layer='page-border' if border else 'outline-candidates', stroke='#b45309', score=.3 if border else .6,
            uncertainty='Likely page border; do not use as footprint.' if border else 'Confirm this is the building exterior. Internal courtyards/holes are not inferred; open exterior walls can prevent outline detection.')

    hist = np.zeros(90)
    for a, b, _ in (accepted or lines):
        delta = b - a
        degrees = math.degrees(math.atan2(float(delta[1]), float(delta[0]))) % 90
        hist[int(round(degrees)) % 90] += float(np.linalg.norm(delta))
    axes = []
    if hist.sum():
        smooth = sum(np.roll(hist, shift) for shift in (-2, -1, 0, 1, 2))
        peak = int(np.argmax(smooth))
        nearby = [i for i in range(90) if min(abs(i - peak), 90 - abs(i - peak)) <= 2]
        z = sum(hist[i] * np.exp(4j * math.radians(i)) for i in nearby)
        angle = round((math.degrees(math.atan2(z.imag, z.real)) / 4) % 90, 3)
        axes = [dict(degrees=angle, score=round(float(smooth[peak] / hist.sum()), 3)),
                dict(degrees=angle + 90, score=round(float(smooth[peak] / hist.sum()), 3))]
    if not accepted:
        warnings.append('No supported wall pairs found. Inspect line evidence or try a focused region/scan profile; do not invent a scale.')
    if not any(c['kind'] == 'outline' for c in candidates):
        warnings.append('No supported exterior outline found. Use confirmed wall/reference candidates for width or a known length; area calibration needs a closed outline.')
    with open(output, 'w', encoding='utf8') as file:
        json.dump(dict(width=w, height=h, engine='opencv-' + cv2.__version__, mainAxes=axes,
                       candidates=candidates, warnings=warnings), file, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        sys.exit(str(error))
