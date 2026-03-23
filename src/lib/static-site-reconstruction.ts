import type {
  ComponentIsland,
  DetectedFramework,
  ExtractedLayoutElements,
  ExtractedRoute,
  ExtractedStyles,
  JsBundleRole,
  ReconstructedManifest,
  ReconstructionOutputFile,
  StaticSiteFramework,
  StaticSiteReconstruction,
  ThirdPartyIntegration,
} from '../types/analysis';

interface FileEntry {
  path: string;
  content: string;
}

// ── Framework detection ──

export function detectFramework(htmlFiles: FileEntry[]): DetectedFramework {
  const evidence: string[] = [];
  let name: StaticSiteFramework = 'unknown';
  let version: string | null = null;
  let confidence: 'high' | 'medium' | 'low' = 'low';

  for (const file of htmlFiles) {
    const astroMeta = /<meta\s[^>]*content\s*=\s*["']?Astro\s+v?([\d.]+)["']?[^>]*>/i.exec(
      file.content,
    );
    if (astroMeta) {
      name = 'astro';
      version = astroMeta[1] ?? null;
      confidence = 'high';
      evidence.push(`<meta name="generator" content="Astro v${version}"> in ${file.path}`);
    }

    if (/<astro-island\b/i.test(file.content)) {
      evidence.push(`<astro-island> custom element in ${file.path}`);
      if (name === 'unknown') {
        name = 'astro';
        confidence = 'high';
      }
    }

    if (/\/_next\//.test(file.content)) {
      if (name === 'unknown') {
        name = 'nextjs';
        confidence = 'high';
        evidence.push(`/_next/ asset paths in ${file.path}`);
      }
    }

    if (/\/__gatsby\//.test(file.content) || /gatsby-/i.test(file.content)) {
      if (name === 'unknown') {
        name = 'gatsby';
        confidence = 'medium';
        evidence.push(`Gatsby patterns in ${file.path}`);
      }
    }

    if (/\/_nuxt\//.test(file.content)) {
      if (name === 'unknown') {
        name = 'nuxt';
        confidence = 'high';
        evidence.push(`/_nuxt/ asset paths in ${file.path}`);
      }
    }

    if (/__sveltekit\//.test(file.content)) {
      if (name === 'unknown') {
        name = 'sveltekit';
        confidence = 'high';
        evidence.push(`__sveltekit/ paths in ${file.path}`);
      }
    }
  }

  return { name, version, confidence, evidence };
}

// ── Route extraction ──

export function extractRoutes(htmlFiles: FileEntry[]): ExtractedRoute[] {
  return htmlFiles
    .filter((f) => f.path.endsWith('.html'))
    .filter((f) => !f.path.includes('partytown'))
    .map((file) => {
      const route = filePathToRoute(file.path);
      const title = extractTag(file.content, 'title');
      const metaTags = extractMetaTags(file.content);
      const inlineScripts = extractInlineScripts(file.content);
      const linkedScripts = extractLinkedScripts(file.content);
      const linkedStylesheets = extractLinkedStylesheets(file.content);
      const componentIslands = extractIslands(file.content);
      const bodyContent = extractBodyContent(file.content);

      return {
        filePath: file.path,
        route,
        title,
        metaTags,
        inlineScripts,
        linkedScripts,
        linkedStylesheets,
        componentIslands,
        bodyContent,
      };
    });
}

function filePathToRoute(filePath: string): string {
  let route = filePath.replace(/\\/g, '/');
  if (route === 'index.html') {
    return '/';
  }
  if (route.endsWith('/index.html')) {
    route = route.slice(0, -'/index.html'.length);
  } else if (route.endsWith('.html')) {
    route = route.slice(0, -'.html'.length);
  }
  if (!route.startsWith('/')) {
    route = `/${route}`;
  }
  return route;
}

