#!/usr/bin/env node

/**
 * Static site source reconstruction CLI.
 *
 * Reads HTML, JS, and CSS files from a directory (typically deobfuscated output)
 * and reconstructs an approximate framework source project.
 *
 * Usage:
 *   npm run reconstruct:site -- <input-dir> [output-dir]
 *   npm run reconstruct:site -- <input-dir> [output-dir] --force
 */

const fs = require('node:fs/promises');
const path = require('node:path');

function printUsage() {
  console.error(
    'Usage: npm run reconstruct:site -- <input-dir> [output-dir] [--force]',
  );
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function walkDirectory(rootDir) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

async function ensureParentDirectory(targetPath) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
}

function isHtml(p) {
  return /\.html?$/i.test(p);
}

function isJavaScript(p) {
  return /\.[cm]?jsx?$/i.test(p);
}

function isCss(p) {
  return /\.css$/i.test(p);
}

// ── Inline the reconstruction logic for CJS compatibility ──
// This mirrors static-site-reconstruction.ts but in plain JS.

function detectFramework(htmlFiles) {
  const evidence = [];
  let name = 'unknown';
  let version = null;
  let confidence = 'low';

  for (const file of htmlFiles) {
    const astroMeta =
      /<meta\s[^>]*content\s*=\s*["']?Astro\s+v?([\d.]+)["']?[^>]*>/i.exec(
        file.content,
      );
    if (astroMeta) {
      name = 'astro';
      version = astroMeta[1] || null;
      confidence = 'high';
      evidence.push(
        `<meta name="generator" content="Astro v${version}"> in ${file.path}`,
      );
    }
    if (/<astro-island\b/i.test(file.content)) {
      evidence.push(`<astro-island> custom element in ${file.path}`);
      if (name === 'unknown') {
        name = 'astro';
        confidence = 'high';
      }
    }
    if (/\/_next\//.test(file.content) && name === 'unknown') {
      name = 'nextjs';
      confidence = 'high';
      evidence.push(`/_next/ asset paths in ${file.path}`);
    }
    if (/\/_nuxt\//.test(file.content) && name === 'unknown') {
      name = 'nuxt';
      confidence = 'high';
      evidence.push(`/_nuxt/ asset paths in ${file.path}`);
    }
    if (/__sveltekit\//.test(file.content) && name === 'unknown') {
      name = 'sveltekit';
      confidence = 'high';
      evidence.push(`__sveltekit/ paths in ${file.path}`);
    }
  }

  return { name, version, confidence, evidence };
}

