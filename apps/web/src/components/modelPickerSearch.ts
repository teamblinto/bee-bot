export type SearchableModel = {
  accountId: string;
  providerLabel: string;
  name: string;
  id: string;
  isFavorite: boolean;
};

const favoriteBoost = 24;
const exactNameScore = -1000;
const fuzzyMinLength = 3;
const boundaries = [" ", "-", "_", "/"];

const normalize = (text: string) => text.trim().toLowerCase();

function subsequenceScore(value: string, query: string) {
  let at = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== query[at]) {
      continue;
    }
    first = first === -1 ? index : first;
    gaps += previous === -1 ? 0 : index - previous - 1;
    previous = index;
    at += 1;
    if (at === query.length) {
      return gaps * 3 + (index - first + 1 - query.length);
    }
  }
  return null;
}

function tokenScore(value: string, token: string, base: number) {
  if (!value) {
    return null;
  }
  if (value === token) {
    return base;
  }
  if (value.startsWith(token)) {
    return base + 2;
  }
  if (boundaries.some((marker) => value.includes(`${marker}${token}`))) {
    return base + 4;
  }
  if (value.includes(token)) {
    return base + 6;
  }
  const fuzzy = token.length >= fuzzyMinLength ? subsequenceScore(value, token) : null;
  return fuzzy === null ? null : base + 100 + fuzzy;
}

// Lower is better. Null means no match.
export function scoreModelSearch(model: SearchableModel, query: string) {
  const tokens = normalize(query).split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) {
    return 0;
  }
  const name = normalize(model.name);
  const joined = tokens.join(" ");
  if (joined === name || joined === normalize(model.id)) {
    return exactNameScore;
  }
  const { accountId, providerLabel, id } = model;
  const fields = [name, normalize(id), normalize(accountId), normalize(providerLabel)];
  fields.push(fields.join(" "));
  let score = 0;
  for (const token of tokens) {
    const scores = fields.flatMap((field, index) => tokenScore(field, token, index * 10) ?? []);
    if (scores.length === 0) {
      return null;
    }
    score += Math.min(...scores);
  }
  return model.isFavorite ? score - favoriteBoost : score;
}

export function rankModelSearch<T>(
  items: readonly T[],
  query: string,
  toSearchable: (item: T) => SearchableModel,
) {
  return items
    .flatMap((item, order) => {
      const searchable = toSearchable(item);
      const score = scoreModelSearch(searchable, query);
      return score === null ? [] : [{ item, score, order, favorite: searchable.isFavorite }];
    })
    .toSorted(
      (a, b) => a.score - b.score || Number(b.favorite) - Number(a.favorite) || a.order - b.order,
    )
    .map(({ item }) => item);
}
