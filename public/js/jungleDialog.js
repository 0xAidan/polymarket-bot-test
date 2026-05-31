/**
 * Jungle dialog system — drawers and toasts (replaces centered Win95 modals).
 * Assigns window.win95Dialog for backward compatibility with existing call sites.
 */

const jungleDialog = (() => {
  let toastStack = null;
  let activeDrawer = null;

  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const ensureToastStack = () => {
    if (toastStack) return toastStack;
    toastStack = document.createElement('div');
    toastStack.className = 'j-toast-stack';
    toastStack.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastStack);
    return toastStack;
  };

  const showToast = (message, variant = 'info', title = 'Ditto') => {
    const stack = ensureToastStack();
    const toast = document.createElement('div');
    toast.className = `j-toast j-toast-${variant}`;
    const titleEl = document.createElement('div');
    titleEl.className = 'j-toast-title';
    titleEl.textContent = title;
    const bodyEl = document.createElement('div');
    bodyEl.className = 'j-toast-body';
    bodyEl.textContent = message;
    toast.appendChild(titleEl);
    toast.appendChild(bodyEl);
    stack.appendChild(toast);
    window.setTimeout(() => toast.remove(), variant === 'error' ? 6000 : 4000);
    return Promise.resolve(true);
  };

  const closeDrawer = () => {
    if (!activeDrawer) return;
    activeDrawer.backdrop.remove();
    activeDrawer = null;
    document.body.classList.remove('j-drawer-open');
  };

  const openDrawer = (title, bodyHtml, buttons) => new Promise((resolve) => {
    closeDrawer();
    const backdrop = document.createElement('div');
    backdrop.className = 'j-drawer-backdrop';
    backdrop.setAttribute('aria-hidden', 'false');

    const drawer = document.createElement('aside');
    drawer.className = 'j-drawer';
    drawer.setAttribute('role', 'dialog');
    drawer.setAttribute('aria-modal', 'true');
    drawer.setAttribute('aria-label', title);

    const header = document.createElement('header');
    header.className = 'j-drawer-header';
    const heading = document.createElement('h2');
    heading.className = 'j-drawer-title';
    heading.textContent = title;
    header.appendChild(heading);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'j-btn j-btn-ghost';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.textContent = '×';
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'j-drawer-body';
    body.innerHTML = bodyHtml;

    const footer = document.createElement('footer');
    footer.className = 'j-drawer-footer';

    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      closeDrawer();
      resolve(value);
    };

    closeBtn.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(null);
    });

    buttons.forEach((btn, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = btn.primary ? 'j-btn j-btn-primary' : 'j-btn';
      button.textContent = btn.label;
      button.addEventListener('click', () => finish(btn.value));
      footer.appendChild(button);
      if (index === 0) window.setTimeout(() => button.focus(), 40);
    });

    const onKeyDown = (event) => {
      if (resolved) {
        document.removeEventListener('keydown', onKeyDown);
        return;
      }
      if (event.key === 'Escape') {
        finish(null);
        document.removeEventListener('keydown', onKeyDown);
      }
      if (event.key === 'Enter' && buttons.some((b) => b.primary)) {
        const primary = buttons.find((b) => b.primary);
        if (primary) finish(primary.value);
        document.removeEventListener('keydown', onKeyDown);
      }
    };
    document.addEventListener('keydown', onKeyDown);

    drawer.appendChild(header);
    drawer.appendChild(body);
    drawer.appendChild(footer);
    backdrop.appendChild(drawer);
    document.body.appendChild(backdrop);
    document.body.classList.add('j-drawer-open');
    activeDrawer = { backdrop };

    const focusable = drawer.querySelector('input, textarea, select, button');
    if (focusable) focusable.focus();
  });

  return {
    alert: (message, title = 'Ditto') => showToast(message, 'info', title),
    success: (message, title = 'Success') => showToast(message, 'success', title),
    error: (message, title = 'Error') => showToast(message, 'error', title),
    confirm: (message, title = 'Confirm') => openDrawer(
      title,
      `<p class="j-drawer-message">${escapeHtml(message).replace(/\n/g, '<br>')}</p>`,
      [
        { label: 'Confirm', value: true, primary: true },
        { label: 'Cancel', value: false },
      ],
    ),
    prompt: (message, defaultValue = '', title = 'Input') => {
      const inputId = `junglePrompt_${Date.now()}`;
      return openDrawer(
        title,
        `<p class="j-drawer-message">${escapeHtml(message).replace(/\n/g, '<br>')}</p>
         <label class="j-label" for="${inputId}">Value</label>
         <input id="${inputId}" class="j-input" value="${escapeHtml(defaultValue)}" />`,
        [
          { label: 'OK', value: '__OK__', primary: true },
          { label: 'Cancel', value: null },
        ],
      ).then((val) => {
        if (val !== '__OK__') return null;
        const input = document.getElementById(inputId);
        return input ? input.value : defaultValue;
      });
    },
    openDrawer,
    closeDrawer,
  };
})();

window.jungleDialog = jungleDialog;
window.win95Dialog = jungleDialog;
