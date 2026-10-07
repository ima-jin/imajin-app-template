import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import postcss, { type AtRule, type Container, type Rule } from 'postcss';
import tailwindcss from 'tailwindcss';

/**
 * Minimal contrast engine for DOM tests: builds the app's REAL stylesheet
 * (tailwind + `app/globals.css`), flattens it for one `prefers-color-scheme`,
 * and resolves each element's effective text colour and background the way a
 * browser would (cascade by specificity, `var()`, colour inheritance, background
 * compositing up to the canvas). jsdom doesn't evaluate media queries or
 * `var()`, so we do it here rather than trusting `getComputedStyle`.
 */

export type Scheme = 'light' | 'dark';

export interface ContrastSample {
  label: string;
  foreground: string;
  background: string;
  ratio: number;
  minimum: number;
}

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface FlatRule {
  selector: string;
  specificity: number;
  order: number;
  declarations: Map<string, string>;
}

const WCAG_AA_NORMAL_TEXT = 4.5;
const WCAG_AA_UI_COMPONENT = 3;
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const DARK_CANVAS: Rgba = { r: 18, g: 18, b: 18, a: 1 };

// vitest runs from the repo root (import.meta.url isn't a file: URL under jsdom).
const repoRoot = process.cwd();

export async function buildStylesheet(html: string): Promise<string> {
  const require = createRequire(join(repoRoot, 'package.json'));
  const config = require(join(repoRoot, 'tailwind.config.js')) as Record<string, unknown>;
  const source = readFileSync(join(repoRoot, 'app', 'globals.css'), 'utf8');
  const result = await postcss([tailwindcss({ ...config, content: [{ raw: html, extension: 'html' }] })]).process(
    source,
    { from: undefined },
  );
  return result.css;
}

function stripEscapes(selector: string): string {
  return selector.replaceAll(/\\./g, 'x');
}

function specificityOf(selector: string): number {
  const plain = stripEscapes(selector);
  const ids = plain.match(/#[\w-]+/g)?.length ?? 0;
  const classes = (plain.match(/\.[\w-]+/g)?.length ?? 0) + (plain.match(/\[/g)?.length ?? 0) + plain.split(':root').length - 1;
  const tags = plain.match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length ?? 0;
  return ids * 10_000 + classes * 100 + tags;
}

function isStaticSelector(selector: string): boolean {
  const plain = stripEscapes(selector);
  return plain === ':root' || !plain.includes(':');
}

function schemeOf(atRule: AtRule): Scheme | null {
  if (atRule.name !== 'media') {
    return null;
  }
  const match = /prefers-color-scheme:\s*(dark|light)/.exec(atRule.params);
  return match ? (match[1] as Scheme) : null;
}

function collectRules(container: Container, scheme: Scheme, out: FlatRule[]): void {
  for (const node of container.nodes ?? []) {
    if (node.type === 'rule') {
      pushRule(node, out);
    } else if (node.type === 'atrule' && schemeOf(node) === scheme) {
      collectRules(node, scheme, out);
    }
  }
}

function pushRule(rule: Rule, out: FlatRule[]): void {
  const declarations = new Map<string, string>();
  rule.walkDecls((decl) => {
    declarations.set(decl.prop, decl.value);
  });
  for (const selector of rule.selectors) {
    if (isStaticSelector(selector)) {
      out.push({ selector, specificity: specificityOf(selector), order: out.length, declarations });
    }
  }
}

export function flattenStylesheet(css: string, scheme: Scheme): FlatRule[] {
  const rules: FlatRule[] = [];
  collectRules(postcss.parse(css), scheme, rules);
  return rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
}

function matches(element: Element, selector: string): boolean {
  try {
    return element.matches(selector);
  } catch {
    return false;
  }
}

function declared(rules: FlatRule[], element: Element, property: string): string | null {
  let value: string | null = null;
  for (const rule of rules) {
    const candidate = rule.declarations.get(property);
    if (candidate !== undefined && matches(element, rule.selector)) {
      value = candidate;
    }
  }
  return value;
}

function rootVariables(rules: FlatRule[], root: Element): Map<string, string> {
  const variables = new Map<string, string>();
  for (const rule of rules) {
    if (matches(root, rule.selector)) {
      for (const [prop, value] of rule.declarations) {
        if (prop.startsWith('--')) {
          variables.set(prop, value);
        }
      }
    }
  }
  return variables;
}

function resolveVariables(value: string, variables: Map<string, string>): string {
  const pattern = /var\((--[\w-]+)(?:\s*,\s*([^()]+))?\)/;
  let current = value;
  for (let depth = 0; depth < 10 && pattern.test(current); depth++) {
    current = current.replace(pattern, (_whole, name: string, fallback?: string) => {
      const known = variables.get(name);
      if (known !== undefined) {
        return known;
      }
      if (fallback !== undefined) {
        return fallback.trim();
      }
      return name.includes('opacity') ? '1' : '';
    });
  }
  return current;
}

function parseHex(hex: string): Rgba {
  const digits = hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex;
  const channel = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);
  return { r: channel(0), g: channel(2), b: channel(4), a: 1 };
}

function parseAlpha(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return 1;
  }
  return raw.endsWith('%') ? Number.parseFloat(raw) / 100 : Number.parseFloat(raw);
}

