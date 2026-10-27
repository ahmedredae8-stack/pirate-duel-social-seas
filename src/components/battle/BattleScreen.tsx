import { useEffect, useMemo, useRef, useState } from "react";
import { Bot, Crosshair, Move, Shield, Swords, X } from "lucide-react";

import { CaptainAvatar } from "@/components/GameSprite";
import ShieldOverlay, { type ShieldState } from "@/shields/ShieldOverlay";
import WeaponsLayer, { type WeaponsApi } from "@/fx/weapons/WeaponsLayer";
import { playFireEvent, type PlayCtx } from "@/fx/weapons/playFireEvent";
import { BattleSea, type BattleSeaApi } from "@/components/battle/BattleSea";
import { CFG, SHIELDS, WEAPONS, aiChoose, attackerOf, mulberry, newState, resolveRound, validate, type Choice, type DuelEvent, type DuelState, type Side } from "@/game/duel";
import { fleetCatalog } from "@/lib/fleetCatalog";
import { SEA_WORLDS, loadSeaWorldId, getSeaWorld } from "@/lib/seaWorld";
import { playSfx } from "@/lib/sound";
import type { Player } from "@/lib/player";

/** Standard war loadout until owned weapons are recorded per ship. Same for both captains: fair duels. */
export const LOADOUT = {
  ships: [
    { weapons: ["cannon", "mortar"], spot: 0 },
    { weapons: ["cannon", "missile"], spot: 1 },
    { weapons: ["cannon", "torpedo"], spot: 0 },
  ],
  shields: [1, 2, 3],
};

export const powerOf = (p: Pick<Player, "score">) => 1000 + (p.score ?? 0);

const hashSeed = (s: string) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const worldFor = (p: Player) => SEA_WORLDS[hashSeed(p.id) % SEA_WORLDS.length]!;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Float = { id: number; side: Side; ship: number; text: string; tone: "dmg" | "block" | "miss" | "info" };
type ShieldFx = Record<string, { state: ShieldState; trig: number }>;

export function BattleScreen({ me, foe, onClose }: { me: Player; foe: Player; onClose: () => void }) {
  const seed = useMemo(() => hashSeed(`${me.id}|${foe.id}|${Date.now()}`), [me.id, foe.id]);
  const first: Side = seed % 2 === 0 ? "a" : "b";
  const [stage, setStage] = useState<"vs" | "arena">("vs");
  return stage === "vs"
    ? <VsScreen me={me} foe={foe} first={first} onGo={() => setStage("arena")} onClose={onClose} />
    : <Arena me={me} foe={foe} first={first} seed={seed} onClose={onClose} />;
}

/* ── Face-off: both captains, compass decides who strikes first, 10s countdown ── */
function VsScreen({ me, foe, first, onGo, onClose }: { me: Player; foe: Player; first: Side; onGo: () => void; onClose: () => void }) {
  const [n, setN] = useState(10);
  const decided = n <= 7;
  useEffect(() => { playSfx("click", 0.8); }, []);
  useEffect(() => {
    if (n <= 0) { onGo(); return; }
    const t = window.setTimeout(() => { setN((v) => v - 1); playSfx("hover", 0.5); }, 1000);
    return () => window.clearTimeout(t);
  }, [n, onGo]);
  return (
    <div className="bt-root bt-vs" dir="rtl" role="dialog" aria-label="بدء المعركة">
      <button type="button" className="tos-x bt-close" aria-label="انسحاب" onClick={onClose}><X className="h-4 w-4" /></button>
      <p className="bt-kicker">نداء الحرب</p>
      <div className="bt-vs-row">
        <VsCard p={me} label="أنت" starts={decided && first === "a"} />
        <div className="bt-vs-mid">
          <div className={`bt-compass ${decided ? `bt-compass-${first}` : "bt-compass-spin"}`} aria-hidden="true"><span /></div>
          <strong className="bt-vs-word">VS</strong>
        </div>
        <VsCard p={foe} label="الخصم" starts={decided && first === "b"} />
      </div>
      <p className="bt-first" aria-live="polite">{decided ? `الضربة الأولى: ${first === "a" ? me.name : foe.name}` : "البوصلة تختار صاحب الضربة الأولى…"}</p>
      <div className="bt-count" key={n}>{n}</div>
      <button type="button" className="tos-btn" onClick={onGo}>إلى الساحة الآن</button>
    </div>
  );
}

