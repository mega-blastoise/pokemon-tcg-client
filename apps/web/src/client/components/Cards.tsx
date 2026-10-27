/** @module cards Card tiles with holo tilt, result grids, set rows, and the detail drawer. */
import type { CardView, SetView } from "@johto-ai/tcg-agent/protocol";
import { type CSSProperties, type PointerEvent, useState } from "react";

export const TYPE_COLORS: Record<string, string> = {
  Colorless: "#c8c3a8",
  Darkness: "#7b6b9e",
  Dragon: "#c9a227",
  Fairy: "#f4a6c6",
  Fighting: "#d0703c",
  Fire: "#f5593d",
  Grass: "#5bbf4a",
  Lightning: "#f7d02c",
  Metal: "#a8b4c0",
  Psychic: "#b65fcf",
  Water: "#3d9bf5",
};

export function typeColor(types: readonly string[]): string {
  return TYPE_COLORS[types[0] ?? ""] ?? "#8a93a6";
}

/** Rarer cards get the animated foil layer. */
function isFoil(rarity: string | null): boolean {
  return (
    !!rarity &&
    /holo|rare|ex|gx|v|illustration|secret|rainbow|shiny|radiant|ace|hyper/i.test(
      rarity,
    ) &&
    !/^(common|uncommon|rare)$/i.test(rarity)
  );
}

/** Energy symbol as a colored orb with the type's initial. */
export function Energy({ type, size = 18 }: { type: string; size?: number }) {
  return (
    <span
      className="energy"
      title={type}
      style={
        {
          "--c": TYPE_COLORS[type] ?? "#8a93a6",
          width: size,
          height: size,
          fontSize: size * 0.55,
        } as CSSProperties
      }
    >
      {type === "Colorless" ? "" : type[0]}
    </span>
  );
}

/** One card with pointer-tracked tilt and glare. */
export function CardTile({
  card,
  onOpen,
}: {
  card: CardView;
  onOpen: (card: CardView) => void;
}) {
  const [tilt, setTilt] = useState({ x: 50, y: 50, active: false });
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTilt({
      x: ((event.clientX - rect.left) / rect.width) * 100,
      y: ((event.clientY - rect.top) / rect.height) * 100,
      active: true,
    });
  };
  const style = {
    "--mx": `${tilt.x}%`,
    "--my": `${tilt.y}%`,
    "--rx": `${tilt.active ? (tilt.y - 50) / -6 : 0}deg`,
    "--ry": `${tilt.active ? (tilt.x - 50) / 5 : 0}deg`,
    "--accent": typeColor(card.types),
  } as CSSProperties;
  return (
    <button
      type="button"
      className={`tile${isFoil(card.rarity) ? " foil" : ""}${tilt.active ? " active" : ""}`}
      style={style}
      onPointerMove={move}
      onPointerLeave={() => setTilt({ x: 50, y: 50, active: false })}
      onClick={() => onOpen(card)}
      title={`${card.name} · ${card.setName ?? card.setId} #${card.number}`}
    >
      <div className="tile-art">
        {card.images.small ? (
          <img
            src={card.images.small}
            alt={card.name}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="tile-missing">{card.name}</div>
        )}
        <div className="tile-glare" />
      </div>
      <div className="tile-meta">
        <span className="tile-name">{card.name}</span>
        <span className="tile-sub">
          {card.setName ?? card.setId} · #{card.number}
        </span>
      </div>
    </button>
  );
}