function extractTag(html: string, tag: string): string | null {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`, 'i');
  const match = regex.exec(html);
  return match?.[1]?.trim() ?? null;
}

function extractMetaTags(html: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const regex = /<meta\s+([^>]+?)>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1]!;
    const nameMatch = /(?:name|property)\s*=\s*["']?([^"'\s>]+)["']?/i.exec(attrs);
    const contentMatch = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const contentVal = contentMatch?.[1] ?? contentMatch?.[2] ?? contentMatch?.[3];
    if (nameMatch?.[1] && contentVal) {
      meta[nameMatch[1]] = contentVal;
    }
  }

  return meta;
}

function extractInlineScripts(html: string): string[] {
  const scripts: string[] = [];
  const regex = /<script(?:\s+type\s*=\s*["']?module["']?)?[^>]*>([^<]+)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[0]!;
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const content = match[1]?.trim();
    if (content) scripts.push(content);
  }

  return scripts;
}

function extractLinkedScripts(html: string): string[] {
  const scripts: string[] = [];
  const regex = /<script\s+[^>]*src\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    if (match[1]) scripts.push(match[1]);
  }

  return scripts;
}

function extractLinkedStylesheets(html: string): string[] {
  const sheets: string[] = [];
  const regex = /<link\s+[^>]*href\s*=\s*["']?([^"'\s>]+\.css[^"'\s>]*)["']?[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    if (match[1]) sheets.push(match[1]);
  }

  return sheets;
}

function extractIslands(html: string): ComponentIsland[] {
  const islands: ComponentIsland[] = [];
  const regex = /<astro-island\s+([^>]+?)>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    const attrs = match[1]!;
    let componentName =
      extractAttr(attrs, 'component-export') ?? 'Unknown';
    const componentUrl = extractAttr(attrs, 'component-url') ?? '';
    // If export is "default", derive name from the URL
    if (componentName === 'default' && componentUrl) {
      const urlBase = componentUrl.split('/').pop()?.split('.')[0] ?? 'Unknown';
      componentName = urlBase
        .replace(/[-_](\w)/g, (_: string, c: string) => c.toUpperCase())
        .replace(/^\w/, (c: string) => c.toUpperCase());
    }
    const client = extractAttr(attrs, 'client') ?? 'load';
    const rendererUrl = extractAttr(attrs, 'renderer-url') ?? '';

    let rendererFramework = 'unknown';
    if (/react/i.test(rendererUrl) || /client\./.test(rendererUrl)) {
      rendererFramework = 'react';
    } else if (/vue/i.test(rendererUrl)) {
      rendererFramework = 'vue';
    } else if (/svelte/i.test(rendererUrl)) {
      rendererFramework = 'svelte';
    }

    let props: Record<string, unknown> = {};
    const propsAttr = extractAttr(attrs, 'props');
    if (propsAttr) {
      try {
        const decoded = propsAttr
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&#x27;/g, "'")
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>');
        props = JSON.parse(decoded);
      } catch {
        // ignore parse errors
      }
    }

    islands.push({
      componentName,
      componentUrl,
      rendererFramework,
      hydrationDirective: client,
      props,
    });
  }

  return islands;
}

function extractAttr(attrs: string, name: string): string | null {
  const regex = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = regex.exec(attrs);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function extractBodyContent(html: string): string {
  const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  return bodyMatch?.[1]?.trim() ?? '';
}

// ── Layout extraction ──

export function extractLayoutElements(
  routes: ExtractedRoute[],
  htmlFiles: FileEntry[],
): ExtractedLayoutElements {
  const allLinkedScripts = new Set<string>();
  const allFontPreloads: string[] = [];
  const integrations: ThirdPartyIntegration[] = [];
  const inlineHeadScripts: string[] = [];

  const firstHtml = htmlFiles.find((f) => f.path.endsWith('index.html'))?.content ?? '';

  // Extract head content
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(firstHtml);
  const headContent = headMatch?.[1] ?? '';

  // Font preloads
  const fontRegex = /<link\s+[^>]*href\s*=\s*["']?([^"'\s>]+\.woff2[^"'\s>]*)["']?[^>]*>/gi;
  let fontMatch: RegExpExecArray | null;
  while ((fontMatch = fontRegex.exec(headContent)) !== null) {
    if (fontMatch[1]) allFontPreloads.push(fontMatch[1]);
  }

  // Collect all scripts referenced
  for (const route of routes) {
    for (const script of route.linkedScripts) {
      allLinkedScripts.add(script);
    }
  }

  // Detect third-party integrations
  if (/googletagmanager\.com|gtag/i.test(firstHtml)) {
    const gaIdMatch = /G-[A-Z0-9]+/.exec(firstHtml);
    integrations.push({
      name: 'google-analytics',
      evidence: 'Google Analytics script tag detected',
      inferredPackage: null,
      config: gaIdMatch?.[0] ?? null,
    });
  }

  if (/partytown/i.test(firstHtml)) {
    integrations.push({
      name: 'partytown',
      evidence: 'Partytown script and sandbox detected',
      inferredPackage: '@astrojs/partytown',
      config: null,
    });
  }

  if (/astro-view-transitions/i.test(firstHtml) || /ClientRouter/i.test(firstHtml)) {
    integrations.push({
      name: 'view-transitions',
      evidence: 'Astro View Transitions / ClientRouter detected',
      inferredPackage: null,
      config: null,
    });
  }

  // Extract navigation (first <header> or <nav> in body)
  const navMatch = /<header[^>]*>([\s\S]*?)<\/header>/i.exec(firstHtml);
  const navigation = navMatch?.[0] ?? null;

  // Extract footer
  const footerMatch = /<footer[^>]*>([\s\S]*?)<\/footer>/i.exec(firstHtml);
  const footer = footerMatch?.[0] ?? null;

  // Inline head scripts (theme, loading, etc.)
  for (const route of routes.slice(0, 1)) {
    for (const script of route.inlineScripts) {
      if (script.length < 2000 && !inlineHeadScripts.includes(script)) {
        inlineHeadScripts.push(script);
      }
    }
  }

  return {
    headElements: headContent,
    navigation,
    footer,
    fontPreloads: allFontPreloads,
    thirdPartyIntegrations: integrations,
    inlineHeadScripts,
  };
}

// ── Style extraction ──

export function extractStyles(
  htmlFiles: FileEntry[],
  cssFiles: FileEntry[],
): ExtractedStyles {
  const customProperties: Record<string, string> = {};
  const fontFamilies: string[] = [];
  let cssContent = '';

  for (const css of cssFiles) {
    cssContent += css.content + '\n';
  }

  // Also extract inline <style> blocks from HTML
  for (const html of htmlFiles) {
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let styleMatch: RegExpExecArray | null;
    while ((styleMatch = styleRegex.exec(html.content)) !== null) {
      if (styleMatch[1]) cssContent += styleMatch[1] + '\n';
    }
  }

  // Extract CSS custom properties
  const propRegex = /--([\w-]+)\s*:\s*([^;]+)/g;
  let propMatch: RegExpExecArray | null;
  while ((propMatch = propRegex.exec(cssContent)) !== null) {
    if (propMatch[1] && propMatch[2]) {
      customProperties[`--${propMatch[1]}`] = propMatch[2].trim();
    }
  }

  // Extract font families
  const fontFaceRegex = /font-family\s*:\s*["']?([^;"'}\n]+)/gi;
  let ffMatch: RegExpExecArray | null;
  const seenFonts = new Set<string>();
  while ((ffMatch = fontFaceRegex.exec(cssContent)) !== null) {
    const font = ffMatch[1]?.trim();
    if (font && !seenFonts.has(font)) {
      seenFonts.add(font);
      fontFamilies.push(font);
    }
  }

  return { customProperties, fontFamilies, cssContent };
}

// ── Bundle role classification ──

export function classifyBundleRoles(
  jsFiles: FileEntry[],
  routes: ExtractedRoute[],
  framework: DetectedFramework,
): JsBundleRole[] {
  const allLinkedScripts = new Map<string, string[]>();
  for (const route of routes) {
    for (const script of route.linkedScripts) {
      const normalized = script.replace(/^\//, '');
      if (!allLinkedScripts.has(normalized)) {
        allLinkedScripts.set(normalized, []);
      }
      allLinkedScripts.get(normalized)!.push(route.route);
    }
  }

  const islandUrls = new Set<string>();
  for (const route of routes) {
    for (const island of route.componentIslands) {
      islandUrls.add(island.componentUrl.replace(/^\//, ''));
    }
  }

  return jsFiles.map((file) => {
    const normalized = file.path.replace(/^\//, '');
    const linkedFromPages = allLinkedScripts.get(normalized) ?? [];

    let role: JsBundleRole['role'] = 'unknown';

    if (/ClientRouter/i.test(file.path)) {
      role = 'client-router';
    } else if (/theme/i.test(file.path)) {
      role = 'theme';
    } else if (islandUrls.has(normalized)) {
      role = 'component-hydration';
    } else if (/page\./i.test(file.path) || /client\./i.test(file.path)) {
      role = 'framework-runtime';
    } else if (
      framework.name === 'astro' &&
      (/index\.[A-Za-z0-9]+\.js$/i.test(file.path) ||
        /commonjsHelpers/i.test(file.path))
    ) {
      role = 'vendor';
    } else if (linkedFromPages.length > 0) {
      role = 'page-script';
    }

    return { path: file.path, role, linkedFromPages };
  });
}

// ── Astro scaffold builder ──

function buildAstroScaffold(
  framework: DetectedFramework,
  routes: ExtractedRoute[],
  layout: ExtractedLayoutElements,
  styles: ExtractedStyles,
  _bundleRoles: JsBundleRole[],
): { outputFiles: ReconstructionOutputFile[]; manifest: ReconstructedManifest } {
  const outputFiles: ReconstructionOutputFile[] = [];

  // Detect what integrations are needed
  const hasReact = routes.some((r) =>
    r.componentIslands.some((i) => i.rendererFramework === 'react'),
  );
  const hasTailwind =
    styles.cssContent.includes('tailwind') ||
    routes.some((r) => /\bflex\b.*\bitems-center\b/i.test(r.bodyContent));
  const hasPartytown = layout.thirdPartyIntegrations.some(
    (i) => i.name === 'partytown',
  );
  const hasSitemap =
    routes.some((r) => r.bodyContent.includes('sitemap')) ||
    layout.headElements.includes('sitemap');
  const hasViewTransitions = layout.thirdPartyIntegrations.some(
    (i) => i.name === 'view-transitions',
  );
  const gaConfig = layout.thirdPartyIntegrations.find(
    (i) => i.name === 'google-analytics',
  );

  // Determine site URL from meta tags
  const indexRoute = routes.find((r) => r.route === '/');
  const siteUrl =
    indexRoute?.metaTags['og:url'] ??
    indexRoute?.metaTags['twitter:url'] ??
    'https://example.com';

  // ── astro.config.mjs ──
  const integrationImports: string[] = [];
  const integrations: string[] = [];

  if (hasReact) {
    integrationImports.push("import react from '@astrojs/react';");
    integrations.push('react()');
  }
  if (hasTailwind) {
    integrationImports.push("import tailwind from '@astrojs/tailwind';");
    integrations.push('tailwind()');
  }
  if (hasPartytown) {
    integrationImports.push("import partytown from '@astrojs/partytown';");
    const forwardConfig = gaConfig
      ? `partytown({ config: { forward: ['dataLayer.push'] } })`
      : 'partytown()';
    integrations.push(forwardConfig);
  }
  if (hasSitemap) {
    integrationImports.push("import sitemap from '@astrojs/sitemap';");
    integrations.push('sitemap()');
  }

  const astroConfig = [
    "import { defineConfig } from 'astro/config';",
    ...integrationImports,
    '',
    'export default defineConfig({',
    `  site: '${siteUrl}',`,
    `  integrations: [${integrations.join(', ')}],`,
    '});',
    '',
  ].join('\n');

  outputFiles.push({
    path: 'astro.config.mjs',
    generated: true,
    description: 'Generated Astro config with detected integrations.',
    content: astroConfig,
  });

  // ── tsconfig.json ──
  outputFiles.push({
    path: 'tsconfig.json',
    generated: true,
    description: 'Astro TypeScript config.',
    content: JSON.stringify(
      { extends: 'astro/tsconfigs/strict' },
      null,
      2,
    ) + '\n',
  });

  // ── tailwind.config.mjs ──
  if (hasTailwind) {
    const tailwindConfig = buildTailwindConfig(styles.customProperties);
    outputFiles.push({
      path: 'tailwind.config.mjs',
      generated: true,
      description: 'Generated Tailwind config with extracted CSS custom properties.',
      content: tailwindConfig,
    });
  }

  // ── src/styles/global.css ──
  const globalCss = buildGlobalCss(styles);
  outputFiles.push({
    path: 'src/styles/global.css',
    generated: true,
    description: 'Extracted global CSS with custom properties and font declarations.',
    content: globalCss,
  });

  // ── src/layouts/Layout.astro ──
  const layoutContent = buildAstroLayout(
    layout,
    indexRoute ?? routes[0],
    hasViewTransitions,
    hasTailwind,
    framework,
  );
  outputFiles.push({
    path: 'src/layouts/Layout.astro',
    generated: true,
    description: 'Base layout extracted from shared HTML structure across pages.',
    content: layoutContent,
  });

  // ── Component stubs for islands ──
  const seenComponents = new Set<string>();
  for (const route of routes) {
    for (const island of route.componentIslands) {
      const name = island.componentName;
      if (seenComponents.has(name)) continue;
      seenComponents.add(name);

      const ext = island.rendererFramework === 'react' ? 'tsx' : 'ts';
      const stub = buildComponentStub(island);
      outputFiles.push({
        path: `src/components/${name}.${ext}`,
        generated: true,
        description: `Component island stub for ${name} (client:${island.hydrationDirective}).`,
        content: stub,
      });
    }
  }

  // ── Header component ──
  if (layout.navigation) {
    outputFiles.push({
      path: 'src/components/Header.astro',
      generated: true,
      description: 'Shared navigation header extracted from page HTML.',
      content: buildAstroComponentWrapper('Header', layout.navigation),
    });
  }

  // ── Footer component ──
  if (layout.footer) {
    outputFiles.push({
      path: 'src/components/Footer.astro',
      generated: true,
      description: 'Shared footer extracted from page HTML.',
      content: buildAstroComponentWrapper('Footer', layout.footer),
    });
  }

  // ── Pages ──
  for (const route of routes) {
    const pagePath = routeToPagePath(route.route);
    let pageBody = route.bodyContent;

    // Strip out header and footer from page body (they're in the layout)
    if (layout.navigation) {
      pageBody = pageBody.replace(layout.navigation, '');
    }
    if (layout.footer) {
      pageBody = pageBody.replace(layout.footer, '');
    }

    // Strip astro-island wrappers and framework runtime
    pageBody = pageBody
      .replace(/<astro-island[\s\S]*?<\/astro-island>/gi, '')
      .replace(/<style>astro-island[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .trim();

    const pageContent = buildAstroPage(route, pageBody);
    outputFiles.push({
      path: pagePath,
      generated: true,
      description: `Page for route ${route.route}, extracted from ${route.filePath}.`,
      content: pageContent,
    });
  }

  // ── Theme script ──
  const themeScript = layout.inlineHeadScripts.find(
    (s) => /theme|dark|localStorage/i.test(s),
  );
  if (themeScript) {
    outputFiles.push({
      path: 'src/scripts/theme.js',
      generated: true,
      description: 'Theme toggle script extracted from inline HTML.',
      content: themeScript + '\n',
    });
  }

  // ── package.json ──
  const deps: Record<string, string> = {
    astro: framework.version ? `^${framework.version}` : '*',
  };
  const devDeps: Record<string, string> = {};

  if (hasReact) {
    deps['@astrojs/react'] = '*';
    deps['react'] = '*';
    deps['react-dom'] = '*';
    deps['@types/react'] = '*';
    deps['@types/react-dom'] = '*';
  }
  if (hasTailwind) {
    deps['@astrojs/tailwind'] = '*';
    deps['tailwindcss'] = '*';
  }
  if (hasPartytown) {
    deps['@astrojs/partytown'] = '*';
  }
  if (hasSitemap) {
    deps['@astrojs/sitemap'] = '*';
  }

  // Detect additional dependencies from island component URLs
  for (const route of routes) {
    for (const island of route.componentIslands) {
      if (/three/i.test(island.componentUrl)) {
        deps['three'] = '*';
        deps['@react-three/fiber'] = '*';
      }
    }
    // Detect from body content
    if (/lucide/i.test(route.bodyContent)) {
      deps['lucide-react'] = '*';
    }
  }

  const sortedDeps = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );
  const sortedDevDeps = Object.fromEntries(
    Object.entries(devDeps).sort(([a], [b]) => a.localeCompare(b)),
  );

  const manifest: ReconstructedManifest = {
    name: derivePackageName(siteUrl),
    version: '0.0.0-recovered',
    private: true,
    type: 'module',
    scripts: {
      dev: 'astro dev',
      build: 'astro build',
      preview: 'astro preview',
    },
    dependencies: sortedDeps,
    devDependencies: sortedDevDeps,
    peerDependencies: {},
  };

  outputFiles.push({
    path: 'package.json',
    generated: true,
    description: 'Synthesized package.json with detected Astro dependencies.',
    content: JSON.stringify(
      {
        name: manifest.name,
        version: manifest.version,
        private: manifest.private,
        type: manifest.type,
        scripts: manifest.scripts,
        dependencies: manifest.dependencies,
        devDependencies: Object.keys(manifest.devDependencies).length > 0
          ? manifest.devDependencies
          : undefined,
      },
      null,
      2,
    ) + '\n',
  });

  return { outputFiles, manifest };
}

// ── Helpers for scaffold generation ──

function buildTailwindConfig(customProperties: Record<string, string>): string {
  // Extract color-like custom properties into Tailwind theme
  const colors: Record<string, string> = {};
  for (const [prop] of Object.entries(customProperties)) {
    if (/color|bg|text|border|accent|primary|secondary|foreground|background|muted|destructive/i.test(prop)) {
      const name = prop.replace(/^--/, '').replace(/[^a-zA-Z0-9]+/g, '-');
      colors[name] = `var(${prop})`;
    }
  }

  const colorEntries = Object.entries(colors)
    .map(([k, v]) => `        '${k}': '${v}',`)
    .join('\n');

  return [
    "/** @type {import('tailwindcss').Config} */",
    'export default {',
    "  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}'],",
    '  darkMode: "class",',
    '  theme: {',
    '    extend: {',
    '      colors: {',
    colorEntries,
    '      },',
    '    },',
    '  },',
    '  plugins: [],',
    '};',
    '',
  ].join('\n');
}

function buildGlobalCss(styles: ExtractedStyles): string {
  const lines: string[] = [];

  // Group custom properties by context (:root, .dark, etc.)
  // For simplicity, output all properties under :root
  if (Object.keys(styles.customProperties).length > 0) {
    lines.push(':root {');
    for (const [prop, value] of Object.entries(styles.customProperties)) {
      lines.push(`  ${prop}: ${value};`);
    }
    lines.push('}');
    lines.push('');
  }

  // Include the raw CSS content (which includes the full extracted styles)
  if (styles.cssContent.trim()) {
    lines.push('/* Extracted from build output CSS */');
    lines.push(styles.cssContent.trim());
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

function buildAstroLayout(
  layout: ExtractedLayoutElements,
  indexRoute: ExtractedRoute | undefined,
  hasViewTransitions: boolean,
  _hasTailwind: boolean,
  framework: DetectedFramework,
): string {
  const imports: string[] = [];
  if (hasViewTransitions) {
    imports.push("import { ClientRouter } from 'astro:transitions';");
  }
  imports.push("import '../styles/global.css';");

  if (layout.navigation) {
    imports.push("import Header from '../components/Header.astro';");
  }
  if (layout.footer) {
    imports.push("import Footer from '../components/Footer.astro';");
  }

  const title = indexRoute?.title ?? 'Recovered Site';
  const description =
    indexRoute?.metaTags['description'] ??
    indexRoute?.metaTags['og:description'] ??
    '';

  const fontPreloadLinks = layout.fontPreloads
    .map(
      (href) =>
        `    <link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin="anonymous" />`,
    )
    .join('\n');

  const headSlot = [
    `    <meta charset="utf-8" />`,
    `    <meta name="viewport" content="width=device-width, initial-scale=1" />`,
    `    <title>{title}</title>`,
    description ? `    <meta name="description" content={description} />` : '',
    framework.version
      ? `    <meta name="generator" content="Astro v${framework.version}" />`
      : `    <meta name="generator" content={Astro.generator} />`,
    fontPreloadLinks,
    hasViewTransitions ? '    <ClientRouter />' : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    '---',
    ...imports,
    '',
    'interface Props {',
    '  title?: string;',
    '  description?: string;',
    '}',
    '',
    `const { title = '${title}', description = '${description.replace(/'/g, "\\'")}' } = Astro.props;`,
    '---',
    '',
    '<!doctype html>',
    '<html lang="en" class="scroll-smooth">',
    '  <head>',
    headSlot,
    '  </head>',
    '  <body>',
    layout.navigation ? '    <Header />' : '',
    '    <main>',
    '      <slot />',
    '    </main>',
    layout.footer ? '    <Footer />' : '',
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