function VsCard({ p, label, starts }: { p: Player; label: string; starts: boolean }) {
  return (
    <div className={starts ? "bt-vs-card on" : "bt-vs-card"}>
      <CaptainAvatar seed={p.avatar_index ?? 0} url={p.avatar_url} className="bt-vs-photo" />
      <small>{label}</small>
      <strong>{p.name}</strong>
      <span><Swords className="h-3.5 w-3.5" /> {powerOf(p).toLocaleString("ar")}</span>
      {starts && <em>يبدأ الهجوم</em>}
    </div>
  );
}

/* ── The arena: enemy sea on top, ours below, simultaneous secret orders ── */
function Arena({ me, foe, first, seed, onClose }: { me: Player; foe: Player; first: Side; seed: number; onClose: () => void }) {
  const rnd = useRef(mulberry(seed)).current;
  const [state, setState] = useState<DuelState>(() => newState({ first, a: LOADOUT, b: LOADOUT }));
  const [view, setView] = useState<DuelState>(state);
  const [phase, setPhase] = useState<"decide" | "play" | "over">("decide");
  const [timer, setTimer] = useState(CFG.decideSeconds);
  const [pick, setPick] = useState<{ ship?: number | undefined; weapon?: string | undefined; mode: "attack" | "shield" | "move" | "pass"; target?: { ship: number; spot: number } | undefined; tier?: number | undefined }>({ mode: "attack" });
  const [floats, setFloats] = useState<Float[]>([]);
  const [shieldFx, setShieldFx] = useState<ShieldFx>({});
  const [banner, setBanner] = useState("");
  const [autoNote, setAutoNote] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const seas = useRef<HTMLDivElement>(null);
  const layer = useRef<WeaponsApi>(null);
  const top = useRef<BattleSeaApi>(null);
  const bottom = useRef<BattleSeaApi>(null);
  const topBox = useRef<HTMLDivElement>(null);
  const bottomBox = useRef<HTMLDivElement>(null);
  const fid = useRef(0);

  const myWorld = getSeaWorld(loadSeaWorldId());
  const foeWorld = worldFor(foe);
  const hull = fleetCatalog[0]!.hull;
  const iAttack = attackerOf(state) === "a";

  useEffect(() => { setPick({ mode: iAttack ? "attack" : "pass" }); }, [state.round, iAttack]);

  // Ten seconds to decide; when time runs out the bot captain decides for you.
  useEffect(() => {
    if (phase !== "decide") return;
    if (timer <= 0) { void commit(true); return; }
    const t = window.setTimeout(() => setTimer((v) => v - 1), 1000);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer, phase]);

  const float = (side: Side, ship: number, text: string, tone: Float["tone"]) => {
    const id = ++fid.current;
    setFloats((f) => [...f, { id, side, ship, text, tone }]);
    window.setTimeout(() => setFloats((f) => f.filter((x) => x.id !== id)), 1400);
  };
  const shieldState = (side: Side, ship: number, s: ShieldState) => setShieldFx((m) => ({ ...m, [`${side}${ship}`]: { state: s, trig: (m[`${side}${ship}`]?.trig ?? 0) + 1 } }));
  const patchShip = (side: Side, ship: number, fn: (s: DuelState["a"]["ships"][number]) => void) =>
    setView((v) => { const n = structuredClone(v); fn(n[side].ships[ship]!); return n; });

  const myChoice = (): Choice | null => {
    if (pick.mode === "pass") return iAttack ? null : { type: "pass" };
    if (pick.mode === "move" && pick.ship !== undefined) return { type: "move", ship: pick.ship };
    if (pick.mode === "shield" && pick.ship !== undefined && pick.tier) return { type: "shield", ship: pick.ship, tier: pick.tier };
    if (pick.mode === "attack" && pick.ship !== undefined && pick.weapon && pick.target) return { type: "attack", ship: pick.ship, weapon: pick.weapon, target: pick.target };
    return null;
  };

  const panelOffset = (side: Side) => {
    const r = root.current!.getBoundingClientRect();
    const p = (side === "b" ? topBox : bottomBox).current!.getBoundingClientRect();
    return { x: p.left - r.left, y: p.top - r.top };
  };
  const at = (side: Side, ship: number, spot: number, lift: number) => {
    const api = (side === "b" ? top : bottom).current!;
    const o = panelOffset(side);
    const p = api.point(ship, spot, lift);
    return { x: o.x + p.x, y: o.y + p.y };
  };

  const commit = async (timeout = false, demo = false) => {
    if (phase !== "decide") return;
    let mine = demo ? null : myChoice();
    if (!mine || validate(state, "a", mine)) { mine = aiChoose(state, "a", rnd); setAutoNote(timeout); }
    else setAutoNote(false);
    const theirs = aiChoose(state, "b", rnd);
    setPhase("play");
    setBanner(iAttack ? "أطلِق!" : "استعد للضربة!");
    const out = resolveRound(state, { a: mine, b: theirs });
    await play(out.events, state);
    setState(out.state);
    setView(out.state);
    setBanner("");
    if (out.state.over) { setPhase("over"); return; }
    setTimer(CFG.decideSeconds);
    setPhase("decide");
  };

  const play = async (events: DuelEvent[], before: DuelState) => {
    let spotOf = (side: Side, ship: number) => before[side].ships[ship]!.spot;
    const spots = { a: before.a.ships.map((s) => s.spot), b: before.b.ships.map((s) => s.spot) };
    spotOf = (side, ship) => spots[side][ship]!;
    for (const ev of events) {
      if (ev.t === "burn") { patchShip(ev.side, ev.ship, (s) => { s.hp = Math.max(0, s.hp - ev.dmg); }); float(ev.side, ev.ship, `🔥 −${ev.dmg}`, "dmg"); await wait(500); }
      else if (ev.t === "shield") { patchShip(ev.side, ev.ship, (s) => { s.shield = { tier: ev.tier, hits: SHIELDS[ev.tier]!.hits }; }); shieldState(ev.side, ev.ship, "spawn"); playSfx("click", 0.5); await wait(700); }
      else if (ev.t === "move") { spots[ev.side][ev.ship] = ev.spot; patchShip(ev.side, ev.ship, (s) => { s.spot = ev.spot; }); float(ev.side, ev.ship, "مناورة!", "info"); await wait(800); }
      else if (ev.t === "moveFail") { float(ev.side, ev.ship, `لا تتحرك: ${ev.reason}`, "info"); await wait(600); }
      else if (ev.t === "fire") {
        const ctx: PlayCtx = {
          layer: layer.current!,
          launchPoint: (side, ship, kind) => at(side, ship, spotOf(side, ship), kind === "waterline" ? 0 : 0.8),
          spotCenter: (side, ship, spot) => at(side, ship, spot, 0.45),
          onMissileImpact: (_i, e) => { const h = e.hits[0]; if (h && h.kind !== "miss" && h.kind !== "blocked") float(h.side, h.ship, "−10", "dmg"); },
          onImpact: (e) => {
            for (const h of e.hits) {
              if (h.kind === "blocked") { shieldState(h.side, h.ship, h.reflect ? "reflect" : "hit"); float(h.side, h.ship, "صدّ الدرع!", "block"); }
              else if (h.kind === "miss") float(h.side, h.ship, "طاشت!", "miss");
              else { patchShip(h.side, h.ship, (s) => { s.hp = Math.max(0, s.hp - h.dmg); }); if (e.weapon !== "missile") float(h.side, h.ship, `−${h.dmg}`, "dmg"); }
              if (h.reflect) { const r = h.reflect; patchShip(e.side, r.ship, (s) => { s.hp = Math.max(0, s.hp - r.dmg); }); float(e.side, r.ship, `↩ −${r.dmg}`, "dmg"); }
            }
          },
        };
        firing.current = { side: ev.side, ship: ev.ship };
        await playFireEvent(ev, ctx);
        firing.current = null;
        await wait(250);
      }
      else if (ev.t === "shieldBreak") { shieldState(ev.side, ev.ship, "break"); await wait(600); patchShip(ev.side, ev.ship, (s) => { s.shield = null; }); }
      else if (ev.t === "dead") { patchShip(ev.side, ev.ship, (s) => { s.alive = false; s.hp = 0; }); float(ev.side, ev.ship, "غرقت!", "dmg"); playSfx("click", 0.9); await wait(700); }
    }
  };

  const hooks = {
    onShake: (a: number, ms: number) => root.current?.animate([{ transform: `translate(${a}px,${-a / 2}px)` }, { transform: `translate(${-a}px,${a / 2}px)` }, { transform: "translate(0,0)" }], { duration: ms, easing: "ease-out" }),
    onZoom: (s: number, ms: number) => seas.current?.animate([{ transform: "scale(1)" }, { transform: `scale(${s})` }, { transform: "scale(1)" }], { duration: ms, easing: "ease-out" }),
    onFlash: (a: number, ms: number) => flash.current?.animate([{ opacity: a }, { opacity: 0 }], { duration: ms }),
    onHitStop: (ms: number) => { top.current?.pause(ms); bottom.current?.pause(ms); },
    // Attacker hull is shoved: back for the cannon, down into the water for mortar/missiles.
    onRecoil: (weapon: string) => {
      const f = firing.current; if (!f) return;
      const api = (f.side === "b" ? top : bottom).current;
      if (weapon === "cannon") api?.kick(f.ship, -0.035, 0);
      else if (weapon === "torpedo") api?.kick(f.ship, -0.015, 0.004);
      else api?.kick(f.ship, 0, 0.012);
    },
  };

  const hpSum = (s: DuelState, side: Side) => s[side].ships.reduce((x, y) => x + Math.max(0, y.hp), 0);
  const total = CFG.shipHp * 3;
  const mine = view.a, theirs = view.b;
  const choosingTarget = phase === "decide" && iAttack && pick.mode === "attack" && pick.ship !== undefined && !!pick.weapon;
  const weaponAim = pick.weapon ? WEAPONS[pick.weapon]?.aim : undefined;
  const ready = !!myChoice();

  const overlay = (side: Side) => (_g: unknown, point: BattleSeaApi["point"], hullSize: BattleSeaApi["hullSize"]) => view[side].ships.map((s, i) => {
    const hs = hullSize(i);
    const p = point(i, s.spot, 1.05);
    const fx = shieldFx[`${side}${i}`];
    const base = point(i, s.spot, 0);
    return (
      <div key={i}>
        {s.alive && (
          <div className="bt-hp" style={{ left: p.x, top: p.y }}>
            <i style={{ width: `${(s.hp / s.max) * 100}%` }} />
            <b>{s.hp}</b>
          </div>
        )}
        {s.alive && s.shield && (
          <div className="bt-shield" style={{ left: base.x, top: base.y - hs.h * 0.45, width: hs.w * 1.35, height: hs.h * 2.3 }}>
            <ShieldOverlay tier={s.shield.tier as 1 | 2 | 3 | 4 | 5} state={fx?.state ?? "idle"} trigger={fx?.trig ?? 0} width="100%" />
          </div>
        )}
        {floats.filter((f) => f.side === side && f.ship === i).map((f) => (
          <span key={f.id} className={`bt-float bt-float-${f.tone}`} style={{ left: p.x, top: p.y }}>{f.text}</span>
        ))}
        {/* Targeting: aim at a spot (A/B) or at the ship itself for missiles */}
        {side === "b" && choosingTarget && s.alive && (weaponAim === "ship"
          ? <button type="button" className={pick.target?.ship === i ? "bt-aim on" : "bt-aim"} style={{ left: point(i, s.spot, 0.45).x, top: point(i, s.spot, 0.45).y }} onClick={() => { setPick((k) => ({ ...k, target: { ship: i, spot: s.spot } })); playSfx("click", 0.6); }} aria-label={`استهدف السفينة ${i + 1}`}><Crosshair /></button>
          : [0, 1].map((spot) => {
            const q = point(i, spot, 0.45);
            const on = pick.target?.ship === i && pick.target.spot === spot;
            return <button key={spot} type="button" className={on ? "bt-aim on" : "bt-aim"} style={{ left: q.x, top: q.y }} onClick={() => { setPick((k) => ({ ...k, target: { ship: i, spot } })); playSfx("click", 0.6); }} aria-label={`السفينة ${i + 1} المكان ${spot ? "ب" : "أ"}`}>{spot ? "ب" : "أ"}</button>;
          }))}
        {side === "a" && phase === "decide" && s.alive && (
          <>
            <button type="button" className={pick.ship === i ? "bt-own on" : "bt-own"} style={{ left: point(i, s.spot, 0.4).x, top: point(i, s.spot, 0.4).y }} onClick={() => { setPick((k) => ({ ...k, ship: i, target: undefined, weapon: undefined, tier: undefined })); playSfx("click", 0.5); }} aria-label={`اختر سفينتك ${i + 1}`}>{i + 1}</button>
            {pick.ship === i && (
              <div className="bt-ring" style={{ left: point(i, s.spot, 1.6).x, top: point(i, s.spot, 1.6).y }} role="menu" aria-label={`أوامر السفينة ${i + 1}`}>
                {iAttack
                  ? <button type="button" role="menuitem" className={pick.mode === "attack" ? "on" : ""} onClick={() => { setPick((k) => ({ ...k, mode: "attack" })); playSfx("click", 0.5); }}><Swords /><span>هجوم</span></button>
                  : <button type="button" role="menuitem" className={pick.mode === "move" ? "on" : ""} onClick={() => { setPick((k) => ({ ...k, mode: "move" })); playSfx("click", 0.5); }}><Move /><span>مناورة</span></button>}
                <button type="button" role="menuitem" disabled={!mine.shields.length || !!s.shield} className={pick.mode === "shield" ? "on" : ""} onClick={() => { setPick((k) => ({ ...k, mode: "shield" })); playSfx("click", 0.5); }}><Shield /><span>درع</span></button>
              </div>
            )}
            {pick.ship === i && pick.mode === "move" && <span className="bt-badge" style={{ left: point(i, s.spot ? 0 : 1, 0.4).x, top: point(i, s.spot ? 0 : 1, 0.4).y }}><Move /></span>}
          </>
        )}
      </div>
    );
  });

  const selShip = pick.ship !== undefined ? mine.ships[pick.ship] : undefined;

  return (
    <div className="bt-root bt-arena" dir="rtl" ref={root} role="dialog" aria-label="ساحة المعركة">
      <header className="bt-top">
        <SideBar p={foe} hp={hpSum(view, "b")} total={total} />
        <div className="bt-round"><small>الجولة</small><b>{Math.min(view.round, CFG.rounds)}/{CFG.rounds}</b></div>
        <button type="button" className="tos-x bt-close" aria-label="انسحاب" onClick={onClose}><X className="h-4 w-4" /></button>
      </header>
      <div className="bt-seas" ref={seas}>
        <div className="bt-panel bt-panel-foe" ref={topBox}>
          <BattleSea ref={top} theme={foeWorld} ships={theirs.ships} hull={hull} mirrored stormy>{overlay("b")}</BattleSea>
          <span className="bt-tag">{foe.name} <Bot className="h-3 w-3" /></span>
        </div>
        <div className="bt-divider">
          <span className={iAttack ? "bt-turn me" : "bt-turn"}>{phase === "over" ? "انتهت المعركة" : iAttack ? "دورك في الهجوم" : "دورك في الدفاع"}</span>
          {phase === "decide" && <b className="bt-timer" key={timer}>{timer}</b>}
          {banner && <strong className="bt-banner">{banner}</strong>}
        </div>
        <div className="bt-panel bt-panel-me" ref={bottomBox}>
          <BattleSea ref={bottom} theme={myWorld} ships={mine.ships} hull={hull} stormy>{overlay("a")}</BattleSea>
          <span className="bt-tag">{me.name}</span>
        </div>
      </div>
      <WeaponsLayer ref={layer} {...hooks} />
      <div className="bt-flash" ref={flash} />

      {phase === "decide" && (
        <footer className="bt-cmd">
          <div className="bt-modes">
            {iAttack
              ? <button type="button" className={pick.mode === "attack" ? "on" : ""} onClick={() => setPick({ mode: "attack", ship: pick.ship })}><Swords />هجوم</button>
              : <>
                <button type="button" className={pick.mode === "move" ? "on" : ""} onClick={() => setPick({ mode: "move", ship: pick.ship })}><Move />مناورة</button>
                <button type="button" className={pick.mode === "pass" ? "on" : ""} onClick={() => setPick({ mode: "pass" })}>ثبات</button>
              </>}
            <button type="button" className={pick.mode === "shield" ? "on" : ""} disabled={!mine.shields.length} onClick={() => setPick({ mode: "shield", ship: pick.ship })}><Shield />درع ({mine.shields.length})</button>
          </div>
          <p className="bt-hint">
            {pick.mode === "pass" ? "تبقى سفنك في أماكنها وتخدع الخصم"
              : pick.ship === undefined ? "اختر سفينتك من البحر (الأرقام على السفن)"
              : pick.mode === "attack" && !pick.weapon ? "اختر السلاح"
              : pick.mode === "attack" && !pick.target ? (weaponAim === "ship" ? "اختر السفينة المستهدفة — الصواريخ تتبعها" : "خمّن مكان سفينة العدو: أ أم ب؟")
              : pick.mode === "move" ? "ستنتقل السفينة إلى مكانها الآخر — تفادَ الضربة"
              : pick.mode === "shield" && !pick.tier ? "اختر الدرع"
              : "جاهز — أكّد أمرك"}
          </p>
          {pick.mode === "attack" && selShip && (
            <div className="bt-weapons">
              {selShip.weapons.map((w) => (
                <button key={w.id} type="button" disabled={w.cd > 0} className={pick.weapon === w.id ? "on" : ""} onClick={() => setPick((k) => ({ ...k, weapon: w.id, target: undefined }))}>
                  <strong>{WEAPONS[w.id]?.name}</strong><small>{w.cd > 0 ? `انتظار ${w.cd}` : `ضرر ${WEAPONS[w.id]?.dmg}`}</small>
                </button>
              ))}
            </div>
          )}
          {pick.mode === "shield" && selShip && (
            <div className="bt-weapons">
              {[...new Set(mine.shields)].map((t) => (
                <button key={t} type="button" disabled={!!selShip.shield} className={pick.tier === t ? "on" : ""} onClick={() => setPick((k) => ({ ...k, tier: t }))}>
                  <strong>{SHIELDS[t]?.name}</strong><small>يصد {SHIELDS[t]?.hits} ضربة</small>
                </button>
              ))}
            </div>
          )}
          <button type="button" className="tos-btn bt-go" disabled={!ready} onClick={() => void commit()}>تأكيد الأمر</button>
          {autoNote && <p className="bt-auto"><Bot className="h-3.5 w-3.5" /> انتهى وقتك فقاد القبطان الآلي سفنك</p>}
        </footer>
      )}

      {phase === "over" && (
        <div className="bt-result" role="status">
          <h2>{view.winner === "a" ? "انتصار!" : view.winner === "b" ? "هزيمة" : "تعادل"}</h2>
          <p>{hpSum(view, "a")} ضد {hpSum(view, "b")} نقطة صمود</p>
          <button type="button" className="tos-btn" onClick={onClose}>العودة للبحر</button>
        </div>
      )}
    </div>
  );
}

function SideBar({ p, hp, total }: { p: Player; hp: number; total: number }) {
  return (
    <div className="bt-side">
      <CaptainAvatar seed={p.avatar_index ?? 0} url={p.avatar_url} className="bt-side-photo" />
      <div><strong>{p.name}</strong><span className="bt-side-bar"><i style={{ width: `${(hp / total) * 100}%` }} /></span></div>
    </div>
  );
}
