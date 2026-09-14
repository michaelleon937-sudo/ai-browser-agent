// integrations/website-gen.js
// Website Engine — Phase 1.
//
// Generates a speculative, non-published static website sample (index.html,
// styles.css, script.js) for a real-estate prospect from structured input.
// Every sample is marked SPECULATIVE_SAMPLE and is never automatically
// published, deployed, or sent anywhere. This module has no knowledge of the
// AI provider, the agent loop, or the browser — it is a pure generation
// utility, called by the tool executor in agent/index.js.
//
// Safety properties (see SKILL/audit notes):
//   - Output directory is server-generated (nanoid), never derived from
//     user-supplied strings, so path traversal via prospectName etc. is
//     structurally impossible.
//   - All user-supplied strings are HTML-escaped before being interpolated
//     into generated markup.
//   - Nothing is fabricated: testimonials, awards, stats, and property facts
//     are included only if explicitly provided; otherwise a clearly marked
//     placeholder is used.
//   - Generated JavaScript is written to disk only — it is never executed
//     server-side.


import fs from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config/index.js';


const STATUS = 'SPECULATIVE_SAMPLE';


// ── safety helpers ────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Server-generated ID only — never built from user input. Still validated
// defensively before ever touching the filesystem.
function makeSampleId() {
  return `website_${nanoid(12)}`;
}

const SAMPLE_ID_PATTERN = /^website_[A-Za-z0-9_-]{6,40}$/;

export function isValidSampleId(id) {
  return typeof id === 'string' && SAMPLE_ID_PATTERN.test(id);
}

// Resolves a sample's directory and guarantees the result is still inside
// the configured samples root (defense in depth against path traversal,
// even though isValidSampleId() already rejects '..' and '/').
export function resolveSampleDir(id) {
  if (!isValidSampleId(id)) {
    throw new Error('Invalid website sample id');
  }
  const root = path.resolve(config.storage.websiteSamplesDir);
  const dir = path.resolve(root, id);
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error('Resolved sample path escapes the samples root');
  }
  return dir;
}

function placeholder(label) {
  return `[${label} — add real content before using this sample]`;
}


// ── content builders ──────────────────────────────────────────────

