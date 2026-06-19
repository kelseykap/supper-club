/* =====================================================
   Supper Club — Recipe app
   ===================================================== */

(function () {
  'use strict';

  const STORAGE_KEY    = 'le.recipes.v1';
  const CATEGORIES_KEY = 'le.categories.v1';
  const SYNC_TOKEN_KEY = 'le.sync.token';
  const SYNC_GIST_KEY  = 'le.sync.gist_id';
  const SYNC_LAST_KEY  = 'le.sync.last_at';
  const GIST_API       = 'https://api.github.com/gists';
  const GIST_FILENAME  = 'supper-club-recipes.json';

  const DEFAULT_CATEGORIES = ['Breakfast','Lunch','Dinner','Dessert','Snack','Drinks','Baking','Salad','Soup','Side'];
  const CROPPER_CSS  = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css';
  const CROPPER_JS   = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js';
  const TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  // ---------- State ----------
  let recipes           = loadRecipes();
  let userCategories    = loadCategories();
  let activeFilter      = 'All';
  let searchTerm        = '';
  let editingId         = null;
  let editingImages     = [];
  let editingCategories = [];
  let currentRecipeId   = null;
  let pendingDeleteId   = null;
  let cropperInstance   = null;
  let cropperEditIndex  = null;   // null = new image; number = replace existing at index

  // View / sort state
  let viewMode = 'list';   // 'list' | 'grid'
  let sortBy   = 'date';   // 'date' | 'name'
  let sortDir  = 'desc';   // 'asc'  | 'desc'

  // Sync state
  let syncToken  = localStorage.getItem(SYNC_TOKEN_KEY) || '';
  let syncGistId = localStorage.getItem(SYNC_GIST_KEY)  || '';
  let syncLastAt = parseInt(localStorage.getItem(SYNC_LAST_KEY) || '0', 10);
  let syncStatus = 'idle';
  let pushTimer  = null;

  // ---------- Storage & migration ----------
  function migrateRecipe(r) {
    if (typeof r.source === 'string') {
      const src = r.source.trim();
      r.source = /^https?:\/\//i.test(src) ? { url: src, title: '' } : { url: '', title: src };
    } else if (!r.source || typeof r.source !== 'object') {
      r.source = { url: '', title: '' };
    }
    if (!r.images) r.images = r.image ? [r.image] : [];
    return r;
  }
  function loadRecipes() {
    try { const raw = localStorage.getItem(STORAGE_KEY); return raw ? JSON.parse(raw).map(migrateRecipe) : []; }
    catch (e) { return []; }
  }
  function saveRecipes() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes)); }
    catch (e) { toast('Could not save — storage full?'); }
    if (syncToken) { clearTimeout(pushTimer); pushTimer = setTimeout(() => gistPush().catch(() => {}), 2000); }
  }
  function loadCategories() {
    try { const raw = localStorage.getItem(CATEGORIES_KEY); return raw ? JSON.parse(raw) : []; }
    catch (e) { return []; }
  }
  function saveCategories() {
    try { localStorage.setItem(CATEGORIES_KEY, JSON.stringify(userCategories)); } catch (e) {}
  }
  function allCategories() {
    const seen = new Set(), out = [];
    [...DEFAULT_CATEGORIES, ...userCategories].forEach(c => {
      const key = c.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    });
    return out;
  }

  // ---------- Helpers ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function escapeHtml(str) {
    return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function splitLines(text) { return String(text || '').split('\n').map(l => l.trim()).filter(Boolean); }
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => { el.hidden = true; }, 2400);
  }
  function titleFromUrl(url) {
    try {
      const u = new URL(url), host = u.hostname.replace(/^www\./, '');
      if (host.includes('cooking.nytimes.com')) {
        const slug = u.pathname.split('/').filter(Boolean).pop() || '';
        const name = slug.replace(/^\d+-/, '').replace(/-/g, ' ').trim();
        return name ? name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'NYT Cooking';
      }
      if (host.includes('instagram.com')) return 'Instagram';
      if (host.includes('substack.com')) {
        const p = host.split('.');
        return p[0].charAt(0).toUpperCase() + p[0].slice(1) + ' on Substack';
      }
      return host.replace(/\.(com|org|net|io|co)$/, '');
    } catch (e) { return ''; }
  }

  // ---------- GitHub Gist sync ----------
  function saveSyncConfig() {
    localStorage.setItem(SYNC_TOKEN_KEY, syncToken);
    localStorage.setItem(SYNC_GIST_KEY,  syncGistId);
  }
  function setSyncStatus(status) {
    syncStatus = status;
    const dot = document.getElementById('sync-dot');
    if (!dot) return;
    dot.className = 'sync-dot';
    if      (status === 'ok')      dot.classList.add('sync-dot--ok');
    else if (status === 'error')   dot.classList.add('sync-dot--error');
    else if (status === 'syncing') dot.classList.add('sync-dot--syncing');
  }
  async function gistRequest(method, path, body) {
    const res = await fetch(GIST_API + path, {
      method,
      headers: {
        'Authorization': `Bearer ${syncToken}`, 'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.message || `HTTP ${res.status}`); }
    return res.json();
  }
  async function gistPush() {
    if (!syncToken) return;
    setSyncStatus('syncing');
    try {
      const content = JSON.stringify(recipes), files = { [GIST_FILENAME]: { content } };
      if (syncGistId) {
        await gistRequest('PATCH', `/${syncGistId}`, { files });
      } else {
        const res = await gistRequest('POST', '', { description: 'Supper Club — recipe backup', public: false, files });
        syncGistId = res.id; saveSyncConfig(); renderSettingsState();
      }
      syncLastAt = Date.now(); localStorage.setItem(SYNC_LAST_KEY, String(syncLastAt)); setSyncStatus('ok');
    } catch (e) { console.error('Gist push failed:', e); setSyncStatus('error'); }
  }
  async function gistPull(showToast) {
    if (!syncToken || !syncGistId) return;
    setSyncStatus('syncing');
    try {
      const gist = await gistRequest('GET', `/${syncGistId}`);
      const file = gist.files && gist.files[GIST_FILENAME];
      if (!file) throw new Error('Recipe file not found in Gist');
      let content = file.content;
      if (file.truncated && file.raw_url) {
        const raw = await fetch(file.raw_url, { headers: { 'Authorization': `Bearer ${syncToken}` } });
        if (!raw.ok) throw new Error('Could not fetch full data');
        content = await raw.text();
      }
      const pulled = JSON.parse(content);
      if (!Array.isArray(pulled)) throw new Error('Invalid recipe data in Gist');
      recipes = pulled.map(migrateRecipe); saveRecipes();
      if (location.hash === '#/' || location.hash === '') renderHome();
      syncLastAt = Date.now(); localStorage.setItem(SYNC_LAST_KEY, String(syncLastAt)); setSyncStatus('ok');
      if (showToast) toast('Recipes synced ✓');
    } catch (e) { console.error('Gist pull failed:', e); setSyncStatus('error'); if (showToast) toast('Sync failed: ' + e.message); }
  }
  async function verifyToken(token) {
    const res = await fetch('https://api.github.com/user', {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    return res.ok;
  }
  async function connectGist() {
    const tokenInput = document.getElementById('github-token-input');
    const token = tokenInput.value.trim();
    if (!token) { toast('Paste your GitHub token first'); return; }
    const btn = document.getElementById('settings-connect');
    btn.textContent = 'Connecting…'; btn.disabled = true; setSyncStatus('syncing');
    try {
      if (!await verifyToken(token)) throw new Error('Token invalid or missing gist scope');
      syncToken = token; syncGistId = ''; saveSyncConfig(); await gistPush();
      renderSettingsState(); toast('Connected! Recipes backed up to GitHub ✓');
    } catch (e) { setSyncStatus('error'); toast('Connection failed: ' + e.message); btn.textContent = 'Connect'; btn.disabled = false; }
  }
  function disconnectGist() {
    syncToken = ''; syncGistId = ''; syncLastAt = 0;
    saveSyncConfig(); localStorage.removeItem(SYNC_LAST_KEY); setSyncStatus('idle');
    renderSettingsState(); toast('Disconnected');
  }
  function renderSettingsState() {
    const connected = !!(syncToken && syncGistId);
    const connectForm   = document.getElementById('settings-connect-form');
    const connectedInfo = document.getElementById('settings-connected-info');
    const gistIdEl      = document.getElementById('settings-gist-id');
    const lastSyncEl    = document.getElementById('settings-last-sync');
    const connectBtn    = document.getElementById('settings-connect');
    if (!connectForm) return;
    connectForm.hidden = connected; connectedInfo.hidden = !connected;
    if (connected) {
      gistIdEl.textContent   = syncGistId;
      lastSyncEl.textContent = syncLastAt ? 'Last synced ' + new Date(syncLastAt).toLocaleString() : 'Not yet synced';
      connectBtn.textContent = 'Connect'; connectBtn.disabled = false;
    } else {
      document.getElementById('github-token-input').value = syncToken || '';
    }
  }

  // ---------- Lazy loaders ----------
  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-src="${url}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = url; s.dataset.src = url;
      s.onload = resolve; s.onerror = () => reject(new Error('Could not load ' + url));
      document.head.appendChild(s);
    });
  }
  function loadCssOnce(url) {
    if (document.querySelector(`link[data-href="${url}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = url; l.dataset.href = url;
    document.head.appendChild(l);
  }

  // ---------- Routing ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
    const view = document.getElementById('view-' + name);
    if (view) view.classList.add('view--active');
    window.scrollTo(0, 0);
  }
  function navigate(hash) {
    if (location.hash === hash) handleHash(); else location.hash = hash;
  }
  function handleHash() {
    if (cropperInstance) destroyCropper();
    const h = location.hash || '#/';
    if (h === '#/' || h === '') { currentRecipeId = null; renderHome(); showView('home'); return; }
    const m = h.match(/^#\/recipe\/([^/]+)$/);
    if (m) {
      const r = recipes.find(x => x.id === m[1]);
      if (!r) { navigate('#/'); return; }
      currentRecipeId = m[1]; renderRecipe(r); showView('recipe'); return;
    }
    if (h === '#/new') { openForm(null); showView('edit'); return; }
    const em = h.match(/^#\/edit\/([^/]+)$/);
    if (em) {
      const r = recipes.find(x => x.id === em[1]);
      if (!r) { navigate('#/'); return; }
      openForm(r); showView('edit'); return;
    }
    if (h === '#/settings') { renderSettingsState(); showView('settings'); return; }
    if (h === '#/confirm-delete') { showView('confirm'); return; }
    navigate('#/');
  }

  // ---------- Home ----------
  function renderHome() {
    renderFilterChips();
    renderToolbar();
    renderRecipeList();
  }

  // ---------- Toolbar (view toggle + sort) ----------
  function renderToolbar() {
    const listBtn = document.getElementById('view-list-btn');
    const gridBtn = document.getElementById('view-grid-btn');
    if (listBtn) listBtn.classList.toggle('tool-btn--active', viewMode === 'list');
    if (gridBtn) gridBtn.classList.toggle('tool-btn--active', viewMode === 'grid');

    const sortLbl   = document.getElementById('sort-lbl');
    const sortBtn   = document.getElementById('sort-btn');
    const isDefault = sortBy === 'date' && sortDir === 'desc';
    if (sortLbl) {
      if (isDefault) {
        sortLbl.textContent = ''; sortLbl.hidden = true;
      } else {
        const label = sortBy === 'name'
          ? (sortDir === 'asc' ? 'A–Z' : 'Z–A')
          : (sortDir === 'asc' ? 'Oldest' : 'Newest');
        sortLbl.textContent = label; sortLbl.hidden = false;
      }
    }
    if (sortBtn) sortBtn.classList.toggle('tool-btn--active', !isDefault);
  }

  function cycleSort() {
    if      (sortBy === 'date' && sortDir === 'desc') { sortDir = 'asc'; }
    else if (sortBy === 'date' && sortDir === 'asc')  { sortBy = 'name'; sortDir = 'asc'; }
    else if (sortBy === 'name' && sortDir === 'asc')  { sortDir = 'desc'; }
    else { sortBy = 'date'; sortDir = 'desc'; }
    renderToolbar();
    renderRecipeList();
  }

  // ---------- Icons ----------
  function bookmarkIconInline() {
    return `<svg viewBox="0 0 24 24" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
  }
  function checkIconInline() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }
  function notMadeIconInline() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/></svg>`;
  }

  // ---------- Filter chips ----------
  function renderFilterChips() {
    const wrap         = document.getElementById('filter-chips');
    const usedCats     = new Set();
    recipes.forEach(r => (r.categories || []).forEach(c => usedCats.add(c)));
    const hasBookmarks = recipes.some(r => r.bookmarked);
    const hasMade      = recipes.some(r => r.made);

    const chips = ['All'];
    if (hasBookmarks) chips.push('Bookmarked');
    if (hasMade) { chips.push('Made'); chips.push('Not Made'); }
    Array.from(usedCats).sort((a, b) => a.localeCompare(b)).forEach(c => chips.push(c));

    wrap.innerHTML = chips.map(c => {
      const active = c === activeFilter ? 'chip--active' : '';
      let inner = escapeHtml(c), extraClass = '';
      if      (c === 'Bookmarked') inner = bookmarkIconInline() + escapeHtml(c);
      else if (c === 'Made')       { inner = checkIconInline() + escapeHtml(c); extraClass = 'chip--made'; }
      else if (c === 'Not Made')   { inner = notMadeIconInline() + escapeHtml(c); extraClass = 'chip--not-made'; }
      return `<button type="button" class="chip ${extraClass} ${active}" data-cat="${escapeHtml(c)}">${inner}</button>`;
    }).join('');

    wrap.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => { activeFilter = btn.dataset.cat; renderHome(); });
    });
  }

  function matchesSearch(recipe, q) {
    if (!q) return true;
    q = q.toLowerCase();
    if ((recipe.title || '').toLowerCase().includes(q)) return true;
    if ((recipe.categories || []).some(c => c.toLowerCase().includes(q))) return true;
    if ((recipe.ingredients || []).some(i => i.toLowerCase().includes(q))) return true;
    const src = recipe.source || {};
    const srcText = (typeof src === 'string' ? src : (src.title || '') + ' ' + (src.url || '')).toLowerCase();
    return srcText.includes(q);
  }

  function placeholderThumbSvg() {
    return `<svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="32" cy="32" r="20"/><circle cx="32" cy="32" r="13"/>
      <path d="M16 14v8c0 2 1 3 3 3v15M19 14v11"/>
      <path d="M48 14c-3 0-5 3-5 6s2 5 5 5v15"/></svg>`;
  }

  // ---------- Recipe list ----------
  function renderRecipeList() {
    const list         = document.getElementById('recipe-list');
    const emptyAll     = document.getElementById('empty-state');
    const emptyResults = document.getElementById('no-results');

    let filtered = recipes.slice();
    if      (activeFilter === 'Bookmarked') filtered = filtered.filter(r => r.bookmarked);
    else if (activeFilter === 'Made')       filtered = filtered.filter(r => r.made);
    else if (activeFilter === 'Not Made')   filtered = filtered.filter(r => !r.made);
    else if (activeFilter !== 'All')        filtered = filtered.filter(r => (r.categories || []).includes(activeFilter));
    if (searchTerm) filtered = filtered.filter(r => matchesSearch(r, searchTerm));

    // Sort
    if (sortBy === 'name') {
      filtered.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
      if (sortDir === 'desc') filtered.reverse();
    } else {
      filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (sortDir === 'asc') filtered.reverse();
    }

    // Apply view class
    list.className = 'recipe-list' + (viewMode === 'grid' ? ' recipe-list--grid' : '');

    if (recipes.length === 0) {
      list.innerHTML = ''; emptyAll.hidden = false; emptyResults.hidden = true; return;
    }
    emptyAll.hidden = true;
    if (filtered.length === 0) {
      list.innerHTML = ''; emptyResults.hidden = false; return;
    }
    emptyResults.hidden = true;

    list.innerHTML = filtered.map(r => {
      const thumb0 = (r.images && r.images[0]) || r.image || null;
      const cats = (r.categories || []).slice(0, 3).map(c =>
        `<span class="recipe-card__cat">${escapeHtml(c)}</span>`).join('');
      const thumbEl = thumb0
        ? `<div class="recipe-card__thumb" style="background-image:url('${thumb0}')"></div>`
        : `<div class="recipe-card__thumb recipe-card__thumb--placeholder">${placeholderThumbSvg()}</div>`;
      const bookmarkBadge = r.bookmarked
        ? `<div class="recipe-card__bookmark" aria-label="Bookmarked">${bookmarkIconInline()}</div>` : '';
      const madeBadge = r.made
        ? `<div class="recipe-card__made" aria-label="Made">${checkIconInline()}</div>` : '';
      return `
        <button type="button" class="recipe-card ${r.bookmarked ? 'recipe-card--bookmarked' : ''}" data-id="${r.id}">
          ${thumbEl}
          <div class="recipe-card__body">
            <h2 class="recipe-card__title">${escapeHtml(r.title || 'Untitled')}</h2>
            <div class="recipe-card__cats">${cats}</div>
          </div>
          ${bookmarkBadge}${madeBadge}
        </button>`;
    }).join('');

    list.querySelectorAll('.recipe-card').forEach(card => {
      card.addEventListener('click', () => navigate('#/recipe/' + card.dataset.id));
    });
  }

  // ---------- Recipe detail ----------
  function renderRecipe(r) {
    const wrap = document.getElementById('recipe-detail');
    const imgs = (r.images && r.images.length) ? r.images : (r.image ? [r.image] : []);
    let imgHtml = '';
    if (imgs.length === 1) {
      imgHtml = `<div class="recipe-detail__image" style="background-image:url('${imgs[0]}')"></div>`;
    } else if (imgs.length > 1) {
      imgHtml = `<div class="recipe-gallery">${imgs.map(img =>
        `<div class="recipe-gallery__thumb" style="background-image:url('${img}')"></div>`).join('')}</div>`;
    }
    const cats = (r.categories || []).map(c =>
      `<span class="recipe-detail__cat">${escapeHtml(c)}</span>`).join('');
    let ingredientsHtml = '';
    if ((r.ingredients || []).length) {
      ingredientsHtml = `<div class="section"><h3 class="section__title">Ingredients</h3>
        <ul class="section__list section__list--ingredients">
          ${r.ingredients.map(i => `<li>${escapeHtml(i)}</li>`).join('')}
        </ul></div>`;
    }
    let methodHtml = '';
    if ((r.method || []).length) {
      methodHtml = `<div class="section"><h3 class="section__title">Method</h3>
        <ol class="section__list section__list--method">
          ${r.method.map(m => `<li>${escapeHtml(m)}</li>`).join('')}
        </ol></div>`;
    }
    const src      = r.source || {};
    const srcUrl   = (typeof src === 'string' ? (/^https?:\/\//i.test(src.trim()) ? src.trim() : '') : (src.url || '')).trim();
    const srcTitle = (typeof src === 'string' ? (!srcUrl ? src.trim() : '') : (src.title || '')).trim();
    let sourceHtml = '';
    if (srcUrl || srcTitle) {
      let content;
      if (srcUrl && srcTitle) content = `<a href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener" class="source-link">${escapeHtml(srcTitle)}</a>`;
      else if (srcUrl)        content = `<a href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener" class="source-link">${escapeHtml(titleFromUrl(srcUrl) || srcUrl)}</a>`;
      else                    content = escapeHtml(srcTitle);
      sourceHtml = `<div class="section"><h3 class="section__title">Source</h3><p class="section__text">${content}</p></div>`;
    }
    let notesHtml = '';
    if (r.notes && r.notes.trim()) {
      notesHtml = `<div class="section"><h3 class="section__title">Notes</h3><p class="section__text">${escapeHtml(r.notes)}</p></div>`;
    }
    wrap.innerHTML = `${imgHtml}
      <h1 class="recipe-detail__title">${escapeHtml(r.title || 'Untitled')}</h1>
      ${cats ? `<div class="recipe-detail__cats">${cats}</div>` : ''}
      ${ingredientsHtml}${methodHtml}${sourceHtml}${notesHtml}`;

    document.getElementById('recipe-bookmark').classList.toggle('is-bookmarked', !!r.bookmarked);
    document.getElementById('recipe-made').classList.toggle('is-made', !!r.made);
  }

  function toggleBookmark(id) {
    const idx = recipes.findIndex(r => r.id === id); if (idx < 0) return;
    recipes[idx].bookmarked = !recipes[idx].bookmarked; saveRecipes();
    document.getElementById('recipe-bookmark').classList.toggle('is-bookmarked', !!recipes[idx].bookmarked);
    toast(recipes[idx].bookmarked ? 'Bookmarked' : 'Bookmark removed');
  }
  function toggleMade(id) {
    const idx = recipes.findIndex(r => r.id === id); if (idx < 0) return;
    recipes[idx].made = !recipes[idx].made; saveRecipes();
    document.getElementById('recipe-made').classList.toggle('is-made', !!recipes[idx].made);
    toast(recipes[idx].made ? 'Marked as made' : 'Unmarked');
  }

  // ---------- Form ----------
  function openForm(recipe) {
    const titleEl          = document.getElementById('edit-title');
    const titleInput       = document.getElementById('title-input');
    const ingredientsInput = document.getElementById('ingredients-input');
    const methodInput      = document.getElementById('method-input');
    const sourceInput      = document.getElementById('source-input');
    const notesInput       = document.getElementById('notes-input');

    if (recipe) {
      editingId = recipe.id;
      titleEl.textContent    = 'Edit Recipe';
      titleInput.value       = recipe.title || '';
      ingredientsInput.value = (recipe.ingredients || []).join('\n');
      methodInput.value      = (recipe.method || []).join('\n');
      const src      = recipe.source || {};
      const srcUrl   = typeof src === 'string' ? (/^https?:\/\//i.test(src.trim()) ? src.trim() : '') : (src.url || '');
      const srcTitle = typeof src === 'string' ? (!srcUrl ? src.trim() : '') : (src.title || '');
      sourceInput.value = srcUrl || srcTitle;
      notesInput.value  = recipe.notes || '';
      editingCategories = [...(recipe.categories || [])];
      editingImages     = [...((recipe.images && recipe.images.length) ? recipe.images : (recipe.image ? [recipe.image] : []))];
    } else {
      editingId = null;
      titleEl.textContent = 'New Recipe';
      titleInput.value = ingredientsInput.value = methodInput.value = sourceInput.value = notesInput.value = '';
      editingCategories = [];
      editingImages     = [];
    }
    cropperEditIndex = null;
    document.getElementById('image-input').value  = '';
    document.getElementById('import-input').value = '';
    document.getElementById('new-category-input').value = '';
    renderImageStrip();
    renderCategoryPickers();
  }

  // ---------- Image strip ----------
  function renderImageStrip() {
    const emptyLabel   = document.getElementById('image-upload-empty');
    const stripWrap    = document.getElementById('image-strip-wrap');
    const strip        = document.getElementById('image-strip');
    const addMoreLabel = document.getElementById('image-upload-more');

    if (editingImages.length === 0) {
      emptyLabel.hidden  = false;
      stripWrap.hidden   = true;
      if (addMoreLabel) addMoreLabel.hidden = true;
      strip.innerHTML    = '';
    } else {
      emptyLabel.hidden  = true;
      stripWrap.hidden   = false;
      if (addMoreLabel) addMoreLabel.hidden = false;

      strip.innerHTML = editingImages.map((img, i) => `
        <div class="img-thumb">
          <div class="img-thumb__img" data-idx="${i}" title="Tap to edit" style="background-image:url('${img}')"></div>
          <button type="button" class="img-thumb__remove" data-idx="${i}" aria-label="Remove photo">✕</button>
        </div>`).join('');

      // Tap thumbnail to re-crop
      strip.querySelectorAll('.img-thumb__img').forEach(el => {
        el.addEventListener('click', () => {
          const idx = parseInt(el.dataset.idx, 10);
          cropperEditIndex = idx;
          openCropper(editingImages[idx]);
        });
      });

      strip.querySelectorAll('.img-thumb__remove').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          editingImages.splice(parseInt(btn.dataset.idx, 10), 1);
          renderImageStrip();
        });
      });
    }
  }

  // ---------- Category pickers ----------
  function renderCategoryPickers() {
    const wrap   = document.getElementById('category-pickers');
    const known  = allCategories();
    const merged = [...known];
    editingCategories.forEach(c => {
      if (!merged.some(k => k.toLowerCase() === c.toLowerCase())) merged.push(c);
    });
    wrap.innerHTML = merged.map(c => {
      const active = editingCategories.some(x => x.toLowerCase() === c.toLowerCase()) ? 'cat-pick--active' : '';
      return `<button type="button" class="cat-pick ${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    }).join('');
    wrap.querySelectorAll('.cat-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        const idx = editingCategories.findIndex(x => x.toLowerCase() === cat.toLowerCase());
        if (idx >= 0) editingCategories.splice(idx, 1); else editingCategories.push(cat);
        renderCategoryPickers();
      });
    });
  }

  function addNewCategoryFromInput() {
    const input = document.getElementById('new-category-input');
    const val   = input.value.trim(); if (!val) return;
    const known = allCategories();
    if (!known.some(k => k.toLowerCase() === val.toLowerCase())) { userCategories.push(val); saveCategories(); }
    if (!editingCategories.some(x => x.toLowerCase() === val.toLowerCase())) editingCategories.push(val);
    input.value = ''; renderCategoryPickers();
  }

  // ---------- Save form ----------
  function saveRecipeFromForm() {
    const title       = document.getElementById('title-input').value.trim();
    const ingredients = splitLines(document.getElementById('ingredients-input').value);
    const method      = splitLines(document.getElementById('method-input').value);
    const sourceVal   = document.getElementById('source-input').value.trim();
    const notes       = document.getElementById('notes-input').value.trim();

    if (!title) { toast('Please add a title'); document.getElementById('title-input').focus(); return; }

    const isUrl = /^https?:\/\//i.test(sourceVal) || /^www\./i.test(sourceVal);
    const source = sourceVal
      ? (isUrl ? { url: sourceVal, title: '' } : { url: '', title: sourceVal })
      : { url: '', title: '' };
    const now = Date.now();

    if (editingId) {
      const idx = recipes.findIndex(r => r.id === editingId);
      if (idx >= 0) {
        recipes[idx] = { ...recipes[idx], title, ingredients, method, source, notes,
          categories: [...editingCategories], images: [...editingImages],
          image: editingImages[0] || null, updatedAt: now };
        saveRecipes(); toast('Saved'); navigate('#/recipe/' + editingId);
      }
    } else {
      const id = uid();
      recipes.unshift({ id, title, ingredients, method, source, notes,
        categories: [...editingCategories], images: [...editingImages],
        image: editingImages[0] || null, createdAt: now, updatedAt: now });
      saveRecipes(); toast('Saved'); navigate('#/recipe/' + id);
    }
  }

  // ---------- Image helpers ----------
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }
  function compressDataUrl(dataUrl, maxDim, quality) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * (maxDim / width)); width = maxDim; }
          else                { width  = Math.round(width  * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = dataUrl;
    });
  }

  async function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) { toast('Please choose an image'); return; }
    try { cropperEditIndex = null; await openCropper(await fileToDataUrl(file)); }
    catch (err) { console.error(err); toast('Could not load image'); }
  }
  async function handleMultipleImageFiles(files) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    showLoading(`Adding ${imageFiles.length} photo${imageFiles.length > 1 ? 's' : ''}…`);
    try {
      for (const file of imageFiles) {
        editingImages.push(await compressDataUrl(await fileToDataUrl(file), 1200, 0.82));
      }
      renderImageStrip();
    } catch (err) { console.error(err); toast('Could not process images'); }
    finally { hideLoading(); }
  }

  // ---------- Cropper ----------
  async function openCropper(dataUrl) {
    try { loadCssOnce(CROPPER_CSS); await loadScriptOnce(CROPPER_JS); }
    catch (err) {
      toast('Cropper unavailable — adding photo as-is');
      try {
        if (cropperEditIndex !== null) editingImages[cropperEditIndex] = await compressDataUrl(dataUrl, 1200, 0.82);
        else editingImages.push(await compressDataUrl(dataUrl, 1200, 0.82));
        cropperEditIndex = null; renderImageStrip();
      } catch (e) { toast('Could not add photo'); }
      return;
    }
    if (typeof Cropper === 'undefined') {
      toast('Cropper unavailable — adding photo as-is');
      try {
        if (cropperEditIndex !== null) editingImages[cropperEditIndex] = await compressDataUrl(dataUrl, 1200, 0.82);
        else editingImages.push(await compressDataUrl(dataUrl, 1200, 0.82));
        cropperEditIndex = null; renderImageStrip();
      } catch (e) { toast('Could not add photo'); }
      return;
    }

    showView('cropper');
    const img = document.getElementById('cropper-img');
    destroyCropper();

    img.onload = () => {
      if (!document.getElementById('view-cropper').classList.contains('view--active')) return;
      // Lock aspect ratio to the original image's proportions
      const ratio = img.naturalWidth / img.naturalHeight;
      cropperInstance = new Cropper(img, {
        aspectRatio: ratio,      // locked to original proportions
        dragMode: 'move',        // dragging canvas moves image (no re-drawing crop box)
        viewMode: 2,
        autoCropArea: 0.92,
        background: false,
        movable: true,
        zoomable: true,
        rotatable: false,
        scalable: false,
        cropBoxResizable: true,
        responsive: true,
        guides: true,
        minContainerHeight: 300,
      });
    };
    img.onerror = () => { toast('Could not load image for cropping'); showView('edit'); };
    img.src = ''; img.src = dataUrl;
  }

  function destroyCropper() {
    if (cropperInstance) { try { cropperInstance.destroy(); } catch (e) {} cropperInstance = null; }
    const img = document.getElementById('cropper-img');
    if (img) { img.onload = null; img.onerror = null; }
  }
  function commitCropper() {
    if (!cropperInstance) return;
    const canvas = cropperInstance.getCroppedCanvas({ maxWidth: 1600, maxHeight: 1600, imageSmoothingQuality: 'high' });
    if (!canvas) { toast('Crop failed'); return; }
    try {
      const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
      if (cropperEditIndex !== null) {
        editingImages[cropperEditIndex] = dataUrl;   // replace existing
      } else {
        editingImages.push(dataUrl);                 // add new
      }
      cropperEditIndex = null;
      renderImageStrip();
    } catch (err) { toast('Could not save crop'); return; }
    destroyCropper();
    showView('edit');
  }
  function cancelCropper() {
    cropperEditIndex = null;
    destroyCropper();
    document.getElementById('image-input').value = '';
    showView('edit');
  }

  // ---------- Loading overlay ----------
  function showLoading(msg) {
    document.getElementById('loading-overlay-msg').textContent = msg || 'Loading…';
    document.getElementById('loading-overlay').hidden = false;
  }
  function hideLoading() { document.getElementById('loading-overlay').hidden = true; }

  // ---------- OCR ----------
  async function importFromPhotos(files) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imageFiles.length) { toast('Please choose an image'); return; }
    showLoading('Preparing images…');
    const dataUrls = [];
    for (const file of imageFiles) {
      try { dataUrls.push(await compressDataUrl(await fileToDataUrl(file), 1568, 0.85)); }
      catch (e) { console.error(e); }
    }
    if (!dataUrls.length) { hideLoading(); toast('Could not load images'); return; }
    showLoading('Loading OCR…');
    try { await loadScriptOnce(TESSERACT_JS); }
    catch (e) { hideLoading(); toast('Could not load OCR — need internet'); return; }
    if (typeof Tesseract === 'undefined') { hideLoading(); toast('OCR not available'); return; }
    const texts = [];
    for (let i = 0; i < dataUrls.length; i++) {
      try {
        const result = await Tesseract.recognize(dataUrls[i], 'eng', {
          logger: m => {
            if (!m) return;
            const prefix = dataUrls.length > 1 ? `Photo ${i + 1}/${dataUrls.length}: ` : '';
            if (m.status === 'recognizing text')
              document.getElementById('loading-overlay-msg').textContent = `${prefix}Reading… ${Math.round((m.progress || 0) * 100)}%`;
            else if (m.status)
              document.getElementById('loading-overlay-msg').textContent = prefix + m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
          }
        });
        const text = (result && result.data && result.data.text || '').trim();
        if (text) texts.push(text);
      } catch (err) { console.error('OCR failed for image', i, err); }
    }
    hideLoading();
    document.getElementById('import-input').value = '';
    if (!texts.length) { toast('No text found in image'); return; }
    document.getElementById('ocr-text').value = texts.join('\n\n---\n\n');
    showView('ocr');
  }

  function applyOcrTo(field) {
    const text   = document.getElementById('ocr-text').value || '';
    const target = document.getElementById(field === 'method' ? 'method-input' : 'ingredients-input');
    target.value = text; showView('edit');
    setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    toast(field === 'method' ? 'Set as Method' : 'Set as Ingredients');
  }

  // ---------- Export ----------
  function exportData() {
    try {
      const blob = new Blob([JSON.stringify(recipes, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `supper-club-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url); toast('Recipes exported');
    } catch (e) { toast('Export failed'); }
  }

  // ---------- Share ----------
  function formatForShare(r) {
    const lines = [(r.title || 'Untitled').toUpperCase(), ''];
    if ((r.categories || []).length) lines.push(r.categories.join(' · '), '');
    if ((r.ingredients || []).length) { lines.push('INGREDIENTS'); r.ingredients.forEach(i => lines.push('• ' + i)); lines.push(''); }
    if ((r.method || []).length) { lines.push('METHOD'); r.method.forEach((m, i) => lines.push((i + 1) + '. ' + m)); lines.push(''); }
    const src = r.source || {};
    const srcDisplay = typeof src === 'string' ? src : ((src.title || src.url || '').trim());
    if (srcDisplay) lines.push('SOURCE', srcDisplay, '');
    if (r.notes && r.notes.trim()) lines.push('NOTES', r.notes.trim(), '');
    return lines.join('\n').trim();
  }
  async function shareRecipe(r) {
    const text = formatForShare(r);
    if (navigator.share) {
      try { await navigator.share({ title: r.title || 'Recipe', text }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
  }

  // ---------- Delete ----------
  function askDelete(id) {
    const r = recipes.find(x => x.id === id); if (!r) return;
    pendingDeleteId = id;
    document.getElementById('confirm-sub').textContent = `"${r.title || 'Untitled'}" will be removed permanently.`;
    navigate('#/confirm-delete');
  }
  function doDelete() {
    if (!pendingDeleteId) return;
    recipes = recipes.filter(r => r.id !== pendingDeleteId);
    saveRecipes(); pendingDeleteId = null; toast('Deleted'); navigate('#/');
  }

  // ---------- Event wiring ----------
  function wireEvents() {
    // Home
    document.getElementById('fab-add').addEventListener('click', () => navigate('#/new'));
    document.getElementById('search-input').addEventListener('input', e => { searchTerm = e.target.value.trim(); renderRecipeList(); });
    document.getElementById('settings-btn').addEventListener('click', () => navigate('#/settings'));

    // Toolbar
    document.getElementById('view-list-btn').addEventListener('click', () => { viewMode = 'list'; renderToolbar(); renderRecipeList(); });
    document.getElementById('view-grid-btn').addEventListener('click', () => { viewMode = 'grid'; renderToolbar(); renderRecipeList(); });
    document.getElementById('sort-btn').addEventListener('click', cycleSort);

    // Recipe detail
    document.getElementById('recipe-back').addEventListener('click', () => navigate('#/'));
    document.getElementById('recipe-edit').addEventListener('click', () => { if (currentRecipeId) navigate('#/edit/' + currentRecipeId); });
    document.getElementById('recipe-delete').addEventListener('click', () => { if (currentRecipeId) askDelete(currentRecipeId); });
    document.getElementById('recipe-share').addEventListener('click', () => { const r = recipes.find(x => x.id === currentRecipeId); if (r) shareRecipe(r); });
    document.getElementById('recipe-bookmark').addEventListener('click', () => { if (currentRecipeId) toggleBookmark(currentRecipeId); });
    document.getElementById('recipe-made').addEventListener('click', () => { if (currentRecipeId) toggleMade(currentRecipeId); });

    // Edit form
    document.getElementById('edit-cancel').addEventListener('click', () => { if (editingId) navigate('#/recipe/' + editingId); else navigate('#/'); });
    document.getElementById('edit-save').addEventListener('click', saveRecipeFromForm);

    // Image input
    document.getElementById('image-input').addEventListener('change', e => {
      const files = e.target.files; if (!files || !files.length) return;
      if (files.length === 1) handleImageFile(files[0]);
      else handleMultipleImageFiles(Array.from(files));
      e.target.value = '';
    });

    // Cropper
    document.getElementById('cropper-done').addEventListener('click', commitCropper);
    document.getElementById('cropper-cancel').addEventListener('click', cancelCropper);

    // Import from photo
    document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-input').click());
    document.getElementById('import-input').addEventListener('change', e => { if (e.target.files && e.target.files.length) importFromPhotos(e.target.files); });

    // Categories
    document.getElementById('new-category-btn').addEventListener('click', addNewCategoryFromInput);
    document.getElementById('new-category-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addNewCategoryFromInput(); } });

    // OCR
    document.getElementById('ocr-cancel').addEventListener('click', () => showView('edit'));
    document.getElementById('ocr-to-ingredients').addEventListener('click', () => applyOcrTo('ingredients'));
    document.getElementById('ocr-to-method').addEventListener('click', () => applyOcrTo('method'));

    // Confirm delete
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      pendingDeleteId = null;
      if (currentRecipeId && recipes.find(r => r.id === currentRecipeId)) navigate('#/recipe/' + currentRecipeId);
      else navigate('#/');
    });
    document.getElementById('confirm-ok').addEventListener('click', doDelete);

    // Settings
    document.getElementById('settings-back').addEventListener('click', () => navigate('#/'));
    document.getElementById('settings-connect').addEventListener('click', connectGist);
    document.getElementById('settings-sync-now').addEventListener('click', () => gistPull(true).catch(() => {}));
    document.getElementById('settings-disconnect').addEventListener('click', disconnectGist);
    document.getElementById('settings-export').addEventListener('click', exportData);

    // Routing
    window.addEventListener('hashchange', handleHash);
  }

  // ---------- PWA ----------
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => navigator.serviceWorker.register('service-worker.js').catch(() => {}));
    }
  }

  function init() {
    wireEvents();
    handleHash();
    registerServiceWorker();
    if (syncToken && syncGistId) setSyncStatus('ok');
    if (syncToken && syncGistId) gistPull(false).catch(() => {});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