function extractAttr(attrs, attrName) {
  const regex = new RegExp(
    `${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  );
  const m = regex.exec(attrs);
  return m?.[1] ?? m?.[2] ?? m?.[3] ?? null;
}

function extractIslands(html) {
  const islands = [];
  const regex = /<astro-island\s+([^>]+?)>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const attrs = m[1];
    let componentName = extractAttr(attrs, 'component-export') || 'Unknown';
    const componentUrl = extractAttr(attrs, 'component-url') || '';
    // If export is "default", derive a name from the URL
    if (componentName === 'default' && componentUrl) {
      const urlBase = componentUrl.split('/').pop()?.split('.')[0] || 'Unknown';
      // Convert camelCase/kebab to PascalCase
      componentName = urlBase
        .replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
        .replace(/^\w/, (c) => c.toUpperCase());
    }
    const client = extractAttr(attrs, 'client') || 'load';
    const rendererUrl = extractAttr(attrs, 'renderer-url') || '';
    let rendererFramework = 'unknown';
    if (/react/i.test(rendererUrl) || /client\./.test(rendererUrl))
      rendererFramework = 'react';
    islands.push({
      componentName,
      componentUrl,
      rendererFramework,
      hydrationDirective: client,
    });
  }
  return islands;
}

function extractRoutes(htmlFiles) {
  return htmlFiles
    .filter((f) => f.path.endsWith('.html'))
    .filter((f) => !f.path.includes('partytown'))
    .map((file) => {
      let route = file.path.replace(/\\/g, '/');
      if (route === 'index.html') {
        route = '/';
      } else if (route.endsWith('/index.html')) {
        route = route.slice(0, -'/index.html'.length);
        if (!route.startsWith('/')) route = `/${route}`;
      } else if (route.endsWith('.html')) {
        route = route.slice(0, -'.html'.length);
        if (!route.startsWith('/')) route = `/${route}`;
      }
      if (!route.startsWith('/')) route = `/${route}`;

      const titleMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(file.content);
      const title = titleMatch?.[1]?.trim() || null;

      const meta = {};
      const metaRegex = /<meta\s+([^>]+?)>/gi;
      let mm;
      while ((mm = metaRegex.exec(file.content)) !== null) {
        const nameM =
          /(?:name|property)\s*=\s*["']?([^"'\s>]+)["']?/i.exec(mm[1]);
        const contentM = /content\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(mm[1]);
        const contentVal = contentM?.[1] ?? contentM?.[2] ?? contentM?.[3];
        if (nameM?.[1] && contentVal) meta[nameM[1]] = contentVal;
      }

      const linkedScripts = [];
      const scriptRegex =
        /<script\s+[^>]*src\s*=\s*["']?([^"'\s>]+)["']?[^>]*>/gi;
      let sm;
      while ((sm = scriptRegex.exec(file.content)) !== null) {
        if (sm[1]) linkedScripts.push(sm[1]);
      }

      const linkedStylesheets = [];
      const cssRegex =
        /<link\s+[^>]*href\s*=\s*["']?([^"'\s>]+\.css[^"'\s>]*)["']?[^>]*>/gi;
      let cm;
      while ((cm = cssRegex.exec(file.content)) !== null) {
        if (cm[1]) linkedStylesheets.push(cm[1]);
      }

      const inlineScripts = [];
      const inlineRegex =
        /<script(?:\s+type\s*=\s*["']?module["']?)?[^>]*>([^<]+)<\/script>/gi;
      let im;
      while ((im = inlineRegex.exec(file.content)) !== null) {
        if (/\bsrc\s*=/i.test(im[0])) continue;
        const c = im[1]?.trim();
        if (c) inlineScripts.push(c);
      }

      const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(file.content);
      const bodyContent = bodyMatch?.[1]?.trim() || '';

      return {
        filePath: file.path,
        route,
        title,
        metaTags: meta,
        inlineScripts,
        linkedScripts,
        linkedStylesheets,
        componentIslands: extractIslands(file.content),
        bodyContent,
      };
    });
}

function extractLayoutElements(routes, htmlFiles) {
  const firstHtml =
    htmlFiles.find((f) => f.path.endsWith('index.html'))?.content || '';
  const headMatch = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(firstHtml);
  const headContent = headMatch?.[1] || '';

  const fontPreloads = [];
  const fontRegex =
    /<link\s+[^>]*href\s*=\s*["']?([^"'\s>]+\.woff2[^"'\s>]*)["']?[^>]*>/gi;
  let fm;
  while ((fm = fontRegex.exec(headContent)) !== null) {
    if (fm[1]) fontPreloads.push(fm[1]);
  }

  const integrations = [];
  if (/googletagmanager\.com|gtag/i.test(firstHtml)) {
    const gaId = /G-[A-Z0-9]+/.exec(firstHtml);
    integrations.push({
      name: 'google-analytics',
      evidence: 'Google Analytics detected',
      inferredPackage: null,
      config: gaId?.[0] || null,
    });
  }
  if (/partytown/i.test(firstHtml)) {
    integrations.push({
      name: 'partytown',
      evidence: 'Partytown detected',
      inferredPackage: '@astrojs/partytown',
      config: null,
    });
  }
  if (/astro-view-transitions|ClientRouter/i.test(firstHtml)) {
    integrations.push({
      name: 'view-transitions',
      evidence: 'View Transitions detected',
      inferredPackage: null,
      config: null,
    });
  }

  const navMatch = /<header[^>]*>([\s\S]*?)<\/header>/i.exec(firstHtml);
  const footerMatch = /<footer[^>]*>([\s\S]*?)<\/footer>/i.exec(firstHtml);

  const inlineHeadScripts = [];
  for (const route of routes.slice(0, 1)) {
    for (const script of route.inlineScripts) {
      if (script.length < 2000) inlineHeadScripts.push(script);
    }
  }

  return {
    headElements: headContent,
    navigation: navMatch?.[0] || null,
    footer: footerMatch?.[0] || null,
    fontPreloads,
    thirdPartyIntegrations: integrations,
    inlineHeadScripts,
  };
}

function extractStyles(htmlFiles, cssFiles) {
  const customProperties = {};
  const fontFamilies = [];
  let cssContent = '';

  for (const css of cssFiles) cssContent += css.content + '\n';
  for (const html of htmlFiles) {
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let sm;
    while ((sm = styleRegex.exec(html.content)) !== null) {
      if (sm[1]) cssContent += sm[1] + '\n';
    }
  }

  const propRegex = /--([\w-]+)\s*:\s*([^;]+)/g;
  let pm;
  while ((pm = propRegex.exec(cssContent)) !== null) {
    if (pm[1] && pm[2]) customProperties[`--${pm[1]}`] = pm[2].trim();
  }

  const seenFonts = new Set();
  const ffRegex = /font-family\s*:\s*["']?([^;"'}\n]+)/gi;
  let ffm;
  while ((ffm = ffRegex.exec(cssContent)) !== null) {
    const font = ffm[1]?.trim();
    if (font && !seenFonts.has(font)) {
      seenFonts.add(font);
      fontFamilies.push(font);
    }
  }

  return { customProperties, fontFamilies, cssContent };
}

function buildReconstruction(htmlFiles, jsFiles, cssFiles) {
  const framework = detectFramework(htmlFiles);
  const routes = extractRoutes(htmlFiles);
  const layout = extractLayoutElements(routes, htmlFiles);
  const styles = extractStyles(htmlFiles, cssFiles);

  if (framework.name !== 'astro') {
    return {
      framework,
      routes,
      outputFiles: [],
      notes: [
        `Framework ${framework.name} detected but full reconstruction is only supported for Astro currently.`,
      ],
    };
  }

  // ── Build Astro scaffold ──
  const outputFiles = [];

  const hasReact = routes.some((r) =>
    r.componentIslands.some((i) => i.rendererFramework === 'react'),
  );
  const hasTailwind =
    styles.cssContent.includes('tailwind') ||
    routes.some((r) => /\bflex\b.*\bitems-center\b/i.test(r.bodyContent));
  const hasPartytown = layout.thirdPartyIntegrations.some(
    (i) => i.name === 'partytown',
  );
  const hasSitemap = layout.headElements.includes('sitemap');
  const hasViewTransitions = layout.thirdPartyIntegrations.some(
    (i) => i.name === 'view-transitions',
  );
  const gaConfig = layout.thirdPartyIntegrations.find(
    (i) => i.name === 'google-analytics',
  );

  const indexRoute = routes.find((r) => r.route === '/');
  const siteUrl =
    indexRoute?.metaTags?.['og:url'] ||
    indexRoute?.metaTags?.['twitter:url'] ||
    'https://example.com';
  const siteTitle = indexRoute?.title || 'Recovered Site';
  const siteDescription =
    indexRoute?.metaTags?.['description'] ||
    indexRoute?.metaTags?.['og:description'] ||
    '';

  // astro.config.mjs
  const integrationImports = [];
  const integrations = [];
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
    integrations.push(
      gaConfig
        ? `partytown({ config: { forward: ['dataLayer.push'] } })`
        : 'partytown()',
    );
  }
  if (hasSitemap) {
    integrationImports.push("import sitemap from '@astrojs/sitemap';");
    integrations.push('sitemap()');
  }

  outputFiles.push({
    path: 'astro.config.mjs',
    content: [
      "import { defineConfig } from 'astro/config';",
      ...integrationImports,
      '',
      'export default defineConfig({',
      `  site: '${siteUrl}',`,
      `  integrations: [${integrations.join(', ')}],`,
      '});',
      '',
    ].join('\n'),
  });

  // tsconfig.json
  outputFiles.push({
    path: 'tsconfig.json',
    content: JSON.stringify({ extends: 'astro/tsconfigs/strict' }, null, 2) + '\n',
  });

  // tailwind.config.mjs
  if (hasTailwind) {
    const colorEntries = Object.entries(styles.customProperties)
      .filter(([p]) =>
        /color|bg|text|border|accent|primary|secondary|foreground|background|muted/i.test(
          p,
        ),
      )
      .map(
        ([p, v]) =>
          `        '${p.replace(/^--/, '').replace(/[^a-zA-Z0-9]+/g, '-')}': 'var(${p})',`,
      )
      .join('\n');

    outputFiles.push({
      path: 'tailwind.config.mjs',
      content: [
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
      ].join('\n'),
    });
  }

  // src/styles/global.css
  if (styles.cssContent.trim()) {
    outputFiles.push({
      path: 'src/styles/global.css',
      content: styles.cssContent.trim() + '\n',
    });
  }

  // src/layouts/Layout.astro
  const layoutImports = ["import '../styles/global.css';"];
  if (hasViewTransitions)
    layoutImports.push("import { ClientRouter } from 'astro:transitions';");
  if (layout.navigation)
    layoutImports.push("import Header from '../components/Header.astro';");
  if (layout.footer)
    layoutImports.push("import Footer from '../components/Footer.astro';");

  const fontLinks = layout.fontPreloads
    .map(
      (href) =>
        `    <link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin="anonymous" />`,
    )
    .join('\n');

  outputFiles.push({
    path: 'src/layouts/Layout.astro',
    content: [
      '---',
      ...layoutImports,
      '',
      'interface Props { title?: string; description?: string; }',
      `const { title = '${siteTitle.replace(/'/g, "\\'")}', description = '${siteDescription.replace(/'/g, "\\'")}' } = Astro.props;`,
      '---',
      '',
      '<!doctype html>',
      '<html lang="en" class="scroll-smooth">',
      '  <head>',
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      '    <title>{title}</title>',
      '    <meta name="description" content={description} />',
      framework.version
        ? `    <meta name="generator" content="Astro v${framework.version}" />`
        : '    <meta name="generator" content={Astro.generator} />',
      fontLinks,
      hasViewTransitions ? '    <ClientRouter />' : '',
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
    ]
      .filter((l) => l !== '')
      .join('\n'),
  });

  // Header
  if (layout.navigation) {
    outputFiles.push({
      path: 'src/components/Header.astro',
      content: `---\n// Extracted navigation header\n---\n\n${layout.navigation}\n`,
    });
  }

  // Footer
  if (layout.footer) {
    outputFiles.push({
      path: 'src/components/Footer.astro',
      content: `---\n// Extracted footer\n---\n\n${layout.footer}\n`,
    });
  }

  // Component island stubs
  const seenComponents = new Set();
  for (const route of routes) {
    for (const island of route.componentIslands) {
      if (seenComponents.has(island.componentName)) continue;
      seenComponents.add(island.componentName);
      const ext = island.rendererFramework === 'react' ? 'tsx' : 'ts';
      outputFiles.push({
        path: `src/components/${island.componentName}.${ext}`,
        content: [
          `// Recovered component stub for ${island.componentName}`,
          `// Original bundle: ${island.componentUrl}`,
          `// Hydration: client:${island.hydrationDirective}`,
          '',
          island.rendererFramework === 'react'
            ? `export default function ${island.componentName}() {\n  return <div data-component="${island.componentName}">TODO: reconstruct ${island.componentName}</div>;\n}`
            : `export default function ${island.componentName}() {\n  return null;\n}`,
          '',
        ].join('\n'),
      });
    }
  }

  // Pages
  for (const route of routes) {
    let pagePath;
    if (route.route === '/')
      pagePath = 'src/pages/index.astro';
    else
      pagePath = `src/pages/${route.route.replace(/^\//, '').replace(/\/$/, '')}/index.astro`;

    let body = route.bodyContent;
    if (layout.navigation) body = body.replace(layout.navigation, '');
    if (layout.footer) body = body.replace(layout.footer, '');
    body = body
      .replace(/<astro-island[\s\S]*?<\/astro-island>/gi, '')
      .replace(/<style>astro-island[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .trim();

    // Determine correct relative import path
    const depth = pagePath.split('/').length - 2; // relative to src/
    const layoutImport =
      depth <= 2
        ? "import Layout from '../../layouts/Layout.astro';"
        : `import Layout from '${'../'.repeat(depth - 1)}layouts/Layout.astro';`;

    const titleProp = route.title ? ` title="${route.title}"` : '';
    outputFiles.push({
      path: pagePath,
      content: [
        '---',
        layoutImport,
        '---',
        '',
        `<Layout${titleProp}>`,
        body || `  <!-- Page content for ${route.route} -->`,
        '</Layout>',
        '',
      ].join('\n'),
    });
  }

  // Theme script
  const themeScript = layout.inlineHeadScripts.find((s) =>
    /theme|dark|localStorage/i.test(s),
  );
  if (themeScript) {
    outputFiles.push({
      path: 'src/scripts/theme.js',
      content: themeScript + '\n',
    });
  }

  // package.json
  const deps = { astro: framework.version ? `^${framework.version}` : '*' };
  if (hasReact) {
    Object.assign(deps, {
      '@astrojs/react': '*',
      react: '*',
      'react-dom': '*',
      '@types/react': '*',
      '@types/react-dom': '*',
    });
  }
  if (hasTailwind) Object.assign(deps, { '@astrojs/tailwind': '*', tailwindcss: '*' });
  if (hasPartytown) deps['@astrojs/partytown'] = '*';
  if (hasSitemap) deps['@astrojs/sitemap'] = '*';

  for (const route of routes) {
    for (const island of route.componentIslands) {
      if (/three/i.test(island.componentUrl)) {
        deps['three'] = '*';
        deps['@react-three/fiber'] = '*';
      }
    }
    if (/lucide/i.test(route.bodyContent)) deps['lucide-react'] = '*';
  }

  const sortedDeps = Object.fromEntries(
    Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)),
  );

  let pkgName;
  try {
    pkgName = new URL(siteUrl).hostname.replace(/^www\./, '').replace(/\./g, '-');
  } catch {
    pkgName = 'recovered-site';
  }

  outputFiles.push({
    path: 'package.json',
    content:
      JSON.stringify(
        {
          name: pkgName,
          version: '0.0.0-recovered',
          private: true,
          type: 'module',
          scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' },
          dependencies: sortedDeps,
        },
        null,
        2,
      ) + '\n',
  });

  // README.md
  const notes = [
    `Framework: ${framework.name} v${framework.version || 'unknown'} (${framework.confidence} confidence)`,
    `Detected ${routes.length} page routes`,
    `Found ${routes.reduce((n, r) => n + r.componentIslands.length, 0)} component islands`,
    `Identified ${layout.thirdPartyIntegrations.length} third-party integrations`,
    `Extracted ${Object.keys(styles.customProperties).length} CSS custom properties`,
    'Component island stubs need manual reconstruction from deobfuscated JS bundles.',
    'CSS custom properties were extracted but Tailwind utility classes cannot be fully recovered.',
  ];

  outputFiles.push({
    path: 'README.md',
    content: [
      `# ${siteTitle}`,
      '',
      'This project was reconstructed from static site build output.',
      '',
      '## Getting Started',
      '',
      '```bash',
      'npm install',
      'npm run dev',
      '```',
      '',
      '## Recovery Notes',
      '',
      ...notes.map((n) => `- ${n}`),
      '',
    ].join('\n'),
  });

  return { framework, routes, outputFiles, notes };
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const positional = args.filter((a) => a !== '--force');
  const inputDir = positional[0];

  if (!inputDir) {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const absoluteInputDir = path.resolve(inputDir);
  const outputDir =
    positional[1] ?? `${absoluteInputDir.replace(/[\\/]+$/, '')}-reconstructed`;
  const absoluteOutputDir = path.resolve(outputDir);

  if (!(await pathExists(absoluteInputDir))) {
    console.error(`Input directory not found: ${absoluteInputDir}`);
    process.exitCode = 1;
    return;
  }

  if (await pathExists(absoluteOutputDir)) {
    if (!force) {
      console.error(
        `Output directory already exists: ${absoluteOutputDir}\nRe-run with --force to overwrite.`,
      );
      process.exitCode = 1;
      return;
    }
    await fs.rm(absoluteOutputDir, { recursive: true, force: true });
  }

  const allFiles = await walkDirectory(absoluteInputDir);
  const htmlFiles = [];
  const jsFiles = [];
  const cssFiles = [];

  for (const absPath of allFiles) {
    const rel = path.relative(absoluteInputDir, absPath).replace(/\\/g, '/');
    if (rel === 'deobfuscation-report.json') continue;

    try {
      const content = await fs.readFile(absPath, 'utf8');
      const entry = { path: rel, content };

      if (isHtml(rel)) htmlFiles.push(entry);
      else if (isJavaScript(rel)) jsFiles.push(entry);
      else if (isCss(rel)) cssFiles.push(entry);
    } catch {
      // skip binary files
    }
  }

  const result = buildReconstruction(htmlFiles, jsFiles, cssFiles);

  for (const file of result.outputFiles) {
    const outputPath = path.join(absoluteOutputDir, file.path);
    await ensureParentDirectory(outputPath);
    await fs.writeFile(outputPath, file.content, 'utf8');
  }

  // Also copy public assets (favicon, images, etc.)
  for (const absPath of allFiles) {
    const rel = path.relative(absoluteInputDir, absPath).replace(/\\/g, '/');
    if (/favicon/i.test(rel) || /robots\.txt$/i.test(rel)) {
      const outputPath = path.join(absoluteOutputDir, 'public', path.basename(rel));
      await ensureParentDirectory(outputPath);
      await fs.copyFile(absPath, outputPath);
    }
  }

  // Write reconstruction report
  const report = {
    inputDir: absoluteInputDir,
    outputDir: absoluteOutputDir,
    processedAt: new Date().toISOString(),
    framework: result.framework,
    routeCount: result.routes.length,
    outputFileCount: result.outputFiles.length,
    routes: result.routes.map((r) => ({
      route: r.route,
      title: r.title,
      islands: r.componentIslands.length,
    })),
    notes: result.notes,
  };

  await fs.writeFile(
    path.join(absoluteOutputDir, 'reconstruction-report.json'),
    JSON.stringify(report, null, 2) + '\n',
    'utf8',
  );

  console.log(
    [
      `Framework: ${result.framework.name}${result.framework.version ? ` v${result.framework.version}` : ''} (${result.framework.confidence}).`,
      `Reconstructed ${result.outputFiles.length} files from ${result.routes.length} routes.`,
      `Output: ${absoluteOutputDir}`,
    ].join(' '),
  );
}

module.exports = { buildReconstruction };

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