function buildSections(opts) {
  const {
    prospectName, businessType, location, websiteGoal, brandStyle,
    services, propertyListings, contactInformation, callToAction, sections,
  } = opts;

  const name = escapeHtml(prospectName || placeholder('Business name'));
  const type = escapeHtml(businessType || 'Real Estate');
  const loc = escapeHtml(location || placeholder('Location'));
  const goal = escapeHtml(websiteGoal || '');
  const style = escapeHtml(brandStyle || 'modern');

  const svcList = Array.isArray(services) && services.length
    ? services.map((s) => `<li class="service-item">${escapeHtml(s)}</li>`).join('\n        ')
    : `<li class="service-item">${escapeHtml(placeholder('Add services offered'))}</li>`;

  const properties = Array.isArray(propertyListings) && propertyListings.length
    ? propertyListings.map((p) => `
        <div class="property-card">
          <div class="property-image-placeholder">${escapeHtml(placeholder('Property photo'))}</div>
          <h3>${escapeHtml(p.title || placeholder('Property title'))}</h3>
          <p class="property-meta">${escapeHtml(p.location || '')}${p.price ? ' · ' + escapeHtml(p.price) : ''}</p>
          <p>${escapeHtml(p.description || placeholder('Property description'))}</p>
        </div>`).join('\n')
    : `
        <div class="property-card">
          <div class="property-image-placeholder">${escapeHtml(placeholder('Property photo'))}</div>
          <h3>${escapeHtml(placeholder('Sample property — replace with real listing'))}</h3>
        </div>`;

  const contact = contactInformation || {};
  const contactBlock = `
        <p>${escapeHtml(contact.phone || placeholder('Phone number'))}</p>
        <p>${escapeHtml(contact.email || placeholder('Email address'))}</p>
        <p>${escapeHtml(contact.address || loc)}</p>`;

  const cta = escapeHtml(callToAction || 'Get in touch to learn more');

  const wantSections = Array.isArray(sections) && sections.length
    ? sections.map((s) => String(s).toLowerCase())
    : ['hero', 'about', 'services', 'properties', 'why', 'contact', 'cta', 'footer'];

  const has = (s) => wantSections.includes(s);

  const parts = [];

  if (has('hero')) {
    parts.push(`
  <header class="hero">
    <nav class="navbar">
      <div class="logo">${name}</div>
      <div class="nav-links"><a href="#about">About</a><a href="#services">Services</a><a href="#properties">Properties</a><a href="#contact">Contact</a></div>
    </nav>
    <div class="hero-content">
      <h1>${name}</h1>
      <p class="hero-subtitle">${type} in ${loc}</p>
      ${goal ? `<p class="hero-goal">${goal}</p>` : ''}
      <a href="#contact" class="btn-primary">${cta}</a>
    </div>
  </header>`);
  }

  if (has('about')) {
    parts.push(`
  <section id="about" class="section about">
    <h2>About ${name}</h2>
    <p>${escapeHtml(placeholder('Add a real company description here'))}</p>
  </section>`);
  }

  if (has('services')) {
    parts.push(`
  <section id="services" class="section services">
    <h2>Our Services</h2>
    <ul class="service-list">
        ${svcList}
    </ul>
  </section>`);
  }

  if (has('properties')) {
    parts.push(`
  <section id="properties" class="section properties">
    <h2>Featured Properties</h2>
    <p class="section-note">${escapeHtml(placeholder('Sample data — replace with verified listings'))}</p>
    <div class="property-grid">${properties}
    </div>
  </section>`);
  }

  if (has('why')) {
    parts.push(`
  <section class="section why-choose-us">
    <h2>Why Choose Us</h2>
    <p>${escapeHtml(placeholder('Add real differentiators — do not invent claims'))}</p>
  </section>`);
  }

  if (has('contact')) {
    parts.push(`
  <section id="contact" class="section contact">
    <h2>Contact Us</h2>
    ${contactBlock}
  </section>`);
  }

  if (has('cta')) {
    parts.push(`
  <section class="section cta-band">
    <h2>${cta}</h2>
    <a href="#contact" class="btn-primary">Contact Us</a>
  </section>`);
  }

  if (has('footer')) {
    parts.push(`
  <footer class="footer">
    <p>&copy; ${new Date().getFullYear()} ${name}. Speculative sample — not a live site.</p>
  </footer>`);
  }

  return { html: parts.join('\n'), style, name };
}

