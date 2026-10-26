/**
 * Path patterns in agents.yaml.
 *
 * - A pattern starts with `/` and is matched against the request path only,
 *   without the query string. Matching is case-sensitive.
 * - `*` matches any run of characters, including `/` and nothing at all, so
 *   `/api/*` covers `/api/`, `/api/users` and `/api/v1/users/7`.
 * - A pattern without `*` matches that exact path only.
 *
 * Specificity, when several patterns match one path:
 * 1. An exact pattern (no `*`) beats any pattern with a wildcard.
 * 2. Otherwise the pattern with more literal characters wins (`/api/admin/*`
 *    beats `/api/*`).
 * 3. Then the pattern with fewer wildcards.
 * 4. Then the pattern written first in agents.yaml.
 */

export interface CompiledPattern<T> {
  pattern: string;
  value: T;
  regex: RegExp;
  exact: boolean;
  literals: number;
  wildcards: number;
  order: number;
}

export function compilePattern<T>(pattern: string, value: T, order: number): CompiledPattern<T> {
  const parts = pattern.split("*");
  const regex = new RegExp(
    `^${parts.map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return {
    pattern,
    value,
    regex,
    exact: parts.length === 1,
    literals: pattern.length - (parts.length - 1),
    wildcards: parts.length - 1,
    order,
  };
}

/** Most specific first. */
export function bySpecificity<T>(a: CompiledPattern<T>, b: CompiledPattern<T>): number {
  if (a.exact !== b.exact) return a.exact ? -1 : 1;
  if (a.literals !== b.literals) return b.literals - a.literals;
  if (a.wildcards !== b.wildcards) return a.wildcards - b.wildcards;
  return a.order - b.order;
}

/** Compiles and sorts patterns once, so each request is a short ordered scan. */
export function compilePatterns<T>(
  entries: readonly { pattern: string; value: T }[],
): CompiledPattern<T>[] {
  return entries
    .map((entry, order) => compilePattern(entry.pattern, entry.value, order))
    .sort(bySpecificity);
}

/** Every pattern that matches the path, most specific first. */
export function matchingPatterns<T>(
  compiled: readonly CompiledPattern<T>[],
  path: string,
): CompiledPattern<T>[] {
  return compiled.filter((entry) => entry.regex.test(path));
}
