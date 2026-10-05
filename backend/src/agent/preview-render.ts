/** Browser verification shared by Browser Run and the local browser regression tests. */
import { extractionExpression } from "./extraction.ts";
import type { Browser } from "@cloudflare/puppeteer";
import { WIDGET_SIZES, type WidgetSize } from "../widget-contract.ts";

const ORIGIN = "https://widget.local";
const TIMEOUT_MS = 15_000;

export interface PreviewFiles {
  html: string;
  extra: string;
  source: string;
  size: WidgetSize;
}

export interface PreviewResult {
  size: WidgetSize;
  viewport: { width: number; height: number };
  root: { x: number; y: number; width: number; height: number } | null;
  syntaxError: string | null;
  errors: string[];
  text: string;
  extractedData: string | null;
  screenshotBytes: number;
  screenshotBase64: string;
}

// Evaluated in Chromium, which owns DOM APIs absent from the Worker type environment.
const INSPECT = `(() => {
  const errors = [];
  const root = document.getElementById('widget-root');
  const rect = root && root.getBoundingClientRect();
  const box = rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  if (!rect) errors.push('Missing #widget-root');
  else if (Math.abs(rect.x) > 1 || Math.abs(rect.y) > 1 ||
    Math.abs(rect.width - innerWidth) > 1 || Math.abs(rect.height - innerHeight) > 1) {
    errors.push('#widget-root must fill the viewport at (0, 0)');
  }
  if (document.documentElement.scrollWidth > innerWidth ||
      document.documentElement.scrollHeight > innerHeight ||
      document.body.scrollWidth > innerWidth || document.body.scrollHeight > innerHeight) {
    errors.push('Page content overflows the viewport');
  }
  let clipped = false;
  let motion = false;
  const hasDuration = value => value.split(',').some(part => parseFloat(part) > 0);
  for (const el of document.querySelectorAll('*')) {
    const style = getComputedStyle(el);
    if (style.display === 'none') continue;
    for (const pseudo of [null, '::before', '::after']) {
      const css = pseudo ? getComputedStyle(el, pseudo) : style;
      if ((pseudo && (css.content === 'none' || css.content === 'normal'))) continue;
      if (css.animationName.split(',').some(name => name.trim() !== 'none') ||
          (css.transitionProperty !== 'none' && hasDuration(css.transitionDuration))) motion = true;
    }
    if (root && root.contains(el)) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.left < -1 || r.top < -1 ||
          r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) clipped = true;
      // Deliberate single-line ellipsis and line clamping are allowed for labels.
      const truncates = style.textOverflow === 'ellipsis' || parseInt(style.webkitLineClamp) > 0;
      if (!truncates && el.clientWidth && el.clientHeight &&
        (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) clipped = true;
    }
  }
  const declaresMotion = rules => [...rules].some(rule => {
    if (rule.type === 7) return true;
    if (rule.style) {
      const animation = rule.style.getPropertyValue('animation');
      const names = rule.style.getPropertyValue('animation-name');
      const transition = rule.style.getPropertyValue('transition');
      const duration = rule.style.getPropertyValue('transition-duration');
      if ((animation && animation !== 'none') || (names && names !== 'none') ||
          (transition && transition !== 'none' && /[1-9]/.test(transition)) ||
          (duration && hasDuration(duration))) return true;
    }
    return rule.cssRules && declaresMotion(rule.cssRules);
  });
  for (const sheet of document.styleSheets) {
    try { if (declaresMotion(sheet.cssRules)) motion = true; } catch {}
  }
  if (clipped) errors.push('Widget content overflows or is clipped; fit the content to its size');
  if (motion || document.getAnimations().length ||
      document.querySelector('animate, animateTransform, animateMotion, set, video, marquee')) {
    errors.push('Widget declares motion; remove animations, transitions and animated media');
  }
  const visibleSiblings = [...document.body.children].filter(el =>
    !['SCRIPT', 'STYLE', 'LINK'].includes(el.tagName) && el !== root &&
    getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
  if (visibleSiblings.length) errors.push('Only #widget-root may be visible in the body');
  return { root: box, errors, text: root ? root.innerText : document.body.innerText };
})()`;

const READY = `Promise.all([
  document.fonts.ready,
  ...Array.from(document.images, image => image.decode().catch(() => {}))
])`;

