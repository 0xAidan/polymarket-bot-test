/**
 * Terminal shell — nav, tab routing hooks, capabilities refresh.
 */

const SHELL_TABS = [
  'dashboard',
  'jungle-agents',
  'discovery',
  'wallets',
  'trading-wallets',
  'settings',
  'diagnostics',
];

const syncShellNav = (tabName) => {
  document.querySelectorAll('.j-nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
};

window.onShellTabActivated = (tabName) => {
  syncShellNav(tabName);
  if (tabName === 'jungle-agents' && typeof window.initJungleAgentsTab === 'function') {
    window.initJungleAgentsTab();
  }
};

document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.j-nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.tab;
      if (tab && typeof window.switchTab === 'function') {
        window.switchTab(tab);
      }
    });
  });

  const initial = document.querySelector('.j-nav-btn.active')?.dataset.tab || 'dashboard';
  syncShellNav(initial);
});
