import { useEffect, useState } from "react";
import { spellIconData } from "../api";

const cache = new Map<number, Promise<string>>();

export function spellIconId(value: string | null | undefined): number | null {
  const match = /^spell:(\d+)$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function loadIcon(id: number): Promise<string> {
  let pending = cache.get(id);
  if (!pending) {
    pending = spellIconData(id);
    cache.set(id, pending);
  }
  return pending;
}

export default function SpellGemIcon({
  icon,
  size = 25,
  label,
}: {
  icon: string | null | undefined;
  size?: number;
  label?: string;
}) {
  const id = spellIconId(icon);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setSrc(null);
    if (id == null) return;
    void loadIcon(id)
      .then((value) => {
        if (!stale) setSrc(value);
      })
      .catch(() => {
        if (!stale) setSrc("");
      });
    return () => {
      stale = true;
    };
  }, [id]);

  if (id == null) return null;
  return src ? (
    <img
      className="spell-gem-icon"
      src={src}
      width={size}
      height={size}
      alt={label ?? ""}
      title={label}
      draggable={false}
    />
  ) : (
    <span
      className="spell-gem-icon placeholder"
      style={{ width: size, height: size }}
      aria-hidden="true"
      title={label}
    />
  );
}
