import { barrierEnds, rectangle, segmentProjection } from '../../src/model/geometry';
import { createObject } from '../../src/model/factory';
import type { Point, ProjectDocument, Ring } from '../../src/model/types';
import { box, FloorProgramme, wing, type Programme, type Use } from './stockmannPlanning';

interface Department extends Programme {
  span: number;
  depth: number;
}
interface FloorPlan {
  west: Department[];
  east: Department[];
  centre: string[];
  spine: number;
  width: number;
}
const retail = (name: string, span: number, depth: number, use: Use = 'retail', enclosed = false): Department => ({
  name,
  span,
  depth,
  use,
  enclosed,
});
const office = (name: string, span: number, depth: number, use: Use = 'office', enclosed = false): Department => ({
  name,
  span,
  depth,
  use,
  enclosed,
});

// Each storey has a programme and its own bay rhythm. The facade establishes the two wing axes;
// corridors and lift/escalator approaches are reserved before a single department is placed.
const PLANS: Record<string, FloorPlan> = {
  'floor-basement': {
    west: [
      retail('Fresh produce', 23, 13),
      retail('Bakery', 16, 10),
      retail('Deli & sushi', 22, 13),
      retail('Market café', 17, 11, 'lounge'),
      retail('Wine & beverages', 22, 15),
    ],
    east: [
      retail('Goods receiving', 18, 12, 'service', true),
      retail('Cold store', 13, 10, 'service', true),
      retail('Food preparation', 17, 12, 'service', true),
      retail('Dairy & frozen', 24, 14),
      retail('Pantry & groceries', 28, 13),
    ],
    centre: ['Market hall', 'Checkout court', 'Seasonal food', 'Household essentials'],
    spine: -1,
    width: 4.5,
  },
  'floor-b1': {
    west: [
      retail('Home electronics', 30, 15),
      retail('Phones & computing', 24, 12),
      retail('Pet supplies', 24, 13),
      retail('Customer collection', 22, 11, 'service', true),
    ],
    east: [
      retail('Repairs workshop', 16, 10, 'service', true),
      retail('Technical service', 15, 12, 'service', true),
      retail('Audio showroom', 24, 14),
      retail('Gaming & cameras', 25, 11),
      retail('Returns desk', 20, 13),
    ],
    centre: ['Product demonstrations', 'Click & collect', 'Smart home', 'Service lounge'],
    spine: 1,
    width: 4,
  },
  'floor-ground': {
    west: [
      retail('Fragrances', 27, 12),
      retail('Skincare', 25, 14),
      retail('Makeup studio', 18, 11),
      retail('Watches & jewellery', 30, 15),
    ],
    east: [
      retail('Personal shopping', 18, 11, 'lounge', true),
      retail('Beauty treatments', 14, 10, 'service', true),
      retail('Accessories', 30, 14),
      retail('Luxury boutiques', 25, 12),
      retail('Gift wrapping', 13, 10, 'service', true),
    ],
    centre: ['Beauty atrium', 'Seasonal gifts', 'Consultation lounge', 'New collections'],
    spine: -2,
    width: 5,
  },
  'floor-01': {
    west: [
      retail('Designer collections', 32, 16),
      retail('Knitwear', 23, 12),
      retail('Occasionwear', 24, 15),
      retail('Fitting salon', 21, 10, 'service', true),
    ],
    east: [
      retail('Lingerie', 24, 11),
      retail('Contemporary fashion', 34, 15),
      retail('Studio collections', 27, 13),
      retail('Alterations', 15, 10, 'service', true),
    ],
    centre: ['Capsule collections', 'Denim studio', 'Personal styling', 'Fashion lounge'],
    spine: 2,
    width: 4,
  },
  'floor-02': {
    west: [
      retail('Tailoring & suits', 30, 14),
      retail('Shirts', 20, 12),
      retail('Casual menswear', 30, 15),
      retail('Tailor workshop', 20, 10, 'service', true),
    ],
    east: [
      retail('Mens shoes', 30, 13),
      retail('Denim', 28, 16),
      retail('Sportswear', 25, 12),
      retail('Fitting rooms', 17, 10, 'service', true),
    ],
    centre: ['New-season menswear', 'Accessories studio', 'Style consultation', 'Lounge & collection'],
    spine: -3,
    width: 4.2,
  },
  'floor-03': {
    west: [
      retail('Footwear gallery', 35, 15),
      retail('Handbags', 25, 12),
      retail('Travel luggage', 25, 14),
      retail('Leather care', 15, 9, 'service', true),
    ],
    east: [
      retail('Sunglasses', 20, 11),
      retail('Designer accessories', 30, 14),
      retail('Comfort footwear', 30, 13),
      retail('Stock & collection', 20, 10, 'service', true),
    ],
    centre: ['Shoe fitting lounge', 'Seasonal accessories', 'Travel shop', 'Brand gallery'],
    spine: 3,
    width: 4.5,
  },
  'floor-04': {
    west: [
      retail('Toys & discovery', 30, 16),
      retail('Baby & nursery', 28, 13),
      retail('Junior fashion', 26, 12),
      retail('Family room', 16, 10, 'lounge', true),
    ],
    east: [
      retail('Outdoor equipment', 30, 15),
      retail('Sport & fitness', 28, 13),
      retail('Junior denim', 25, 14),
      retail('Equipment service', 17, 10, 'service', true),
    ],
    centre: ['Play & demonstration', 'School essentials', 'Activewear studio', 'Family lounge'],
    spine: -1.5,
    width: 4.8,
  },
  'floor-05': {
    west: [
      retail('Living room settings', 35, 16),
      retail('Bedroom showroom', 30, 14),
      retail('Interior consultation', 17, 11, 'lounge', true),
      retail('Order collection', 18, 10, 'service', true),
    ],
    east: [
      retail('Kitchen & dining', 30, 15),
      retail('Lighting gallery', 25, 12),
      retail('Home textiles', 30, 14),
      retail('Design studio', 15, 10, 'meeting', true),
    ],
    centre: ['Home showroom', 'Tableware', 'Seasonal living', 'Material library'],
    spine: 1.5,
    width: 4.5,
  },
  'floor-06': {
    west: [
      retail('Academic bookstore', 34, 15),
      retail('Reading room', 24, 12, 'lounge'),
      retail('Author events', 24, 15, 'meeting', true),
      retail('Book collection', 18, 10, 'service', true),
    ],
    east: [
      retail('Restaurant dining', 33, 16, 'lounge'),
      retail('Restaurant kitchen', 20, 12, 'service', true),
      retail('Café', 27, 14, 'lounge'),
      retail('Private dining', 20, 11, 'meeting', true),
    ],
    centre: ['Events forum', 'Books & gifts', 'Restaurant foyer', 'Reading lounge'],
    spine: 0,
    width: 5,
  },
  'floor-07': {
    west: [
      office('Buying team · fashion', 28, 14),
      office('Sample review', 16, 10, 'meeting', true),
      office('Buying team · home', 28, 14),
      office('Supplier meeting', 12, 9, 'meeting', true),
      office('Team kitchen', 16, 11, 'lounge', true),
    ],
    east: [
      office('Finance & planning', 26, 13),
      office('Budget meeting', 13, 9, 'meeting', true),
      office('Operations', 27, 15),
      office('Administration', 22, 12),
      office('Records', 12, 9, 'service', true),
    ],
    centre: ['Project workspace', 'Materials library', 'Collaboration studio', 'Staff commons'],
    spine: -2,
    width: 3.2,
  },
  'floor-08': {
    west: [
      office('Creative studio', 32, 15),
      office('Campaign workshop', 20, 12, 'meeting', true),
      office('Brand & communications', 30, 14),
      office('Interview suite', 18, 10, 'meeting', true),
    ],
    east: [
      office('Digital marketing', 28, 14),
      office('Content review', 15, 10, 'meeting', true),
      office('People & culture', 25, 13),
      office('Training room', 20, 12, 'meeting', true),
      office('Wellbeing room', 12, 9, 'lounge', true),
    ],
    centre: ['Design collaboration', 'Media library', 'Learning commons', 'Staff lounge'],
    spine: 2.5,
    width: 3.5,
  },
  'floor-09': {
    west: [
      office('F8 lounge', 30, 16, 'lounge'),
      office('Boardroom', 24, 13, 'meeting', true),
      office('Leadership offices', 22, 12, 'office', true),
      office('Guest lounge', 24, 14, 'lounge'),
    ],
    east: [
      office('Management team', 27, 14),
      office('Conference suite', 25, 13, 'meeting', true),
      office('Private dining', 24, 15, 'lounge', true),
      office('Executive support', 24, 11),
    ],
    centre: ['Executive reception', 'Strategy studio', 'Guest conference foyer', 'F8 event space'],
    spine: 0.5,
    width: 4,
  },
};

