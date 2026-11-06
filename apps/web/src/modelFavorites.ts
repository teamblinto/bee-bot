import { useSyncExternalStore } from "react";

const storageKey = "beebot.modelFavorites";
const listeners = new Set<() => void>();

function readFavorites() {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
    return Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

let favorites = readFavorites();

export const favoriteKey = (accountId: string, model: string) => `${accountId}:${model}`;

export function toggleFavorite(key: string) {
  favorites = favorites.includes(key)
    ? favorites.filter((favorite) => favorite !== key)
    : [...favorites, key];
  try {
    localStorage.setItem(storageKey, JSON.stringify(favorites));
  } catch {
    // Favorites are a convenience: they still last until the app closes.
  }
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useModelFavorites = () => useSyncExternalStore(subscribe, () => favorites);