/** Uses isolated pages, never navigates to the captured source or executes its scripts. */
export async function renderWidgetPreview(browser: Browser, files: PreviewFiles): Promise<PreviewResult> {
  const context = await browser.createBrowserContext();
  const errors: string[] = [];
  const note = (message: string): void => {
    if (errors.length < 25) errors.push(message.slice(0, 300));
  };
  const viewport = WIDGET_SIZES[files.size];
  try {
    const extraction = await context.newPage();
    await extraction.setRequestInterception(true);
    extraction.on("request", request => {
      note("extra.js must not request network resources");
      void request.abort().catch(() => {});
    });
    extraction.on("pageerror", error => note(`extraction: ${error.message}`));
    const syntaxError = await extraction.evaluate((script: string) => {
      try { new Function(script); return null; }
      catch (error) { return String((error as Error).message); }
    }, files.extra);
    let extractedData: string | null = null;
    if (syntaxError === null) {
      try {
        extractedData = await extraction.evaluate(extractionExpression(files.extra, files.source)) as string;
      } catch (error) {
        note(`extraction: ${String(error)}`);
      }
    }
    await extraction.close();

    const page = await context.newPage();
    await page.setViewport({ ...viewport, deviceScaleFactor: 1 });
    page.on("pageerror", error => note(`widget: ${error.message}`));
    page.on("console", message => {
      if (message.type() === "error") note(`console: ${message.text()}`);
    });
    page.on("requestfailed", request => note(`failed resource: ${request.url().slice(0, 150)}`));
    let dataRequests = 0;
    await page.setRequestInterception(true);
    page.on("request", request => {
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:") {
        void request.continue().catch(() => {});
      } else if (request.url() === `${ORIGIN}/widget.html`) {
        void request.respond({ status: 200, contentType: "text/html", body: files.html }).catch(() => {});
      } else if (url.origin === ORIGIN && url.pathname === "/data.json") {
        dataRequests++;
        void request.respond({
          status: extractedData === null ? 500 : 200,
          contentType: "application/json; charset=utf-8",
          headers: { "cache-control": "no-store" },
          body: extractedData ?? '{"error":"extraction failed"}',
        }).catch(() => {});
      } else if (url.origin === ORIGIN && url.pathname === "/favicon.ico") {
        void request.respond({ status: 204, body: "" }).catch(() => {});
      } else {
        note(`Widget must embed resources: ${url.pathname.slice(0, 150)}`);
        void request.respond({ status: 404, body: "" }).catch(() => {});
      }
    });
    await page.goto(`${ORIGIN}/widget.html`, { waitUntil: "load", timeout: TIMEOUT_MS });
    let loaded = false;
    try {
      await page.evaluate(`(async () => {
        if (!window.widgetReady || typeof window.widgetReady.then !== 'function') {
          throw new Error('widget.html must assign window.widgetReady during initialization');
        }
        let timer;
        try {
          await Promise.race([
            window.widgetReady,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('widgetReady timed out')), ${TIMEOUT_MS}); })
          ]);
        } finally { clearTimeout(timer); }
      })()`);
      loaded = true;
    } catch (error) {
      note(`data loading: ${String(error)}`);
    }
    if (dataRequests === 0) note("widget.html must fetch same-directory ./data.json");
    await page.evaluate(READY);
    type Inspection = { root: PreviewResult["root"]; errors: string[]; text: string };
    const inspected = await page.evaluate(INSPECT) as Inspection;
    inspected.errors.forEach(note);
    const base64 = await page.screenshot({ type: "png", encoding: "base64" }) as string;
    if (loaded && extractedData !== null) {
      try {
        await page.evaluate(`(() => {
          if (typeof window.renderWidget !== 'function') throw new Error('widget.html must define window.renderWidget');
          const result = window.renderWidget(${extractedData});
          if (result && typeof result.then === 'function') throw new Error('renderWidget must render synchronously');
        })()`);
        await page.evaluate(READY);
        const rendered = await page.evaluate(INSPECT) as Inspection;
        if (inspected.text !== rendered.text) note("Loaded data.json was not fully rendered before widgetReady resolved");
        rendered.errors.forEach(note);
        await page.evaluate(`window.renderWidget(${extractedData})`);
        const repeated = await page.evaluate(INSPECT) as Inspection;
        if (repeated.text !== rendered.text) note("renderWidget must replace previous content on repeated calls");
        repeated.errors.forEach(note);
      } catch (error) {
        note(`render: ${String(error)}`);
      }
    }
    return {
      size: files.size, viewport, root: inspected.root, syntaxError, errors,
      text: inspected.text.slice(0, 2000), extractedData,
      screenshotBytes: Math.floor(base64.length * 3 / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0),
      screenshotBase64: base64,
    };
  } finally {
    await context.close();
  }
}