function buildComponentStub(island: ComponentIsland): string {
  const name = island.componentName;
  if (island.rendererFramework === 'react') {
    return [
      `// Recovered component stub for ${name}`,
      `// Original bundle: ${island.componentUrl}`,
      `// Hydration: client:${island.hydrationDirective}`,
      '',
      `export default function ${name}() {`,
      `  return <div data-component="${name}">TODO: reconstruct ${name}</div>;`,
      '}',
      '',
    ].join('\n');
  }

  return [
    `// Recovered component stub for ${name}`,
    `// Original bundle: ${island.componentUrl}`,
    `// Hydration: client:${island.hydrationDirective}`,
    '',
    `export default function ${name}() {`,
    `  return null;`,
    '}',
    '',
  ].join('\n');
}

function buildAstroComponentWrapper(name: string, html: string): string {
  return [
    '---',
    `// Extracted ${name} component`,
    '---',
    '',
    html,
    '',
  ].join('\n');
}

function buildAstroPage(route: ExtractedRoute, body: string): string {
  const title = route.title;
  const titleProp = title ? ` title="${title}"` : '';

  return [
    '---',
    "import Layout from '../../layouts/Layout.astro';",
    '---',
    '',
    `<Layout${titleProp}>`,
    body || `  <!-- Page content for ${route.route} -->`,
    '</Layout>',
    '',
  ].join('\n');
}