/** Result grid; long results expand on demand. */
export function CardGrid({
  cards,
  total,
  onOpen,
}: {
  cards: readonly CardView[];
  total?: number | undefined;
  onOpen: (card: CardView) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? cards : cards.slice(0, 8);
  return (
    <div className="grid-wrap">
      <div className="grid">
        {shown.map((card) => (
          <CardTile key={card.id} card={card} onOpen={onOpen} />
        ))}
      </div>
      {(cards.length > shown.length || (total ?? 0) > cards.length) && (
        <div className="grid-foot">
          {cards.length > shown.length && (
            <button
              type="button"
              className="ghost"
              onClick={() => setExpanded(true)}
            >
              Show all {cards.length} on this page
            </button>
          )}
          {(total ?? 0) > cards.length && (
            <span className="muted">
              {(total ?? 0).toLocaleString()} total matches
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Set results as compact logo rows. */
export function SetList({ sets }: { sets: readonly SetView[] }) {
  return (
    <div className="sets">
      {sets.map((set) => (
        <div key={set.id} className="set-row">
          <div className="set-logo">
            {set.logo ? (
              <img src={set.logo} alt="" loading="lazy" />
            ) : (
              <span>{set.id}</span>
            )}
          </div>
          <div className="set-text">
            <strong>{set.name}</strong>
            <span className="muted">
              {set.series} · {set.releaseDate ?? "undated"} · {set.cardCount}{" "}
              cards
            </span>
          </div>
          <code>{set.id}</code>
        </div>
      ))}
    </div>
  );
}

function Legal({ label, status }: { label: string; status: string }) {
  return (
    <span className={`legal ${status}`}>
      {label} <b>{status}</b>
    </span>
  );
}

/** Full card detail; read directly through the browser client. */
export function CardDetail({ card }: { card: CardView }) {
  return (
    <div
      className="card-detail"
      style={{ "--accent": typeColor(card.types) } as CSSProperties}
    >
      <div className="detail-art">
        {card.images.large || card.images.small ? (
          <img
            src={card.images.large ?? card.images.small ?? ""}
            alt={card.name}
          />
        ) : (
          <div className="tile-missing">No image</div>
        )}
      </div>
      <div className="detail-head">
        <div>
          <h2>{card.name}</h2>
          <div className="muted">
            {card.supertype}
            {card.subtypes.length ? ` · ${card.subtypes.join(" · ")}` : ""}
            {card.evolvesFrom ? ` · from ${card.evolvesFrom}` : ""}
          </div>
        </div>
        <div className="hp">
          {card.hp !== null && (
            <span>
              <small>HP</small>
              {card.hp}
            </span>
          )}
          {card.types.map((t) => (
            <Energy key={t} type={t} size={24} />
          ))}
        </div>
      </div>
      <div className="pills">
        <span className="pill">{card.setName ?? card.setId}</span>
        <span className="pill">#{card.number}</span>
        {card.rarity && <span className="pill accent">{card.rarity}</span>}
        {card.regulationMark && (
          <span className="pill">Reg {card.regulationMark}</span>
        )}
        {card.releaseDate && <span className="pill">{card.releaseDate}</span>}
      </div>
      {card.abilities.map((a) => (
        <section key={a.name} className="move ability">
          <header>
            <span className="badge">{a.type}</span>
            <strong>{a.name}</strong>
          </header>
          {a.text && <p>{a.text}</p>}
        </section>
      ))}
      {card.attacks.map((a) => (
        <section key={a.name} className="move">
          <header>
            <span className="cost">
              {a.cost.map((c, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Costs repeat by design.
                <Energy key={i} type={c} />
              ))}
            </span>
            <strong>{a.name}</strong>
            <span className="damage">{a.damage}</span>
          </header>
          {a.text && <p>{a.text}</p>}
        </section>
      ))}
      {card.rules.map((rule) => (
        <p key={rule} className="rule">
          {rule}
        </p>
      ))}
      {card.supertype === "Pokémon" && (
        <div className="stats">
          <div>
            <small>Weakness</small>
            {card.weaknesses.map((w) => (
              <span key={w.type}>
                <Energy type={w.type} /> {w.value}
              </span>
            ))}
            {!card.weaknesses.length && "—"}
          </div>
          <div>
            <small>Resistance</small>
            {card.resistances.map((r) => (
              <span key={r.type}>
                <Energy type={r.type} /> {r.value}
              </span>
            ))}
            {!card.resistances.length && "—"}
          </div>
          <div>
            <small>Retreat</small>
            {Array.from({ length: card.retreatCost }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: Identical retreat pips.
              <Energy key={i} type="Colorless" />
            ))}
            {!card.retreatCost && "—"}
          </div>
        </div>
      )}
      <div className="legals">
        <Legal label="Standard" status={card.legalities.standard} />
        <Legal label="Expanded" status={card.legalities.expanded} />
        <Legal label="Unlimited" status={card.legalities.unlimited} />
      </div>
      {card.flavorText && <p className="flavor">“{card.flavorText}”</p>}
      <p className="muted small">
        {card.artist ? `Illustrated by ${card.artist} · ` : ""}
        <code>{card.id}</code>
      </p>
    </div>
  );
}
