window.renderDiscoveryOpportunityFeed = function renderDiscoveryOpportunityFeed(feed) {
  const container = document.getElementById('discoveryOpportunityFeed');
  if (!container) return;

  const groups = Array.isArray(feed?.groups) ? feed.groups : [];
  if (groups.length === 0) {
    container.innerHTML = '<div class="text-center text-muted">No grouped opportunities yet.</div>';
    return;
  }

  container.innerHTML = groups.map((group) => {
    const items = Array.isArray(group.items) ? group.items : [];
    const body = items.length === 0
      ? '<div class="text-sm text-muted">No opportunities in this group yet.</div>'
      : items.map((item) => {
        const shortAddr = item.address ? `${item.address.slice(0, 6)}...${item.address.slice(-4)}` : '—';
        const trustBadge = `<span class="win-badge">${String(item.trustLevel || 'provisional').toUpperCase()}</span>`;
        const category = item.focusCategory ? `<span class="win-badge">${String(item.focusCategory).replace('-', ' ')}</span>` : '';
        return `
          <div class="discovery-card" tabindex="0" role="button" aria-label="Open discovery wallet ${shortAddr}" onclick="openWalletDetail('${item.address}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();openWalletDetail('${item.address}')}">
            <div class="discovery-card-header">
              <strong>${shortAddr}</strong>
              <div class="flex-row gap-4">${trustBadge}${category}</div>
            </div>
            <div class="text-sm">${item.whySurfaced || 'Discovery candidate'}</div>
            <div class="text-xs text-muted" style="margin-top:6px;">
              Sharp score: ${Number(item.whaleScore || 0).toFixed(1)} • 7d volume: $${Number(item.volume7d || 0).toLocaleString()}
            </div>
          </div>
        `;
      }).join('');

    return `
      <section class="discovery-card-group">
        <div class="discovery-card-group-title">${group.title}</div>
        <div class="discovery-card-grid">${body}</div>
      </section>
    `;
  }).join('');
};