function lobbyDoor(p: ProjectDocument, floorId: string, at: Point, name: string) {
  const wall = p.barriers.find(
    b => b.floorId === floorId && segmentProjection(at, ...barrierEnds(p, b)).distance < 0.01,
  );
  if (!wall) throw new Error(`No core wall at ${at}`);
  const hit = segmentProjection(at, ...barrierEnds(p, wall));
  if (
    p.objects.some(o => o.barrierId === wall.id && Math.abs((o.offset ?? 0) - hit.t * hit.length) < (o.width + 1.8) / 2)
  )
    return;
  const o = createObject('door', hit.point, floorId, name);
  Object.assign(o, { barrierId: wall.id, offset: hit.t * hit.length, width: 1.8, doorType: 'double' });
  p.objects.push(o);
}

export function stockmannFitout(p: ProjectDocument, floorId: string, outline: Ring, holes: Ring[], shafts: Ring[]) {
  const plan = PLANS[floorId];
  if (!plan) throw new Error(`No floor programme for ${floorId}`);
  const isOffice = ['floor-07', 'floor-08', 'floor-09'].includes(floorId);
  const f = new FloorProgramme(p, floorId, [outline, ...holes], isOffice ? 'carpet' : 'terrazzo');
  f.claim({ name: 'East washrooms', use: 'service', enclosed: true }, box(26, -2, 31, 5));
  f.claim({ name: 'West washrooms', use: 'service', enclosed: true }, box(-37, -6, -32, -1));
  f.claim({ name: 'East lift & stair lobby', use: 'circulation' }, box(20, -4, 31, 17));
  f.claim({ name: 'West lift & stair lobby', use: 'circulation' }, box(-37, -14, -27, -1));
  lobbyDoor(p, floorId, [20, 3], 'East lobby gallery doors');
  lobbyDoor(p, floorId, [-27, -9], 'West lobby gallery doors');
  f.claim({ name: 'East lift approach', use: 'circulation' }, box(17, -7, 34, 20), 0, 1);
  f.claim({ name: 'West lift approach', use: 'circulation' }, box(-40, -17, -24, 2), 0, 1);
  for (const ring of shafts) f.claim({ name: 'Vertical circulation landing', use: 'circulation' }, ring, 0, 1);
  f.claim({ name: 'South escalator hall', use: 'circulation' }, box(1.5, -27, 20, -8), 0, 1);
  f.claim({ name: 'North escalator hall', use: 'circulation' }, box(1.5, 16, 20, 35), 0, 1);
  if (!holes.length)
    f.claim({ name: plan.centre[0], use: floorId === 'floor-ground' ? 'retail' : 'lounge' }, box(-9, -9, 17, 17));
  f.claim({ name: 'Atrium promenade', use: 'circulation' }, box(-13.5, -13.5, 20, 21), 0, 1);

  const west = wing([-51.6, 2.5], [34.6, 64.6]),
    east = wing([57.2, 40.2], [21.3, -56.7]);
  for (const [basis, departments, title] of [
    [west, plan.west, 'West'],
    [east, plan.east, 'East'],
  ] as const) {
    const depth = Math.max(...departments.map(d => d.depth));
    f.claim(
      { name: `${title} department corridor`, use: 'circulation' },
      basis.band(-2, basis.length + 2, depth, depth + plan.width),
      basis.angle,
      1,
    );
  }
  // Deliberately different diagonals and cross aisles, with broad junctions at the vertical cores.
  f.path(
    'West cross passage',
    [
      [-39, -8],
      [-23, -8],
      [-12, -8],
    ],
    plan.width,
  );
  f.path('North cross passage', [west.at(81, 18), [-3 + plan.spine, 33], [17, 30], east.at(10, 18)], plan.width);
  f.path('South cross passage', [west.at(8, 18), [-16 + plan.spine, -25], [3, -28], east.at(78, 18)], plan.width);
  f.path('East cross passage', [[19, 8], [34, 8], east.at(38, 18)], plan.width);
  if (floorId === 'floor-ground') {
    f.path(
      'Aleksanterinkatu entrance concourse',
      [
        [3, -50],
        [3, -30],
        [6, -23],
      ],
      6,
    );
    f.path(
      'Corner entrance concourse',
      [
        [12, -52],
        [12, -31],
        [11, -23],
      ],
      4.5,
    );
    f.path(
      'Keskuskatu entrance concourse',
      [
        [-35, -22],
        [-27, -19],
        [-24, -9],
      ],
      4.5,
    );
  }
  if (floorId === 'floor-b1')
    f.path(
      'Loading dock passage',
      [
        [-6, 31],
        [-6, 25],
        [3, 25],
      ],
      5,
    );
  for (const [basis, departments] of [
    [west, plan.west],
    [east, plan.east],
  ] as const) {
    let along = 0;
    const total = departments.reduce((sum, d) => sum + d.span, 0);
    for (const [i, spec] of departments.entries()) {
      const end = along + (basis.length * spec.span) / total;
      // A setback at alternate suite entrances makes alcoves instead of a wall of identical boxes.
      const far = Math.max(...departments.map(d => d.depth));
      const chamfer = i % 2 ? 2 : 0;
      const shape: Ring = [
        basis.at(along, 0),
        basis.at(end, 0),
        basis.at(end, far - chamfer),
        basis.at(end - chamfer, far),
        basis.at(along, far),
        basis.at(along, 0),
      ];
      if (isOffice && spec.enclosed) {
        const depth = spec.use === 'meeting' ? 7 : spec.use === 'office' ? 6 : 5.5;
        const count = Math.max(2, Math.ceil((end - along) / 6));
        const bay = (end - along) / count;
        for (let room = 0; room < count; room++) {
          const start = along + bay * room,
            stop = start + bay;
          f.claim(
            { ...spec, name: `${spec.name} ${room + 1}` },
            basis.band(start, stop, far - depth, far),
            basis.angle,
            12,
          );
        }
        f.claim({ name: `${spec.name} breakout`, use: 'lounge' }, shape, basis.angle, 12);
      } else f.claim(spec, shape, basis.angle, 20);
      along = end;
    }
  }
  const centralUse: Use = isOffice ? 'office' : 'retail';
  const cells = [box(-55, -55, -14, 5), box(-55, 5, 1, 70), box(20, -60, 60, 8), box(20, 8, 60, 70)];
  cells.forEach((cell, i) =>
    f.claim(
      { name: plan.centre[i], use: i === 3 && isOffice ? 'lounge' : centralUse },
      cell,
      i % 2 ? west.angle : east.angle,
      20,
    ),
  );
  f.remainder({
    name: isOffice ? 'Collaboration commons' : 'Open display gallery',
    use: isOffice ? 'lounge' : 'retail',
  });
  f.finish();
}

