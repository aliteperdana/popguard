'use strict';

const el = (id) => document.getElementById(id);

const view = {
  shield: el('shield'),
  stateTitle: el('state-title'),
  stateSub: el('state-sub'),
  statCount: el('stat-count'),
  action: el('action'),
  actionLabel: el('action-label'),
  mode: el('mode'),
  modeBalanced: el('mode-balanced'),
  modeStrict: el('mode-strict'),
  reload: el('reload'),
  guard: el('guard'),
  hint: el('hint'),
  options: el('options'),
};

const state = {
  host: '',
  tabId: null,
  hosts: {},
  log: [],
  seen: {},
  mode: 'balanced',
  needsReload: false,
};

function isProtected() {
  return Object.prototype.hasOwnProperty.call(state.hosts, state.host);
}

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function showHint(text) {
  view.hint.hidden = !text;
  view.hint.textContent = text || '';
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'thg:state' });
    if (response && response.ok) {
      state.hosts = response.hosts || {};
      state.log = response.log || [];
      state.seen = response.seen || {};
    }
  } catch (_) {
    // Service worker asleep or reloading; render what we already know.
  }
}

function render() {
  const protectedNow = isProtected();
  state.mode = (state.hosts[state.host] || {}).mode || 'balanced';

  view.shield.dataset.state = protectedNow ? 'on' : 'off';
  view.stateTitle.textContent = protectedNow ? 'Protection Active' : 'Protection Off';
  view.stateSub.textContent = protectedNow
    ? 'Browsing safely, free from pop-ups.'
    : 'Protection is off for this site.';

  const today = startOfToday();
  view.statCount.textContent = String(state.log.filter((entry) => entry.ts >= today).length);

  view.action.checked = protectedNow;
  view.action.disabled = !state.host || state.tabId == null;
  view.actionLabel.textContent = protectedNow ? 'Enabled' : 'Disabled';

  view.mode.hidden = !protectedNow;
  view.modeBalanced.dataset.active = String(state.mode === 'balanced');
  view.modeStrict.dataset.active = String(state.mode === 'strict');

  view.reload.hidden = !(state.needsReload && protectedNow);

  // Only surface the liveness check when it fails; success is not worth a line.
  const seen = state.seen[state.host];
  const missing = protectedNow && !(seen && seen.count > 0);
  view.guard.hidden = !missing;
  view.guard.textContent = missing ? 'Guard not injected on this page. Reload to apply protection.' : '';
}

async function arm() {
  const response = await chrome.runtime.sendMessage({ type: 'thg:protect', host: state.host });
  if (!response || !response.ok) {
    showHint('Could not enable protection: ' + ((response && response.error) || 'unknown error'));
    return;
  }
  state.needsReload = true;
  showHint('');
  await refreshState();
  render();
}

async function disarm() {
  const response = await chrome.runtime.sendMessage({ type: 'thg:unprotect', host: state.host });
  if (!response || !response.ok) {
    showHint('Could not disable protection: ' + ((response && response.error) || 'unknown error'));
    return;
  }
  state.needsReload = false;
  showHint('');
  await refreshState();
  render();
}

async function setMode(mode) {
  if (!isProtected() || state.mode === mode) return;

  const response = await chrome.runtime.sendMessage({ type: 'thg:setMode', host: state.host, mode });
  if (!response || !response.ok) {
    showHint('Could not change mode: ' + ((response && response.error) || 'unknown error'));
    return;
  }

  state.mode = mode;
  state.needsReload = true; // the page guard reads its config on load
  showHint('');
  await refreshState();
  render();
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  state.tabId = tab && tab.id != null ? tab.id : null;

  try {
    state.host = new URL(tab.url).hostname;
  } catch (_) {
    state.host = ''; // brave:// pages, extension pages, etc.
  }

  await refreshState();
  render();
}

view.action.addEventListener('change', () => {
  if (!state.host) return;
  if (view.action.checked) arm();
  else disarm();
});

view.modeBalanced.addEventListener('click', () => setMode('balanced'));
view.modeStrict.addEventListener('click', () => setMode('strict'));

view.reload.addEventListener('click', () => {
  if (state.tabId == null) return;
  chrome.tabs.reload(state.tabId);
  window.close();
});

view.options.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

init();
