/**
 * Entity resolver for disambiguating search results.
 * Classifies web search results by entity type (TV_SHOW, MOVIE, BOOK, etc.)
 * to help the agent present clear options when queries are ambiguous.
 */

export type EntityType =
  | 'TV_SHOW'
  | 'MOVIE'
  | 'BOOK'
  | 'PERSON'
  | 'PLACE'
  | 'ORGANIZATION'
  | 'OTHER';

export interface ResolvedEntity {
  title: string;
  url: string;
  entityType: EntityType;
  year?: string;
  snippet?: string;
}

/**
 * Heuristic entity classification based on URL domain and snippet content.
 * No LLM call required — uses pattern matching for speed.
 */
export function classifySearchResult(result: {
  title: string;
  url: string;
  snippet?: string;
}): EntityType {
  const url = result.url.toLowerCase();
  const text = `${result.title} ${result.snippet ?? ''}`.toLowerCase();

  // IMDb-specific classification
  if (url.includes('imdb.com')) {
    if (url.includes('/title/') && text.match(/tv\s*(series|show|mini)/i)) return 'TV_SHOW';
    if (url.includes('/title/')) return 'MOVIE';
    if (url.includes('/name/')) return 'PERSON';
  }

  // Wikipedia classification
  if (url.includes('wikipedia.org')) {
    if (text.match(/\b(tv\s*series|television\s*series|animated\s*series)\b/)) return 'TV_SHOW';
    if (text.match(/\b(film|movie)\b/)) return 'MOVIE';
    if (text.match(/\b(novel|book|author)\b/)) return 'BOOK';
    if (text.match(/\b(born|died|career|biography)\b/)) return 'PERSON';
  }

  // General patterns
  if (text.match(/\b(season\s*\d|episode|tv\s*show|series\s*premiere)\b/)) return 'TV_SHOW';
  if (text.match(/\b(box\s*office|directed\s*by|starring|film|movie)\b/)) return 'MOVIE';
  if (text.match(/\b(isbn|pages|published|novel|paperback|hardcover|author)\b/)) return 'BOOK';

  return 'OTHER';
}

/**
 * Check if search results suggest multiple distinct entities for the same query.
 * Returns the classified entities if disambiguation is needed, or null if results
 * are unambiguous.
 */
export function detectAmbiguity(
  results: Array<{ title: string; url: string; snippet?: string }>,
  query: string
): ResolvedEntity[] | null {
  if (results.length < 2) return null;

  const classified = results.map((r) => ({
    title: r.title,
    url: r.url,
    entityType: classifySearchResult(r),
    snippet: r.snippet,
    year: extractYear(r.title) ?? extractYear(r.snippet ?? ''),
  }));

  // Count distinct entity types (excluding OTHER)
  const types = new Set(classified.filter((c) => c.entityType !== 'OTHER').map((c) => c.entityType));

  // Ambiguous if multiple entity types are present
  if (types.size >= 2) {
    return classified;
  }

  // Also check for multiple distinct years within the same type
  const primaryType = [...types][0];
  if (primaryType) {
    const years = new Set(
      classified
        .filter((c) => c.entityType === primaryType && c.year)
        .map((c) => c.year)
    );
    if (years.size >= 2) {
      return classified;
    }
  }

  return null;
}

function extractYear(text: string): string | undefined {
  const match = text.match(/\b(19\d{2}|20\d{2})\b/);
  return match?.[1];
}

/**
 * Format resolved entities into a disambiguation message for the user.
 */
export function formatDisambiguationMessage(
  entities: ResolvedEntity[],
  query: string
): string {
  // Group by type
  const byType = new Map<EntityType, ResolvedEntity[]>();
  for (const entity of entities) {
    if (entity.entityType === 'OTHER') continue;
    const list = byType.get(entity.entityType) ?? [];
    list.push(entity);
    byType.set(entity.entityType, list);
  }

  const typeLabels: Record<EntityType, string> = {
    TV_SHOW: 'TV Series',
    MOVIE: 'Movie',
    BOOK: 'Book',
    PERSON: 'Person',
    PLACE: 'Place',
    ORGANIZATION: 'Organization',
    OTHER: 'Other',
  };

  const lines: string[] = [
    `Multiple entities found for "${query}". Which one did you mean?`,
  ];

  for (const [type, items] of byType) {
    for (const item of items.slice(0, 3)) {
      const yearPart = item.year ? ` (${item.year})` : '';
      lines.push(`- ${item.title}${yearPart} [${typeLabels[type]}]`);
    }
  }

  return lines.join('\n');
}