function buildHtml(opts) {
  const { html, name } = buildSections(opts);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${name} — Sample Website (Speculative)</title>
  <meta name="robots" content="noindex, nofollow">
  <link rel="stylesheet" href="styles.css">
</head>
<body>
  <div class="sample-banner">SPECULATIVE SAMPLE — generated concept, not a live or published website.</div>
${html}
  <script src="script.js"></script>
</body>
</html>
`;
}

function buildCss({ primaryColor, secondaryColor, brandStyle }) {
  const primary = /^#[0-9a-fA-F]{3,8}$/.test(primaryColor || '') ? primaryColor : '#1a2b4c';
  const secondary = /^#[0-9a-fA-F]{3,8}$/.test(secondaryColor || '') ? secondaryColor : '#c9a227';
  const roundness = brandStyle === 'sharp' ? '2px' : '12px';

  return `/* Generated by Website Engine (Phase 1) — speculative sample */
:root {
  --primary: ${primary};
  --secondary: ${secondary};
  --radius: ${roundness};
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1c1c1c; line-height: 1.6; }
.sample-banner { background: #b91c1c; color: #fff; text-align: center; font-size: 13px; padding: 8px; }
.navbar { display: flex; justify-content: space-between; align-items: center; padding: 20px 6%; }
.logo { font-weight: 800; font-size: 20px; color: var(--primary); }
.nav-links a { margin-left: 20px; text-decoration: none; color: #333; font-weight: 500; }
.hero { background: linear-gradient(135deg, var(--primary), #10151f); color: #fff; }
.hero-content { padding: 80px 6% 100px; max-width: 720px; }
.hero-content h1 { font-size: 44px; margin-bottom: 10px; }
.hero-subtitle { font-size: 18px; opacity: .85; margin-bottom: 18px; }
.hero-goal { opacity: .75; margin-bottom: 24px; }
.btn-primary { display: inline-block; background: var(--secondary); color: #111; padding: 13px 26px; border-radius: var(--radius); text-decoration: none; font-weight: 700; }
.section { padding: 60px 6%; max-width: 1100px; margin: 0 auto; }
.section h2 { font-size: 28px; margin-bottom: 18px; color: var(--primary); }
.section-note { font-size: 13px; color: #b91c1c; margin-bottom: 16px; }
.service-list { list-style: none; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px,1fr)); gap: 14px; }
.service-item { background: #f4f4f6; border-radius: var(--radius); padding: 16px; }
.property-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px,1fr)); gap: 20px; margin-top: 18px; }
.property-card { border: 1px solid #e5e5e5; border-radius: var(--radius); padding: 16px; }
.property-image-placeholder { background: #eee; border-radius: var(--radius); height: 140px; display: flex; align-items: center; justify-content: center; font-size: 12px; color: #888; margin-bottom: 10px; text-align: center; padding: 8px; }
.why-choose-us { background: #f9fafb; }
.cta-band { background: var(--primary); color: #fff; text-align: center; border-radius: var(--radius); }
.cta-band h2 { color: #fff; }
.footer { text-align: center; padding: 30px 6%; color: #888; font-size: 13px; }
@media (max-width: 700px) {
  .nav-links { display: none; }
  .hero-content h1 { font-size: 32px; }
}
`;
}

function buildJs() {
  return `// Generated by Website Engine (Phase 1) — speculative sample.
// No tracking, no external calls, no auto-submission. Smooth-scroll only.
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
});
`;
}


// ── public API ─────────────────────────────────────────────────────

/**
 * Generate a speculative real-estate website sample and write it to disk
 * under config.storage.websiteSamplesDir/<sampleId>/.
 *
 * @param {object} options
 * @param {string} [options.prospectName]
 * @param {string} [options.businessType]
 * @param {string} [options.location]
 * @param {string} [options.websiteGoal]
 * @param {string} [options.brandStyle]
 * @param {string} [options.primaryColor]
 * @param {string} [options.secondaryColor]
 * @param {string[]} [options.sections]
 * @param {string[]} [options.services]
 * @param {object[]} [options.propertyListings]
 * @param {object} [options.contactInformation]
 * @param {string} [options.callToAction]
 * @returns {{success:boolean, sampleId:string, status:string, files:string[], previewPath:string, generatedAt:string, dir:string}}
 */
export function generateWebsite(options = {}) {
  const sampleId = makeSampleId();
  const dir = resolveSampleDir(sampleId); // throws if somehow invalid — defense in depth

  fs.mkdirSync(dir, { recursive: true });

  const html = buildHtml(options);
  const css = buildCss(options);
  const js = buildJs();
  const generatedAt = new Date().toISOString();

  const metadata = {
    sampleId,
    status: STATUS,
    prospectName: options.prospectName || null,
    businessType: options.businessType || null,
    location: options.location || null,
    websiteGoal: options.websiteGoal || null,
    brandStyle: options.brandStyle || null,
    generatedAt,
    note: 'This is a speculative sample only. It has not been published or sent to anyone.',
  };

  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(dir, 'styles.css'), css, 'utf8');
  fs.writeFileSync(path.join(dir, 'script.js'), js, 'utf8');
  fs.writeFileSync(path.join(dir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf8');

  return {
    success: true,
    sampleId,
    status: STATUS,
    files: ['index.html', 'styles.css', 'script.js', 'metadata.json'],
    previewPath: `/website-samples/${sampleId}/`,
    generatedAt,
    dir,
  };
}
