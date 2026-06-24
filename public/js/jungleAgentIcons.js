/**
 * Distinctive roster icons for Jungle Agents (slug-keyed, model-label fallback).
 */

const escapeHtml = window.escapeHtml;

const JUNGLE_ICON_VIEWBOX = '0 0 24 24';

const wrapJungleIcon = (inner) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${JUNGLE_ICON_VIEWBOX}" fill="none" aria-hidden="true">${inner}</svg>`;

/** @type {Record<string, string>} */
const JUNGLE_AGENT_ICONS_BY_SLUG = {
  'howler-monkey-herald': wrapJungleIcon(`
    <circle cx="8.5" cy="8.5" r="3.25" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="15.5" cy="15.5" r="3.25" stroke="currentColor" stroke-width="1.6"/>
    <path d="M11.2 11.2l1.6 1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="8.5" cy="8.5" r="1" fill="currentColor"/>
    <circle cx="15.5" cy="15.5" r="1" fill="currentColor"/>
  `),
  'silverback-sage': wrapJungleIcon(`
    <path d="M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M6.5 17l1.8-5.5h7.4l1.8 5.5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M9.5 11.5V9.2L12 6.5l2.5 2.7v2.3" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="12" cy="5.2" r="1.1" fill="currentColor"/>
  `),
  'sabermetrician': wrapJungleIcon(`
    <rect x="5" y="8.5" width="14" height="7" rx="3.5" stroke="currentColor" stroke-width="1.6"/>
    <path d="M12 8.5v7" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="8.5" cy="12" r="1.35" fill="currentColor"/>
    <circle cx="15.5" cy="12" r="1.35" fill="currentColor"/>
  `),
  'veteran-backstop': wrapJungleIcon(`
    <path d="M12 4.5v3.2M12 16.3v3.2M4.5 12h3.2M16.3 12h3.2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M7.1 7.1l2.3 2.3M14.6 14.6l2.3 2.3M16.9 7.1l-2.3 2.3M9.4 14.6l-2.3 2.3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <circle cx="12" cy="12" r="2.2" fill="currentColor"/>
  `),
  'claude-slugger': wrapJungleIcon(`
    <rect x="5" y="7" width="6.5" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6"/>
    <rect x="12.5" y="7" width="6.5" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6" opacity="0.55"/>
    <path d="M8.2 10.5h0.01M15.7 10.5h0.01M8.2 13.5h0.01M15.7 13.5h0.01" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
  `),
  'deepseek-knuckler': wrapJungleIcon(`
    <circle cx="12" cy="7.5" r="2.2" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="7" cy="16" r="2.2" stroke="currentColor" stroke-width="1.6"/>
    <circle cx="17" cy="16" r="2.2" stroke="currentColor" stroke-width="1.6"/>
    <path d="M10.6 9.2L8.2 13.8M13.4 9.2l2.4 4.6M9.8 16h4.4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  `),
  'gemini-laser': wrapJungleIcon(`
    <path d="M9.5 6.5h5l-1 3h-3l-1-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M10 9.5h4v8.5c0 .8-.7 1.5-1.5 1.5h-1c-.8 0-1.5-.7-1.5-1.5V9.5z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <path d="M10.5 14h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.7"/>
  `),
  'mistral-closer': wrapJungleIcon(`
    <path d="M5 16l4.5-9 3 5.5L17.5 7 19 16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5 16h14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" opacity="0.45"/>
  `),
  king: wrapJungleIcon(`
    <path d="M4 17h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M6 17l2-5 4 3 4-3 2 5" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
    <circle cx="8" cy="10.5" r="1" fill="currentColor"/>
    <circle cx="12" cy="8.5" r="1" fill="currentColor"/>
    <circle cx="16" cy="10.5" r="1" fill="currentColor"/>
  `),
};

/** @type {Record<string, string>} */
const JUNGLE_AGENT_ICONS_BY_MODEL = {
  Gemini: JUNGLE_AGENT_ICONS_BY_SLUG['howler-monkey-herald'],
  'King Algorithm': JUNGLE_AGENT_ICONS_BY_SLUG['silverback-sage'],
  'Open Source': JUNGLE_AGENT_ICONS_BY_SLUG.sabermetrician,
  Claude: JUNGLE_AGENT_ICONS_BY_SLUG['veteran-backstop'],
  'Digital Twins': JUNGLE_AGENT_ICONS_BY_SLUG['claude-slugger'],
  DAO: JUNGLE_AGENT_ICONS_BY_SLUG['deepseek-knuckler'],
  'Randy Lahey': JUNGLE_AGENT_ICONS_BY_SLUG['gemini-laser'],
  HFT: JUNGLE_AGENT_ICONS_BY_SLUG['mistral-closer'],
  'KING Aggregator': JUNGLE_AGENT_ICONS_BY_SLUG.king,
};

/**
 * @param {{ slug?: string, modelLabel?: string }} agent
 * @returns {string | null}
 */
const getJungleAgentIconSvg = (agent) => {
  const slug = (agent.slug || '').trim();
  if (slug && JUNGLE_AGENT_ICONS_BY_SLUG[slug]) {
    return JUNGLE_AGENT_ICONS_BY_SLUG[slug];
  }
  const model = (agent.modelLabel || '').trim();
  if (model && JUNGLE_AGENT_ICONS_BY_MODEL[model]) {
    return JUNGLE_AGENT_ICONS_BY_MODEL[model];
  }
  return null;
};

/**
 * @param {{ avatarUrl?: string | null, displayName?: string, slug?: string, modelLabel?: string }} agent
 * @param {{ imgClass?: string, iconClass?: string, fallbackClass?: string }} [opts]
 */
const renderJungleAgentAvatar = (agent, opts = {}) => {
  const imgClass = opts.imgClass || 'j-agents-avatar-img';
  const iconClass = opts.iconClass || 'j-agents-avatar-icon';
  const fallbackClass = opts.fallbackClass || 'j-agents-avatar-fallback';
  const name = agent.displayName || 'Agent';
  const safeAvatarUrl = typeof window.sanitizeHttpsUrl === 'function'
    ? window.sanitizeHttpsUrl(agent.avatarUrl)
    : '';

  if (safeAvatarUrl) {
    return `<img src="${escapeHtml(safeAvatarUrl)}" alt="" class="${imgClass}" />`;
  }

  const iconSvg = getJungleAgentIconSvg(agent);
  if (iconSvg) {
    return `<span class="${iconClass}" aria-hidden="true">${iconSvg}</span>`;
  }

  return `<span class="${fallbackClass}">${escapeHtml(name.slice(0, 1))}</span>`;
};

window.getJungleAgentIconSvg = getJungleAgentIconSvg;
window.renderJungleAgentAvatar = renderJungleAgentAvatar;
