import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import SeaScene, { type SeaEngine, type SeaTheme } from "@/components/SeaScene";
import type { DuelShip } from "@/game/duel";

/** Visible band of the 1428×2560 sea image: centred on the open water. */
const ASPECT = 2560 / 1428;
const FOCUS = 0.72;
export const SHIP_Y = 0.75;
const SHIP_W = 0.15;

/** Horizontal slot (uv) for ship i standing in spot A(0) / B(1). */
export const slotX = (ship: number, spot: number) => 0.13 + ship * 0.31 + spot * 0.13;

export type SeaGeom = { w: number; h: number; top: number; H: number };
export type BattleSeaApi = {
  /** Point on screen (px, relative to this panel) for a ship slot; lift = fraction of hull height above the waterline. */
  point: (ship: number, spot: number, lift: number) => { x: number; y: number };
  pause: (ms: number) => void;
};

type Props = {
  theme: SeaTheme;
  ships: DuelShip[];
  hull: string;
  /** Enemy sea is mirrored so their bows face ours. */
  mirrored?: boolean;
  stormy?: boolean;
  children?: (geom: SeaGeom, point: BattleSeaApi["point"]) => ReactNode;
};

export const BattleSea = forwardRef<BattleSeaApi, Props>(function BattleSea({ theme, ships, hull, mirrored, stormy, children }, ref) {
  const box = useRef<HTMLDivElement>(null);
  const eng = useRef<SeaEngine | null>(null);
  const [geom, setGeom] = useState<SeaGeom>({ w: 400, h: 300, top: 0, H: 700 });
  const xs = useRef<number[]>([]);
  const shipsRef = useRef(ships);
  shipsRef.current = ships;
  const pausedUntil = useRef(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = box.current!;
    const apply = () => {
      const w = el.clientWidth, h = el.clientHeight, H = w * ASPECT;
      setGeom({ w, h, H, top: h / 2 - FOCUS * H });
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Glide hulls between spots and feed them into the water every frame.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const list = shipsRef.current;
      const out = list.map((s, i) => {
        const target = slotX(i, s.spot);
        const cur = xs.current[i] ?? target;
        const next = Date.now() < pausedUntil.current ? cur : cur + (target - cur) * 0.08;
        xs.current[i] = next;
        return { id: `s${i}`, src: hull, x: next, y: SHIP_Y, width: SHIP_W, waterline: 0.86, visible: s.alive };
      });
      eng.current?.setShips(out);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hull]);

  const point: BattleSeaApi["point"] = (ship, spot, lift) => {
    const ux = xs.current[ship] !== undefined && spot === shipsRef.current[ship]?.spot ? xs.current[ship]! : slotX(ship, spot);
    const sx = (mirrored ? 1 - ux : ux) * geom.w;
    const hullH = SHIP_W * geom.w * 0.55;
    return { x: sx, y: geom.top + SHIP_Y * geom.H - lift * hullH };
  };

  useImperativeHandle(ref, () => ({
    point,
    pause: (ms) => {
      pausedUntil.current = Date.now() + ms;
      setPaused(true);
      window.setTimeout(() => { if (Date.now() >= pausedUntil.current) setPaused(false); }, ms + 10);
    },
  }));

  const params = stormy ? { amp: 1.6, spd: 1.4, foam: 1.2, rip: 1.5, ref: 1.3, paused } : { paused };

  return (
    <div ref={box} className="bt-sea">
      <div className="bt-sea-canvas" style={{ top: geom.top, height: geom.H, transform: mirrored ? "scaleX(-1)" : undefined }}>
        <SeaScene theme={theme} params={params} onEngine={(e) => (eng.current = e)} style={{ aspectRatio: "auto", height: "100%" }} />
      </div>
      {children?.(geom, point)}
    </div>
  );
});
