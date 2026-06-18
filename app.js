/* =====================================================
   Supper Club — Recipe app
   Local-storage CRUD + hash routing
   Image cropping (Cropper.js) + OCR import (Tesseract.js)
   ===================================================== */

(function () {
  'use strict';

  // ---------- Constants ----------
  const STORAGE_KEY = 'le.recipes.v1';
  const CATEGORIES_KEY = 'le.categories.v1';
  const SPECIAL_CATEGORIES = ['Made', 'Want to Make'];
  const DEFAULT_CATEGORIES = [
    'Breakfast', 'Lunch', 'Dinner', 'Dessert',
    'Snack', 'Drinks', 'Baking', 'Salad', 'Soup', 'Side'
  ];
  const CROPPER_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css';
  const CROPPER_JS  = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js';
  const TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';

  // ---------- State ----------
  let recipes = loadRecipes();
  let userCategories = loadCategories();
  let activeFilter = 'All';
  let searchTerm = '';
  let editingId = null;
  let editingImages = [];      // array of dataUrls for current edit session
  let editingCategories = [];
  let currentRecipeId = null;
  let pendingDeleteId = null;
  let cropperInstance = null;

  // ---------- Storage & migration ----------
  function migrateRecipe(r) {
    // Migrate legacy source string → {url, title} object
    if (typeof r.source === 'string') {
      const src = r.source.trim();
      r.source = /^https?:\/\//i.test(src)
        ? { url: src, title: '' }
        : { url: '', title: src };
    } else if (!r.source || typeof r.source !== 'object') {
      r.source = { url: '', title: '' };
    }
    // Migrate legacy single image → images array
    if (!r.images) {
      r.images = r.image ? [r.image] : [];
    }
    return r;
  }

  function loadRecipes() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return arr.map(migrateRecipe);
    } catch (e) { return []; }
  }
  function saveRecipes() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes)); }
    catch (e) { toast('Could not save — storage full?'); }
  }
  function loadCategories() {
    try {
      const raw = localStorage.getItem(CATEGORIES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }
  function saveCategories() {
    try { localStorage.setItem(CATEGORIES_KEY, JSON.stringify(userCategories)); }
    catch (e) { /* ignore */ }
  }
  function allCategories() {
    const seen = new Set();
    const out = [];
    [...DEFAULT_CATEGORIES, ...userCategories].forEach(c => {
      const key = c.toLowerCase();
      if (!seen.has(key)) { seen.add(key); out.push(c); }
    });
    return out;
  }

  // ---------- Helpers ----------
  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
  function splitLines(text) {
    return String(text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
  }
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, 2400);
  }

  // Derive a readable title from a URL for known domains
  function titleFromUrl(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\./, '');
      if (host.includes('cooking.nytimes.com')) {
        // e.g. /recipes/1234-pasta-with-garlic → "Pasta With Garlic"
        const slug = u.pathname.split('/').filter(Boolean).pop() || '';
        const name = slug.replace(/^\d+-/, '').replace(/-/g, ' ').trim();
        if (name) {
          return name.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }
        return 'NYT Cooking';
      }
      if (host.includes('instagram.com')) return 'Instagram';
      if (host.includes('substack.com')) {
        const parts = host.split('.');
        return parts[0].charAt(0).toUpperCase() + parts[0].slice(1) + ' on Substack';
      }
      // Generic: return cleaned host
      return host.replace(/\.(com|org|net|io|co)$/, '');
    } catch (e) { return ''; }
  }

  // ---------- Lazy script loaders ----------
  function loadScriptOnce(url) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-src="${url}"]`)) return resolve();
      const s = document.createElement('script');
      s.src = url;
      s.dataset.src = url;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Could not load ' + url));
      document.head.appendChild(s);
    });
  }
  function loadCssOnce(url) {
    if (document.querySelector(`link[data-href="${url}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = url;
    l.dataset.href = url;
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
    if (location.hash === hash) handleHash();
    else location.hash = hash;
  }

  function handleHash() {
    if (cropperInstance) destroyCropper();

    const h = location.hash || '#/';
    if (h === '#/' || h === '') {
      currentRecipeId = null;
      renderHome();
      showView('home');
      return;
    }
    const m = h.match(/^#\/recipe\/([^/]+)$/);
    if (m) {
      const r = recipes.find(x => x.id === m[1]);
      if (!r) { navigate('#/'); return; }
      currentRecipeId = m[1];
      renderRecipe(r);
      showView('recipe');
      return;
    }
    if (h === '#/new') { openForm(null); showView('edit'); return; }
    const em = h.match(/^#\/edit\/([^/]+)$/);
    if (em) {
      const r = recipes.find(x => x.id === em[1]);
      if (!r) { navigate('#/'); return; }
      openForm(r);
      showView('edit');
      return;
    }
    if (h === '#/confirm-delete') { showView('confirm'); return; }
    navigate('#/');
  }

  // ---------- Home rendering ----------
  function renderHome() {
    renderFilterChips();
    renderRecipeList();
  }

  // ---------- Inline SVG icons ----------
  function bookmarkIconInline() {
    return `<svg viewBox="0 0 24 24" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
  }
  function checkIconInline() {
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
  }
  function starIconInline() {
    return `<svg viewBox="0 0 24 24" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
  }

  function renderFilterChips() {
    const wrap = document.getElementById('filter-chips');
    const usedCats = new Set();
    recipes.forEach(r => (r.categories || []).forEach(c => usedCats.add(c)));
    const hasBookmarks = recipes.some(r => r.bookmarked);

    // Build chip list: All → Bookmarked → Special (if used) → Regular (sorted)
    const chips = ['All'];
    if (hasBookmarks) chips.push('Bookmarked');
    SPECIAL_CATEGORIES.forEach(sc => { if (usedCats.has(sc)) chips.push(sc); });
    Array.from(usedCats)
      .filter(c => !SPECIAL_CATEGORIES.includes(c))
      .sort((a, b) => a.localeCompare(b))
      .forEach(c => chips.push(c));

    wrap.innerHTML = chips.map(c => {
      const active = c === activeFilter ? 'chip--active' : '';
      let inner = escapeHtml(c);
      let extraClass = '';
      if (c === 'Bookmarked') {
        inner = bookmarkIconInline() + escapeHtml(c);
      } else if (c === 'Made') {
        inner = checkIconInline() + escapeHtml(c);
        extraClass = 'chip--made';
      } else if (c === 'Want to Make') {
        inner = starIconInline() + escapeHtml(c);
        extraClass = 'chip--want';
      }
      return `<button type="button" class="chip ${extraClass} ${active}" data-cat="${escapeHtml(c)}">${inner}</button>`;
    }).join('');

    wrap.querySelectorAll('.chip').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.cat;
        renderHome();
      });
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
    if (srcText.includes(q)) return true;
    return false;
  }

  function placeholderThumbSvg() {
    return `
      <svg viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="32" cy="32" r="20"/>
        <circle cx="32" cy="32" r="13"/>
        <path d="M16 14v8c0 2 1 3 3 3v15M19 14v11"/>
        <path d="M48 14c-3 0-5 3-5 6s2 5 5 5v15"/>
      </svg>`;
  }

  function renderRecipeList() {
    const list = document.getElementById('recipe-list');
    const emptyAll = document.getElementById('empty-state');
    const emptyResults = document.getElementById('no-results');

    let filtered = recipes.slice();
    if (activeFilter === 'Bookmarked') {
      filtered = filtered.filter(r => r.bookmarked);
    } else if (activeFilter !== 'All') {
      filtered = filtered.filter(r => (r.categories || []).includes(activeFilter));
    }
    if (searchTerm) filtered = filtered.filter(r => matchesSearch(r, searchTerm));
    filtered.sort((a, b) => {
      const ab = a.bookmarked ? 1 : 0;
      const bb = b.bookmarked ? 1 : 0;
      if (ab !== bb) return bb - ab;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    if (recipes.length === 0) {
      list.innerHTML = '';
      emptyAll.hidden = false;
      emptyResults.hidden = true;
      return;
    }
    emptyAll.hidden = true;

    if (filtered.length === 0) {
      list.innerHTML = '';
      emptyResults.hidden = false;
      return;
    }
    emptyResults.hidden = true;

    list.innerHTML = filtered.map(r => {
      const thumb0 = (r.images && r.images[0]) || r.image || null;
      const cats = (r.categories || []).slice(0, 3).map(c =>
        `<span class="recipe-card__cat">${escapeHtml(c)}</span>`
      ).join('');
      const thumbEl = thumb0
        ? `<div class="recipe-card__thumb" style="background-image:url('${thumb0}')"></div>`
        : `<div class="recipe-card__thumb recipe-card__thumb--placeholder">${placeholderThumbSvg()}</div>`;
      const bookmarkBadge = r.bookmarked
        ? `<div class="recipe-card__bookmark" aria-label="Bookmarked">${bookmarkIconInline()}</div>`
        : '';
      return `
        <button type="button" class="recipe-card ${r.bookmarked ? 'recipe-card--bookmarked' : ''}" data-id="${r.id}">
          ${thumbEl}
          <div class="recipe-card__body">
            <h2 class="recipe-card__title">${escapeHtml(r.title || 'Untitled')}</h2>
            <div class="recipe-card__cats">${cats}</div>
          </div>
          ${bookmarkBadge}
        </button>
      `;
    }).join('');

    list.querySelectorAll('.recipe-card').forEach(card => {
      card.addEventListener('click', () => navigate('#/recipe/' + card.dataset.id));
    });
  }

  // ---------- Recipe detail ----------
  function renderRecipe(r) {
    const wrap = document.getElementById('recipe-detail');

    // Images: support multiple
    const imgs = (r.images && r.images.length) ? r.images : (r.image ? [r.image] : []);
    let imgHtml = '';
    if (imgs.length === 1) {
      imgHtml = `<div class="recipe-detail__image" style="background-image:url('${imgs[0]}')"></div>`;
    } else if (imgs.length > 1) {
      const thumbs = imgs.map(img =>
        `<div class="recipe-gallery__thumb" style="background-image:url('${img}')"></div>`
      ).join('');
      imgHtml = `<div class="recipe-gallery">${thumbs}</div>`;
    }

    const cats = (r.categories || []).map(c =>
      `<span class="recipe-detail__cat">${escapeHtml(c)}</span>`
    ).join('');

    let ingredientsHtml = '';
    if ((r.ingredients || []).length) {
      ingredientsHtml = `
        <div class="section">
          <h3 class="section__title">Ingredients</h3>
          <ul class="section__list section__list--ingredients">
            ${r.ingredients.map(i => `<li>${escapeHtml(i)}</li>`).join('')}
          </ul>
        </div>`;
    }

    let methodHtml = '';
    if ((r.method || []).length) {
      methodHtml = `
        <div class="section">
          <h3 class="section__title">Method</h3>
          <ol class="section__list section__list--method">
            ${r.method.map(m => `<li>${escapeHtml(m)}</li>`).join('')}
          </ol>
        </div>`;
    }

    let sourceHtml = '';
    const src = r.source || {};
    const srcUrl   = (typeof src === 'string' ? (/^https?:\/\//i.test(src.trim()) ? src.trim() : '') : (src.url || '')).trim();
    const srcTitle = (typeof src === 'string' ? (!srcUrl ? src.trim() : '') : (src.title || '')).trim();
    if (srcUrl || srcTitle) {
      let content;
      if (srcUrl && srcTitle) {
        content = `<a href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener" class="source-link">${escapeHtml(srcTitle)}</a>`;
      } else if (srcUrl) {
        const display = titleFromUrl(srcUrl) || srcUrl;
        content = `<a href="${escapeHtml(srcUrl)}" target="_blank" rel="noopener" class="source-link">${escapeHtml(display)}</a>`;
      } else {
        content = escapeHtml(srcTitle);
      }
      sourceHtml = `
        <div class="section">
          <h3 class="section__title">Source</h3>
          <p class="section__text">${content}</p>
        </div>`;
    }

    let notesHtml = '';
    if (r.notes && r.notes.trim()) {
      notesHtml = `
        <div class="section">
          <h3 class="section__title">Notes</h3>
          <p class="section__text">${escapeHtml(r.notes)}</p>
        </div>`;
    }

    wrap.innerHTML = `
      ${imgHtml}
      <h1 class="recipe-detail__title">${escapeHtml(r.title || 'Untitled')}</h1>
      ${cats ? `<div class="recipe-detail__cats">${cats}</div>` : ''}
      ${ingredientsHtml}
      ${methodHtml}
      ${sourceHtml}
      ${notesHtml}
    `;

    const bookmarkBtn = document.getElementById('recipe-bookmark');
    if (r.bookmarked) bookmarkBtn.classList.add('is-bookmarked');
    else bookmarkBtn.classList.remove('is-bookmarked');
  }

  function toggleBookmark(id) {
    const idx = recipes.findIndex(r => r.id === id);
    if (idx < 0) return;
    recipes[idx].bookmarked = !recipes[idx].bookmarked;
    saveRecipes();
    const bookmarkBtn = document.getElementById('recipe-bookmark');
    if (recipes[idx].bookmarked) bookmarkBtn.classList.add('is-bookmarked');
    else bookmarkBtn.classList.remove('is-bookmarked');
    toast(recipes[idx].bookmarked ? 'Bookmarked' : 'Bookmark removed');
  }

  // ---------- Form ----------
  function openForm(recipe) {
    const titleEl          = document.getElementById('edit-title');
    const titleInput       = document.getElementById('title-input');
    const ingredientsInput = document.getElementById('ingredients-input');
    const methodInput      = document.getElementById('method-input');
    const sourceUrlInput   = document.getElementById('source-url-input');
    const sourceTitleInput = document.getElementById('source-title-input');
    const notesInput       = document.getElementById('notes-input');

    if (recipe) {
      editingId = recipe.id;
      titleEl.textContent = 'Edit Recipe';
      titleInput.value = recipe.title || '';
      ingredientsInput.value = (recipe.ingredients || []).join('\n');
      methodInput.value = (recipe.method || []).join('\n');
      const src = recipe.source || {};
      sourceUrlInput.value   = typeof src === 'string'
        ? (/^https?:\/\//i.test(src.trim()) ? src.trim() : '')
        : (src.url || '');
      sourceTitleInput.value = typeof src === 'string'
        ? (!sourceUrlInput.value ? src.trim() : '')
        : (src.title || '');
      notesInput.value = recipe.notes || '';
      editingCategories = [...(recipe.categories || [])];
      editingImages = [...((recipe.images && recipe.images.length) ? recipe.images : (recipe.image ? [recipe.image] : []))];
    } else {
      editingId = null;
      titleEl.textContent = 'New Recipe';
      titleInput.value = '';
      ingredientsInput.value = '';
      methodInput.value = '';
      sourceUrlInput.value = '';
      sourceTitleInput.value = '';
      notesInput.value = '';
      editingCategories = [];
      editingImages = [];
    }

    document.getElementById('image-input').value = '';
    document.getElementById('import-input').value = '';
    document.getElementById('new-category-input').value = '';
    renderImageStrip();
    renderCategoryPickers();
  }

  // Render the image area in the edit form
  function renderImageStrip() {
    const emptyLabel  = document.getElementById('image-upload-empty');
    const stripWrap   = document.getElementById('image-strip-wrap');
    const strip       = document.getElementById('image-strip');

    if (editingImages.length === 0) {
      emptyLabel.hidden = false;
      stripWrap.hidden  = true;
      strip.innerHTML   = '';
    } else {
      emptyLabel.hidden = true;
      stripWrap.hidden  = false;
      strip.innerHTML   = editingImages.map((img, i) => `
        <div class="img-thumb">
          <div class="img-thumb__img" style="background-image:url('${img}')"></div>
          <button type="button" class="img-thumb__remove" data-idx="${i}" aria-label="Remove photo">✕</button>
        </div>
      `).join('');
      strip.querySelectorAll('.img-thumb__remove').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          editingImages.splice(parseInt(btn.dataset.idx, 10), 1);
          renderImageStrip();
        });
      });
    }
  }

  function renderCategoryPickers() {
    const wrap = document.getElementById('category-pickers');
    const known = allCategories();
    const merged = [...known];
    editingCategories.forEach(c => {
      if (!merged.some(k => k.toLowerCase() === c.toLowerCase()) &&
          !SPECIAL_CATEGORIES.some(s => s.toLowerCase() === c.toLowerCase())) {
        merged.push(c);
      }
    });

    // Special categories always pinned at top
    const specialHtml = SPECIAL_CATEGORIES.map(c => {
      const active = editingCategories.some(x => x.toLowerCase() === c.toLowerCase()) ? 'cat-pick--active' : '';
      const icon = c === 'Made' ? checkIconInline() : starIconInline();
      const cls  = c === 'Made' ? 'cat-pick--made' : 'cat-pick--want';
      return `<button type="button" class="cat-pick ${cls} ${active}" data-cat="${escapeHtml(c)}">${icon}${escapeHtml(c)}</button>`;
    }).join('');

    const regularHtml = merged.map(c => {
      const active = editingCategories.some(x => x.toLowerCase() === c.toLowerCase()) ? 'cat-pick--active' : '';
      return `<button type="button" class="cat-pick ${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    }).join('');

    wrap.innerHTML = specialHtml + '<div class="cat-divider"></div>' + regularHtml;

    wrap.querySelectorAll('.cat-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.cat;
        const idx = editingCategories.findIndex(x => x.toLowerCase() === cat.toLowerCase());
        if (idx >= 0) editingCategories.splice(idx, 1);
        else editingCategories.push(cat);
        renderCategoryPickers();
      });
    });
  }

  function addNewCategoryFromInput() {
    const input = document.getElementById('new-category-input');
    const val = input.value.trim();
    if (!val) return;
    const known = allCategories();
    if (!known.some(k => k.toLowerCase() === val.toLowerCase())) {
      userCategories.push(val);
      saveCategories();
    }
    if (!editingCategories.some(x => x.toLowerCase() === val.toLowerCase())) {
      editingCategories.push(val);
    }
    input.value = '';
    renderCategoryPickers();
  }

  function saveRecipeFromForm() {
    const title        = document.getElementById('title-input').value.trim();
    const ingredients  = splitLines(document.getElementById('ingredients-input').value);
    const method       = splitLines(document.getElementById('method-input').value);
    const sourceUrl    = document.getElementById('source-url-input').value.trim();
    const sourceTitle  = document.getElementById('source-title-input').value.trim();
    const notes        = document.getElementById('notes-input').value.trim();

    if (!title) {
      toast('Please add a title');
      document.getElementById('title-input').focus();
      return;
    }

    const source = { url: sourceUrl, title: sourceTitle };
    const now = Date.now();

    if (editingId) {
      const idx = recipes.findIndex(r => r.id === editingId);
      if (idx >= 0) {
        recipes[idx] = {
          ...recipes[idx],
          title, ingredients, method, source, notes,
          categories: [...editingCategories],
          images: [...editingImages],
          image: editingImages[0] || null,   // compat field
          updatedAt: now,
        };
        saveRecipes();
        toast('Saved');
        navigate('#/recipe/' + editingId);
      }
    } else {
      const id = uid();
      recipes.unshift({
        id, title, ingredients, method, source, notes,
        categories: [...editingCategories],
        images: [...editingImages],
        image: editingImages[0] || null,   // compat field
        createdAt: now,
        updatedAt: now,
      });
      saveRecipes();
      toast('Saved');
      navigate('#/recipe/' + id);
    }
  }

  // ---------- Image helpers ----------
  function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
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
          else { width = Math.round(width * (maxDim / height)); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        try { resolve(canvas.toDataURL('image/jpeg', quality)); }
        catch (e) { reject(e); }
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = dataUrl;
    });
  }

  // Single file → cropper
  async function handleImageFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('Please choose an image');
      return;
    }
    try {
      const dataUrl = await fileToDataUrl(file);
      await openCropper(dataUrl);
    } catch (err) {
      console.error(err);
      toast('Could not load image');
    }
  }

  // Multiple files → compress & add all directly (no cropper)
  async function handleMultipleImageFiles(files) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imageFiles.length) return;
    showLoading(`Adding ${imageFiles.length} photo${imageFiles.length > 1 ? 's' : ''}…`);
    try {
      for (const file of imageFiles) {
        const raw = await fileToDataUrl(file);
        const compressed = await compressDataUrl(raw, 1200, 0.82);
        editingImages.push(compressed);
      }
      renderImageStrip();
    } catch (err) {
      console.error(err);
      toast('Could not process images');
    } finally {
      hideLoading();
    }
  }

  // ---------- Cropper ----------
  async function openCropper(dataUrl) {
    try {
      loadCssOnce(CROPPER_CSS);
      await loadScriptOnce(CROPPER_JS);
    } catch (err) {
      toast('Cropper unavailable — adding photo as-is');
      try {
        const compressed = await compressDataUrl(dataUrl, 1200, 0.82);
        editingImages.push(compressed);
        renderImageStrip();
      } catch (e) { toast('Could not add photo'); }
      return;
    }

    if (typeof Cropper === 'undefined') {
      toast('Cropper unavailable — adding photo as-is');
      try {
        const compressed = await compressDataUrl(dataUrl, 1200, 0.82);
        editingImages.push(compressed);
        renderImageStrip();
      } catch (e) { toast('Could not add photo'); }
      return;
    }

    showView('cropper');
    const img = document.getElementById('cropper-img');

    // Destroy any existing instance first
    destroyCropper();

    // Use onload rather than setTimeout for reliable initialization
    img.onload = () => {
      // Guard: view may have changed before image loaded
      if (!document.getElementById('view-cropper').classList.contains('view--active')) return;
      if (cropperInstance) {
        try { cropperInstance.destroy(); } catch (e) { /* ignore */ }
        cropperInstance = null;
      }
      cropperInstance = new Cropper(img, {
        aspectRatio: NaN,
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
    img.onerror = () => {
      toast('Could not load image for cropping');
      showView('edit');
    };
    // Reset src first so onload always fires
    img.src = '';
    img.src = dataUrl;
  }

  function destroyCropper() {
    if (cropperInstance) {
      try { cropperInstance.destroy(); } catch (e) { /* ignore */ }
      cropperInstance = null;
    }
    const img = document.getElementById('cropper-img');
    if (img) { img.onload = null; img.onerror = null; }
  }

  function commitCropper() {
    if (!cropperInstance) return;
    const canvas = cropperInstance.getCroppedCanvas({
      maxWidth: 1600,
      maxHeight: 1600,
      imageSmoothingQuality: 'high',
    });
    if (!canvas) { toast('Crop failed'); return; }
    let dataUrl;
    try { dataUrl = canvas.toDataURL('image/jpeg', 0.82); }
    catch (err) { toast('Could not save crop'); return; }

    editingImages.push(dataUrl);
    renderImageStrip();
    destroyCropper();
    showView('edit');
  }

  function cancelCropper() {
    destroyCropper();
    document.getElementById('image-input').value = '';
    showView('edit');
  }

  // ---------- Loading overlay ----------
  function showLoading(msg) {
    document.getElementById('loading-overlay-msg').textContent = msg || 'Loading…';
    document.getElementById('loading-overlay').hidden = false;
  }
  function hideLoading() {
    document.getElementById('loading-overlay').hidden = true;
  }

  // ---------- OCR import — supports multiple files ----------
  async function importFromPhotos(files) {
    const imageFiles = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imageFiles.length) { toast('Please choose an image'); return; }

    showLoading('Preparing images…');
    const dataUrls = [];
    for (const file of imageFiles) {
      try {
        const raw = await fileToDataUrl(file);
        const compressed = await compressDataUrl(raw, 1568, 0.85);
        dataUrls.push(compressed);
      } catch (e) { console.error('Could not prepare image', e); }
    }
    if (!dataUrls.length) { hideLoading(); toast('Could not load images'); return; }

    showLoading('Loading OCR…');
    try {
      await loadScriptOnce(TESSERACT_JS);
    } catch (e) {
      hideLoading();
      toast('Could not load OCR — need internet');
      return;
    }
    if (typeof Tesseract === 'undefined') {
      hideLoading();
      toast('OCR not available');
      return;
    }

    const texts = [];
    for (let i = 0; i < dataUrls.length; i++) {
      try {
        const result = await Tesseract.recognize(dataUrls[i], 'eng', {
          logger: (m) => {
            if (!m) return;
            const prefix = dataUrls.length > 1 ? `Photo ${i + 1}/${dataUrls.length}: ` : '';
            if (m.status === 'recognizing text') {
              const pct = Math.round((m.progress || 0) * 100);
              document.getElementById('loading-overlay-msg').textContent = `${prefix}Reading text… ${pct}%`;
            } else if (m.status) {
              document.getElementById('loading-overlay-msg').textContent =
                prefix + m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
            }
          }
        });
        const text = (result && result.data && result.data.text || '').trim();
        if (text) texts.push(text);
      } catch (err) {
        console.error('OCR failed for image', i, err);
      }
    }

    hideLoading();
    document.getElementById('import-input').value = '';

    if (!texts.length) { toast('No text found in image'); return; }
    document.getElementById('ocr-text').value = texts.join('\n\n---\n\n');
    showView('ocr');
  }

  function applyOcrTo(field) {
    const text = document.getElementById('ocr-text').value || '';
    const target = document.getElementById(field === 'method' ? 'method-input' : 'ingredients-input');
    target.value = text;
    showView('edit');
    setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    toast(field === 'method' ? 'Set as Method' : 'Set as Ingredients');
  }

  // ---------- Export ----------
  function exportData() {
    try {
      const data = JSON.stringify(recipes, null, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `supper-club-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast('Recipes exported');
    } catch (e) {
      toast('Export failed');
    }
  }

  // ---------- Sharing ----------
  function formatForShare(r) {
    const lines = [];
    lines.push((r.title || 'Untitled').toUpperCase());
    lines.push('');
    if ((r.categories || []).length) {
      lines.push(r.categories.join(' · '));
      lines.push('');
    }
    if ((r.ingredients || []).length) {
      lines.push('INGREDIENTS');
      r.ingredients.forEach(i => lines.push('• ' + i));
      lines.push('');
    }
    if ((r.method || []).length) {
      lines.push('METHOD');
      r.method.forEach((m, i) => lines.push((i + 1) + '. ' + m));
      lines.push('');
    }
    const src = r.source || {};
    const srcTitle = typeof src === 'string' ? src : ((src.title || src.url || '').trim());
    if (srcTitle) {
      lines.push('SOURCE');
      lines.push(srcTitle);
      lines.push('');
    }
    if (r.notes && r.notes.trim()) {
      lines.push('NOTES');
      lines.push(r.notes.trim());
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  async function shareRecipe(r) {
    const text = formatForShare(r);
    if (navigator.share) {
      try {
        await navigator.share({ title: r.title || 'Recipe', text });
        return;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
      }
    }
    const url = 'https://wa.me/?text=' + encodeURIComponent(text);
    window.open(url, '_blank', 'noopener');
  }

  // ---------- Delete ----------
  function askDelete(id) {
    const r = recipes.find(x => x.id === id);
    if (!r) return;
    pendingDeleteId = id;
    document.getElementById('confirm-sub').textContent =
      `"${r.title || 'Untitled'}" will be removed permanently.`;
    navigate('#/confirm-delete');
  }

  function doDelete() {
    if (!pendingDeleteId) return;
    recipes = recipes.filter(r => r.id !== pendingDeleteId);
    saveRecipes();
    pendingDeleteId = null;
    toast('Deleted');
    navigate('#/');
  }

  // ---------- Event wiring ----------
  function wireEvents() {
    // Home
    document.getElementById('fab-add').addEventListener('click', () => navigate('#/new'));
    document.getElementById('search-input').addEventListener('input', (e) => {
      searchTerm = e.target.value.trim();
      renderRecipeList();
    });
    document.getElementById('export-btn').addEventListener('click', exportData);

    // Recipe detail
    document.getElementById('recipe-back').addEventListener('click', () => navigate('#/'));
    document.getElementById('recipe-edit').addEventListener('click', () => {
      if (currentRecipeId) navigate('#/edit/' + currentRecipeId);
    });
    document.getElementById('recipe-delete').addEventListener('click', () => {
      if (currentRecipeId) askDelete(currentRecipeId);
    });
    document.getElementById('recipe-share').addEventListener('click', () => {
      const r = recipes.find(x => x.id === currentRecipeId);
      if (r) shareRecipe(r);
    });
    document.getElementById('recipe-bookmark').addEventListener('click', () => {
      if (currentRecipeId) toggleBookmark(currentRecipeId);
    });

    // Edit form
    document.getElementById('edit-cancel').addEventListener('click', () => {
      if (editingId) navigate('#/recipe/' + editingId);
      else navigate('#/');
    });
    document.getElementById('edit-save').addEventListener('click', saveRecipeFromForm);

    // Image input: single → cropper, multiple → direct compress
    document.getElementById('image-input').addEventListener('change', (e) => {
      const files = e.target.files;
      if (!files || files.length === 0) return;
      if (files.length === 1) {
        handleImageFile(files[0]);
      } else {
        handleMultipleImageFiles(Array.from(files));
      }
      e.target.value = '';
    });

    // Cropper view
    document.getElementById('cropper-done').addEventListener('click', commitCropper);
    document.getElementById('cropper-cancel').addEventListener('click', cancelCropper);

    // Import from photo — multiple files supported
    document.getElementById('import-btn').addEventListener('click', () => {
      document.getElementById('import-input').click();
    });
    document.getElementById('import-input').addEventListener('change', (e) => {
      const files = e.target.files;
      if (files && files.length) importFromPhotos(files);
    });

    // Source URL → auto-suggest title on blur
    document.getElementById('source-url-input').addEventListener('blur', (e) => {
      const url = e.target.value.trim();
      const titleInput = document.getElementById('source-title-input');
      if (url && !titleInput.value.trim()) {
        const suggested = titleFromUrl(url);
        if (suggested) titleInput.value = suggested;
      }
    });

    // Category quick-add
    document.getElementById('new-category-btn').addEventListener('click', addNewCategoryFromInput);
    document.getElementById('new-category-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addNewCategoryFromInput(); }
    });

    // OCR review
    document.getElementById('ocr-cancel').addEventListener('click', () => showView('edit'));
    document.getElementById('ocr-to-ingredients').addEventListener('click', () => applyOcrTo('ingredients'));
    document.getElementById('ocr-to-method').addEventListener('click', () => applyOcrTo('method'));

    // Confirm delete
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      pendingDeleteId = null;
      if (currentRecipeId && recipes.find(r => r.id === currentRecipeId)) {
        navigate('#/recipe/' + currentRecipeId);
      } else {
        navigate('#/');
      }
    });
    document.getElementById('confirm-ok').addEventListener('click', doDelete);

    // Routing
    window.addEventListener('hashchange', handleHash);
  }

  // ---------- PWA ----------
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => { /* ignore */ });
      });
    }
  }

  function init() {
    wireEvents();
    handleHash();
    registerServiceWorker();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
