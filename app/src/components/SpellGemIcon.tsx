import { useEffect, useState } from "react";
import { spellIconData, spellIconsForNames } from "../api";

const cache = new Map<number, Promise<string>>();
const nameCache = new Map<string, Promise<number | null>>();

export function spellIconId(value: string | null | undefined): number | null {
  const match = /^spell:(\d+)$/.exec(value?.trim() ?? "");
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/** A data-driven icon reference whose spell name may contain trigger captures. */
export function spellIconName(value: string | null | undefined): string | null {
  const match = /^spell-name:(.+)$/i.exec(value?.trim() ?? "");
  return match?.[1].trim() || null;
}

function loadIcon(id: number): Promise<string> {
  let pending = cache.get(id);
  if (!pending) {
    pending = spellIconData(id);
    cache.set(id, pending);
  }
  return pending;
}

function resolveIconName(name: string): Promise<number | null> {
  const key = name.toLowerCase();
  let pending = nameCache.get(key);
  if (!pending) {
    pending = spellIconsForNames([name]).then(([match]) => match?.iconId ?? null);
    nameCache.set(key, pending);
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
  const configuredId = spellIconId(icon);
  const configuredName = spellIconName(icon);
  const [id, setId] = useState<number | null>(configuredId);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setId(configuredId);
    if (configuredId == null && configuredName) {
      void resolveIconName(configuredName).then((value) => {
        if (!stale) setId(value);
      });
    }
    return () => {
      stale = true;
    };
  }, [configuredId, configuredName]);

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
