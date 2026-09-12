import {
  Activity,
  ArrowDownToLine,
  ArrowUpRight,
  BellRing,
  BriefcaseMedical,
  Building2,
  Camera,
  CarFront,
  Container,
  Cpu,
  DoorOpen,
  Fence,
  FireExtinguisher,
  Footprints,
  Grid2X2,
  HeartPulse,
  Info,
  KeyRound,
  LandPlot,
  LogOut,
  MapPin,
  MoveDownRight,
  MoveUpRight,
  Package,
  PanelTop,
  PersonStanding,
  ScanLine,
  ShieldAlert,
  Siren,
  Square,
  SquareDashed,
  SquareDashedBottom,
} from 'lucide-react';
import type { ObjectKind, SiteObject, Tool } from '../model/types';
import { useKerrosTheme } from '../theme';
export function EntityIcon({
  kind,
  size = 17,
  symbol,
  travel,
}: {
  kind: ObjectKind | Tool | 'wall' | 'fence';
  size?: number;
  symbol?: SiteObject['symbol'];
  /** An escalator's direction, so a descending one is not drawn with an arrow pointing up. */
  travel?: SiteObject['travel'];
}) {
  const custom = useKerrosTheme().icons?.[kind === 'poi' && symbol ? symbol : kind];
  if (custom) {
    const Custom = custom;
    return <Custom size={size} />;
  }
  const Icon =
    kind === 'poi'
      ? {
          personnel: PersonStanding,
          service: ArrowDownToLine,
          driveway: CarFront,
          parking: CarFront,
          assembly: Footprints,
          info: Info,
          aed: HeartPulse,
          extinguisher: FireExtinguisher,
          firstaid: BriefcaseMedical,
          exit: LogOut,
          firealarm: BellRing,
        }[symbol ?? 'personnel']
      : ((
          {
            door: DoorOpen,
            window: PanelTop,
            gate: Fence,
            fence: Fence,
            wall: SquareDashed,
            turnstile: ScanLine,
            reader: KeyRound,
            camera: Camera,
            elevator: ArrowUpRight,
            stairs: travel === 'down' ? MoveDownRight : MoveUpRight,
            office: Building2,
            container: Container,
            storage: Package,
            zone: LandPlot,
            room: Grid2X2,
            enclose: SquareDashedBottom,
            building: Building2,
            parcel: LandPlot,
            rectangle: Square,
            sensor: Activity,
            alarm: Siren,
            equipment: Cpu,
            evacuation: ShieldAlert,
          } as Record<string, typeof MapPin>
        )[kind] ?? MapPin);
  return <Icon size={size} strokeWidth={1.75} />;
}