function routeToPagePath(route: string): string {
  if (route === '/') return 'src/pages/index.astro';
  const segments = route.replace(/^\//, '').replace(/\/$/, '');
  return `src/pages/${segments}/index.astro`;
}

function derivePackageName(siteUrl: string): string {
  try {
    const hostname = new URL(siteUrl).hostname;
    return hostname.replace(/^www\./, '').replace(/\./g, '-');
  } catch {
    return 'recovered-site';
  }
}

// ── Main entry point ──

export function reconstructStaticSite(
  htmlFiles: FileEntry[],
  jsFiles: FileEntry[],
  cssFiles: FileEntry[],
): StaticSiteReconstruction {
  const framework = detectFramework(htmlFiles);
  const routes = extractRoutes(htmlFiles);
  const layout = extractLayoutElements(routes, htmlFiles);
  const styles = extractStyles(htmlFiles, cssFiles);
  const bundleRoles = classifyBundleRoles(jsFiles, routes, framework);

  const notes: string[] = [];

  if (framework.name === 'unknown') {
    notes.push(
      'Could not detect a specific static site framework. Output is a best-effort reconstruction.',
    );
  }

  let outputFiles: ReconstructionOutputFile[];
  let manifest: ReconstructedManifest;

  if (framework.name === 'astro') {
    const scaffold = buildAstroScaffold(
      framework,
      routes,
      layout,
      styles,
      bundleRoles,
    );
    outputFiles = scaffold.outputFiles;
    manifest = scaffold.manifest;
  } else {
    // For unsupported frameworks, produce minimal output
    notes.push(
      `Full source reconstruction is not yet supported for ${framework.name}. Only analysis metadata is provided.`,
    );
    outputFiles = [];
    manifest = {
      name: 'recovered-site',
      version: '0.0.0-recovered',
      private: true,
      type: 'module',
      scripts: {},
      dependencies: {},
      devDependencies: {},
      peerDependencies: {},
    };
  }

  notes.push(
    `Detected ${routes.length} page routes.`,
    `Found ${routes.reduce((n, r) => n + r.componentIslands.length, 0)} component islands across all pages.`,
    `Identified ${layout.thirdPartyIntegrations.length} third-party integrations.`,
    `Extracted ${Object.keys(styles.customProperties).length} CSS custom properties.`,
  );

  if (framework.name !== 'unknown') {
    notes.push(
      `Framework: ${framework.name}${framework.version ? ` v${framework.version}` : ''} (${framework.confidence} confidence).`,
    );
  }

  return {
    framework,
    routes,
    layout,
    styles,
    bundleRoles,
    outputFiles,
    manifest,
    notes,
  };
}