export function stockmannMezzanine(p: ProjectDocument, floorId: string, outline: Ring, hole: Ring) {
  const pharmacy = floorId === 'floor-b1a';
  const f = new FloorProgramme(p, floorId, [outline, hole]);
  f.claim({ name: 'Lift lobby', use: 'circulation' }, box(19, -3, 24, 8), 0, 1);
  f.claim({ name: 'South spiral stair landing', use: 'circulation' }, rectangle([16.5, -11], 5.8, 5.8), 0, 1);
  f.claim({ name: 'North spiral stair landing', use: 'circulation' }, rectangle([16.5, 19], 5.8, 5.8), 0, 1);
  f.claim({ name: 'Atrium gallery walk', use: 'circulation' }, box(-12, -12, 20, 20), 0, 1);
  f.claim(
    { name: pharmacy ? 'Pharmacy counter' : 'Café Entresol', use: pharmacy ? 'retail' : 'lounge' },
    box(-16, -16, 8, -12),
  );
  f.claim(
    { name: pharmacy ? 'Prescription collection' : 'Café kitchen', use: 'service', enclosed: true },
    box(8, -16, 24, -12),
  );
  f.claim({ name: pharmacy ? 'Wellness devices' : 'Accessories gallery', use: 'retail' }, box(-16, -12, -12, 10));
  f.claim(
    { name: pharmacy ? 'Consultation room' : 'Gift wrapping', use: 'service', enclosed: true },
    box(-16, 10, -12, 20),
  );
  f.claim({ name: pharmacy ? 'Health & wellbeing' : 'Design accessories', use: 'retail' }, box(-16, 20, 8, 24));
  f.claim(
    { name: pharmacy ? 'Staff dispensary' : 'Café lounge', use: pharmacy ? 'service' : 'lounge', enclosed: pharmacy },
    box(8, 20, 24, 24),
  );
  f.remainder({ name: pharmacy ? 'Wellness display' : 'Gallery seating', use: 'lounge' });
  f.finish();
}