export function parseColor(input: string): Rgba | 'current' {
  const value = input.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/.exec(value);
  if (hex) {
    return parseHex(hex[1]);
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[/,]\s*([\d.]+%?))?\s*\)$/.exec(value);
  if (fn) {
    return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: parseAlpha(fn[4]) };
  }
  const named: Record<string, Rgba | 'current'> = {
    white: WHITE,
    black: BLACK,
    transparent: { r: 0, g: 0, b: 0, a: 0 },
    currentcolor: 'current',
  };
  if (value in named) {
    return named[value];
  }
  throw new Error(`Unsupported colour value: "${input}"`);
}

function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) {
    return { r: 0, g: 0, b: 0, a: 0 };
  }
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function luminance({ r, g, b }: Rgba): number {
  const linear = (channel: number) => {
    const c = channel / 255;
    return c <= 0.039_28 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function hexOf({ r, g, b }: Rgba): string {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`;
}

export class StyleResolver {
  private readonly rules: FlatRule[];
  private readonly variables: Map<string, string>;
  private readonly root: Element;
  private readonly scheme: Scheme;

  constructor(css: string, scheme: Scheme, root: Element) {
    this.rules = flattenStylesheet(css, scheme);
    this.variables = rootVariables(this.rules, root);
    this.root = root;
    this.scheme = scheme;
  }

  private colorOf(element: Element, property: string): Rgba | 'current' | null {
    const raw = declared(this.rules, element, property);
    return raw === null ? null : parseColor(resolveVariables(raw, this.variables));
  }

  /** Browser canvas: only dark when the page opts in with `color-scheme: ... dark`. */
  private canvas(): { background: Rgba; text: Rgba } {
    const declaredScheme = declared(this.rules, this.root, 'color-scheme') ?? '';
    if (this.scheme === 'dark' && declaredScheme.includes('dark')) {
      return { background: DARK_CANVAS, text: WHITE };
    }
    return { background: WHITE, text: BLACK };
  }

  textColor(element: Element): Rgba {
    for (let node: Element | null = element; node; node = node.parentElement) {
      const color = this.colorOf(node, 'color');
      if (color !== null && color !== 'current') {
        return color;
      }
    }
    return this.canvas().text;
  }

  backgroundColor(element: Element): Rgba {
    const chain: Element[] = [];
    for (let node: Element | null = element; node; node = node.parentElement) {
      chain.unshift(node);
    }
    let result = this.canvas().background;
    for (const node of chain) {
      const color = this.colorOf(node, 'background-color');
      if (color !== null && color !== 'current') {
        result = over(color, result);
      }
    }
    return result;
  }

  borderColor(element: Element): Rgba | null {
    const color = this.colorOf(element, 'border-color');
    return color === 'current' ? this.textColor(element) : color;
  }
}

function hasOwnText(element: Element): boolean {
  return [...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim() !== '');
}

function labelOf(element: Element): string {
  const text = (element.textContent ?? '').trim().slice(0, 40);
  return `<${element.tagName.toLowerCase()}> ${text || element.getAttribute('name') || ''}`.trim();
}

/** Every text-bearing element + form control, plus input borders (UI component contrast). */
export function collectContrastSamples(root: Element, css: string, scheme: Scheme): ContrastSample[] {
  const resolver = new StyleResolver(css, scheme, root.ownerDocument.documentElement);
  const samples: ContrastSample[] = [];
  for (const element of root.querySelectorAll('*')) {
    const isControl = element.matches('input, button, textarea, select');
    if (hasOwnText(element) || isControl) {
      const foreground = resolver.textColor(element);
      const background = resolver.backgroundColor(element);
      const visible = over(foreground, background);
      samples.push({
        label: labelOf(element),
        foreground: hexOf(visible),
        background: hexOf(background),
        ratio: contrastRatio(visible, background),
        minimum: WCAG_AA_NORMAL_TEXT,
      });
    }
    const border = element.matches('input, textarea, select') ? resolver.borderColor(element) : null;
    if (border !== null && element.parentElement) {
      const surround = resolver.backgroundColor(element.parentElement);
      const visible = over(border, surround);
      samples.push({
        label: `${labelOf(element)} (border)`,
        foreground: hexOf(visible),
        background: hexOf(surround),
        ratio: contrastRatio(visible, surround),
        minimum: WCAG_AA_UI_COMPONENT,
      });
    }
  }
  return samples;
}

export function failures(samples: ContrastSample[]): string[] {
  return samples
    .filter((sample) => sample.ratio < sample.minimum)
    .map(
      (sample) =>
        `${sample.label}: ${sample.foreground} on ${sample.background} = ${sample.ratio.toFixed(2)}:1 (needs ${sample.minimum}:1)`,
    );
}
