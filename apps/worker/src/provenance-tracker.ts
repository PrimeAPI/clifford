/**
 * ProvenanceTracker tracks grounding state for a run.
 * Records web searches, page fetches, and data extractions
 * so that output validation can verify claims are backed by sources.
 */

export interface Extraction {
  url: string;
  type: string;
  data: unknown;
  timestamp: string;
}

export interface ProvenanceSummary {
  searchQueries: string[];
  fetchedUrls: string[];
  extractions: Extraction[];
}

/**
 * Regex to detect numeric claims in output text that likely need grounding.
 * Matches patterns like "8.5/10", "rating of 7.2", "average 8.1", "score: 92%", etc.
 */
const NUMERIC_CLAIM_PATTERN =
  /\d+(\.\d+)?\s*\/\s*\d+|\d+(\.\d+)?\s*(%|percent|rating|score|average|out of|bewertung|durchschnitt|note)/i;

export class ProvenanceTracker {
  private searchQueries: string[] = [];
  private fetchedUrls = new Set<string>();
  private extractions: Extraction[] = [];
  private groundingNudgeCount = 0;

  /** Record a web search query */
  recordSearch(query: string): void {
    this.searchQueries.push(query);
  }

  /** Record a fetched URL */
  recordFetch(url: string): void {
    this.fetchedUrls.add(url);
  }

  /** Record a data extraction from a URL */
  recordExtract(url: string, type: string, data: unknown): void {
    this.extractions.push({
      url,
      type,
      data,
      timestamp: new Date().toISOString(),
    });
  }

  /** Check if any grounding data has been collected */
  hasGrounding(): boolean {
    return this.fetchedUrls.size > 0 || this.extractions.length > 0;
  }

  /** Check if a search was followed by at least one fetch */
  hasFetchedAfterSearch(): boolean {
    return this.searchQueries.length > 0 && this.fetchedUrls.size > 0;
  }

  /** Get a summary of all provenance data for validation */
  getSummary(): ProvenanceSummary {
    return {
      searchQueries: [...this.searchQueries],
      fetchedUrls: [...this.fetchedUrls],
      extractions: [...this.extractions],
    };
  }

  /**
   * Check if output text contains numeric claims that need grounding.
   * Returns a nudge message if grounding is missing, or null if okay.
   * Tracks nudge count to avoid infinite loops (max 2 nudges).
   */
  checkOutputGrounding(outputText: string): string | null {
    if (!NUMERIC_CLAIM_PATTERN.test(outputText)) {
      return null; // No numeric claims detected
    }

    if (this.hasGrounding()) {
      return null; // Claims are grounded
    }

    this.groundingNudgeCount++;

    if (this.groundingNudgeCount > 2) {
      return null; // Stop nudging to prevent infinite loops
    }

    if (this.groundingNudgeCount === 1) {
      return (
        'Your response includes numeric claims but you have not fetched any source data. ' +
        'Use web.search then web.fetch to verify these numbers before reporting them.'
      );
    }

    return (
      'REQUIRED: Do not report numeric data without first fetching it from a web source. ' +
      'Search and fetch the relevant page before responding with numbers.'
    );
  }
}
