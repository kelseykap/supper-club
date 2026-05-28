/* =====================================================
   Supper Club — Recipe app
   Local-storage CRUD + hash routing
   Image cropping (Cropper.js) + AI import (Claude API)
   ===================================================== */

(function () {
  'use strict';

  // ---------- Constants ----------
  const STORAGE_KEY = 'le.recipes.v1';
  const CATEGORIES_KEY = 'le.categories.v1';
  const API_KEY_KEY = 'le.apiKey.v1';
  const DEFAULT_CATEGORIES = [
    'Breakfast', 'Lunch', 'Dinner', 'Dessert',
    'Snack', 'Drinks', 'Baking', 'Salad', 'Soup', 'Side'
  ];
  const CROPPER_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.css';
  const CROPPER_JS = 'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.2/cropper.min.js';
  const TESSERACT_JS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  const CLAUDE_MODEL = 'claude-haiku-4-5';
  const CLAUDE_ENDPOINT = 'https://api.anthropic.com/v1/messages';
  const CLAUDE_VERSION = '2023-06-01';
  const IMPORT_PROMPT =
`You are extracting a recipe from an image. Look at the image and return ONLY a valid JSON object (no markdown fences, no prose, no explanation) with these exact keys:

{
  "title": "the recipe name (string)",
  "ingredients": ["each ingredient as one string, keep quantities"],
  "method": ["each step as one string, in order"],
  "source": "where the recipe is from if mentioned (book, website, person), otherwise an empty string",
  "notes": "any tips, variations or notes mentioned, otherwise an empty string",
  "categories": ["1-3 categories, prefer these when they fit: Breakfast, Lunch, Dinner, Dessert, Snack, Drinks, Baking, Salad, Soup, Side"]
}

Rules:
- Keep ingredient and method text exactly as written when possible
- Do NOT include numbering in the strings (no "1." prefix on method steps)
- If a field is not present in the image, use empty string ("") or empty array ([])
- If the image is not a recipe, return all fields empty
- Output ONLY the JSON object`;

  // ---------- State ----------
  let recipes = loadRecipes();
  let userCategories = loadCategories();
  let activeFilter = 'All';
  let searchTerm = '';
  let editingId = null;
  let editingImage = null;
  let editingCategories = [];
  let currentRecipeId = null;
  let pendingDeleteId = null;
  let cropperInstance = null;
  let lastImportDataUrl = null;   // kept around for OCR fallback after Claude fails

  // ---------- Storage ----------
  function loadRecipes() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
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
  function loadApiKey() {
    try { return localStorage.getItem(API_KEY_KEY) || ''; }
    catch (e) { return ''; }
  }
  function saveApiKey(key) {
    try {
      if (key) localStorage.setItem(API_KEY_KEY, key);
      else localStorage.removeItem(API_KEY_KEY);
    } catch (e) { /* ignore */ }
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
    if (h === '#/settings') {
      openSettings();
      showView('settings');
      return;
    }
    const m = h.match(/^#\/recipe\/([^\/]+)$/);
    if (m) {
      const r = recipes.find(x => x.id === m[1]);
      if (!r) { navigate('#/'); return; }
      currentRecipeId = m[1];
      renderRecipe(r);
      showView('recipe');
      return;
    }
    if (h === '#/new') { openForm(null); showView('edit'); return; }
    const em = h.match(/^#\/edit\/([^\/]+)$/);
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

  function bookmarkIconInline() {
    return `<svg viewBox="0 0 24 24" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`;
  }

  function renderFilterChips() {
    const wrap = document.getElementById('filter-chips');
    const usedCats = new Set();
    recipes.forEach(r => (r.categories || []).forEach(c => usedCats.add(c)));
    const hasBookmarks = recipes.some(r => r.bookmarked);
    const chips = ['All'];
    if (hasBookmarks) chips.push('Bookmarked');
    chips.push(...Array.from(usedCats).sort((a, b) => a.localeCompare(b)));

    wrap.innerHTML = chips.map(c => {
      const active = c === activeFilter ? 'chip--active' : '';
      const inner = c === 'Bookmarked'
        ? `${bookmarkIconInline()}${escapeHtml(c)}`
        : escapeHtml(c);
      return `<button type="button" class="chip ${active}" data-cat="${escapeHtml(c)}">${inner}</button>`;
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
    // Bookmarks float to top within current view, then sort by most recent
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
      const cats = (r.categories || []).slice(0, 3).map(c =>
        `<span class="recipe-card__cat">${escapeHtml(c)}</span>`
      ).join('');
      const thumb = r.image
        ? `<div class="recipe-card__thumb" style="background-image:url('${r.image}')"></div>`
        : `<div class="recipe-card__thumb recipe-card__thumb--placeholder">${placeholderThumbSvg()}</div>`;
      const bookmarkBadge = r.bookmarked
        ? `<div class="recipe-card__bookmark" aria-label="Bookmarked">${bookmarkIconInline()}</div>`
        : '';
      return `
        <button type="button" class="recipe-card ${r.bookmarked ? 'recipe-card--bookmarked' : ''}" data-id="${r.id}">
          ${thumb}
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
    const img = r.image
      ? `<div class="recipe-detail__image" style="background-image:url('${r.image}')"></div>`
      : '';
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
    if (r.source && r.source.trim()) {
      const src = r.source.trim();
      const isUrl = /^https?:\/\//i.test(src);
      const content = isUrl
        ? `<a href="${escapeHtml(src)}" target="_blank" rel="noopener" class="source-link">${escapeHtml(src)}</a>`
        : escapeHtml(src);
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
      ${img}
      <h1 class="recipe-detail__title">${escapeHtml(r.title || 'Untitled')}</h1>
      ${cats ? `<div class="recipe-detail__cats">${cats}</div>` : ''}
      ${ingredientsHtml}
      ${methodHtml}
      ${sourceHtml}
      ${notesHtml}
    `;

    // Bookmark button state
    const bookmarkBtn = document.getElementById('recipe-bookmark');
    if (r.bookmarked) bookmarkBtn.classList.add('is-bookmarked');
    else bookmarkBtn.classList.remove('is-bookmarked');
  }

  function toggleBookmark(id) {
    const idx = recipes.findIndex(r => r.id === id);
    if (idx < 0) return;
    recipes[idx].bookmarked = !recipes[idx].bookmarked;
    saveRecipes();
    // Update button state
    const bookmarkBtn = document.getElementById('recipe-bookmark');
    if (recipes[idx].bookmarked) bookmarkBtn.classList.add('is-bookmarked');
    else bookmarkBtn.classList.remove('is-bookmarked');
    toast(recipes[idx].bookmarked ? 'Bookmarked' : 'Bookmark removed');
  }

  // ---------- Form ----------
  function openForm(recipe) {
    const titleEl = document.getElementById('edit-title');
    const titleInput = document.getElementById('title-input');
    const ingredientsInput = document.getElementById('ingredients-input');
    const methodInput = document.getElementById('method-input');
    const sourceInput = document.getElementById('source-input');
    const notesInput = document.getElementById('notes-input');
    const preview = document.getElementById('image-preview');
    const removeBtn = document.getElementById('image-remove');

    if (recipe) {
      editingId = recipe.id;
      titleEl.textContent = 'Edit Recipe';
      titleInput.value = recipe.title || '';
      ingredientsInput.value = (recipe.ingredients || []).join('\n');
      methodInput.value = (recipe.method || []).join('\n');
      sourceInput.value = recipe.source || '';
      notesInput.value = recipe.notes || '';
      editingCategories = [...(recipe.categories || [])];
      editingImage = recipe.image || null;
    } else {
      editingId = null;
      titleEl.textContent = 'New Recipe';
      titleInput.value = '';
      ingredientsInput.value = '';
      methodInput.value = '';
      sourceInput.value = '';
      notesInput.value = '';
      editingCategories = [];
      editingImage = null;
    }

    if (editingImage) {
      preview.classList.add('has-image');
      preview.style.backgroundImage = `url('${editingImage}')`;
      removeBtn.hidden = false;
    } else {
      preview.classList.remove('has-image');
      preview.style.backgroundImage = '';
      removeBtn.hidden = true;
    }

    document.getElementById('image-input').value = '';
    document.getElementById('import-input').value = '';
    document.getElementById('new-category-input').value = '';
    renderCategoryPickers();
  }

  function renderCategoryPickers() {
    const wrap = document.getElementById('category-pickers');
    const known = allCategories();
    const merged = [...known];
    editingCategories.forEach(c => {
      if (!merged.some(k => k.toLowerCase() === c.toLowerCase())) merged.push(c);
    });
    wrap.innerHTML = merged.map(c => {
      const active = editingCategories.some(x => x.toLowerCase() === c.toLowerCase())
        ? 'cat-pick--active' : '';
      return `<button type="button" class="cat-pick ${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
    }).join('');
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
    const title = document.getElementById('title-input').value.trim();
    const ingredients = splitLines(document.getElementById('ingredients-input').value);
    const method = splitLines(document.getElementById('method-input').value);
    const source = document.getElementById('source-input').value.trim();
    const notes = document.getElementById('notes-input').value.trim();

    if (!title) {
      toast('Please add a title');
      document.getElementById('title-input').focus();
      return;
    }

    const now = Date.now();
    if (editingId) {
      const idx = recipes.findIndex(r => r.id === editingId);
      if (idx >= 0) {
        recipes[idx] = {
          ...recipes[idx],
          title, ingredients, method, source, notes,
          categories: [...editingCategories],
          image: editingImage,
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
        image: editingImage,
        createdAt: now,
        updatedAt: now,
      });
      saveRecipes();
      toast('Saved');
      navigate('#/recipe/' + id);
    }
  }

  // ---------- Image: file picker → cropper ----------
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
          if (width > height) {
            height = Math.round(height * (maxDim / width));
            width = maxDim;
          } else {
            width = Math.round(width * (maxDim / height));
            height = maxDim;
          }
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

  async function handleImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
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

  async function openCropper(dataUrl) {
    try {
      loadCssOnce(CROPPER_CSS);
      await loadScriptOnce(CROPPER_JS);
    } catch (err) {
      toast('Could not load cropper');
      return;
    }
    if (typeof Cropper === 'undefined') {
      toast('Cropper not available');
      return;
    }
    showView('cropper');

    const img = document.getElementById('cropper-img');
    img.src = dataUrl;

    if (cropperInstance) {
      try { cropperInstance.destroy(); } catch (e) { /* ignore */ }
      cropperInstance = null;
    }

    setTimeout(() => {
      cropperInstance = new Cropper(img, {
        aspectRatio: NaN,
        viewMode: 1,
        autoCropArea: 0.92,
        background: false,
        movable: true,
        zoomable: true,
        rotatable: false,
        scalable: false,
        cropBoxResizable: true,
        responsive: true,
        guides: true,
      });
    }, 50);
  }

  function destroyCropper() {
    if (cropperInstance) {
      try { cropperInstance.destroy(); } catch (e) { /* ignore */ }
      cropperInstance = null;
    }
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

    editingImage = dataUrl;
    const preview = document.getElementById('image-preview');
    preview.classList.add('has-image');
    preview.style.backgroundImage = `url('${dataUrl}')`;
    document.getElementById('image-remove').hidden = false;

    destroyCropper();
    showView('edit');
  }

  function cancelCropper() {
    destroyCropper();
    document.getElementById('image-input').value = '';
    showView('edit');
  }

  function removeImage() {
    editingImage = null;
    const preview = document.getElementById('image-preview');
    preview.classList.remove('has-image');
    preview.style.backgroundImage = '';
    document.getElementById('image-remove').hidden = true;
    document.getElementById('image-input').value = '';
  }

  // ---------- Settings ----------
  function openSettings() {
    const input = document.getElementById('api-key-input');
    input.value = loadApiKey();
    input.type = 'password';
    document.getElementById('api-key-toggle').textContent = 'Show';
  }

  function saveSettings() {
    const key = document.getElementById('api-key-input').value.trim();
    saveApiKey(key);
    toast(key ? 'Settings saved' : 'Key removed');
    navigate('#/');
  }

  function toggleApiKeyVisibility() {
    const input = document.getElementById('api-key-input');
    const btn = document.getElementById('api-key-toggle');
    if (input.type === 'password') {
      input.type = 'text';
      btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      btn.textContent = 'Show';
    }
  }

  function clearApiKey() {
    saveApiKey('');
    document.getElementById('api-key-input').value = '';
    toast('Key removed');
  }

  // ---------- Loading overlay ----------
  function showLoading(msg) {
    document.getElementById('loading-overlay-msg').textContent = msg || 'Loading…';
    document.getElementById('loading-overlay').hidden = false;
  }
  function hideLoading() {
    document.getElementById('loading-overlay').hidden = true;
  }

  // ---------- AI import (Claude API) ----------
  function dataUrlToBase64(dataUrl) {
    const idx = dataUrl.indexOf(',');
    return idx >= 0 ? dataUrl.substring(idx + 1) : dataUrl;
  }
  function dataUrlMediaType(dataUrl) {
    const m = dataUrl.match(/^data:([^;]+);/);
    return m ? m[1] : 'image/jpeg';
  }

  async function callClaudeWithImage(apiKey, dataUrl) {
    const base64 = dataUrlToBase64(dataUrl);
    const mediaType = dataUrlMediaType(dataUrl);

    const body = {
      model: CLAUDE_MODEL,
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          { type: 'text', text: IMPORT_PROMPT }
        ]
      }]
    };

    const res = await fetch(CLAUDE_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': CLAUDE_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      let errMsg = 'API error ' + res.status;
      try {
        const errBody = await res.json();
        if (errBody && errBody.error && errBody.error.message) {
          errMsg = errBody.error.message;
        }
      } catch (e) { /* ignore */ }
      const err = new Error(errMsg);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    const text = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');
    return text;
  }

  function parseRecipeJson(text) {
    if (!text) return null;
    // Try direct parse first
    let raw = text.trim();
    // Strip markdown code fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    // Try parse
    try { return JSON.parse(raw); } catch (e) { /* fall through */ }
    // Extract first {...} block
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e) { /* ignore */ }
    }
    return null;
  }

  function normaliseRecipe(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    const arr = (v) => Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const r = {
      title: str(parsed.title),
      ingredients: arr(parsed.ingredients),
      method: arr(parsed.method),
      source: str(parsed.source),
      notes: str(parsed.notes),
      categories: arr(parsed.categories),
    };
    // Strip leading "1. " / "2) " numbering from method steps if Claude added them
    r.method = r.method.map(s => s.replace(/^\s*\d+\s*[\.\)\-:]\s*/, '').trim());
    // Drop bullet prefixes from ingredients
    r.ingredients = r.ingredients.map(s => s.replace(/^\s*[•\-\*]\s*/, '').trim());
    return r;
  }

  function fillFormFromRecipe(r) {
    if (r.title) document.getElementById('title-input').value = r.title;
    if (r.ingredients.length) {
      document.getElementById('ingredients-input').value = r.ingredients.join('\n');
    }
    if (r.method.length) {
      document.getElementById('method-input').value = r.method.join('\n');
    }
    if (r.source) document.getElementById('source-input').value = r.source;
    if (r.notes) document.getElementById('notes-input').value = r.notes;
    if (r.categories.length) {
      // Merge with current selection (case-insensitive)
      r.categories.forEach(c => {
        if (!editingCategories.some(x => x.toLowerCase() === c.toLowerCase())) {
          editingCategories.push(c);
        }
        // Also remember category if it's new
        const known = allCategories();
        if (!known.some(k => k.toLowerCase() === c.toLowerCase())) {
          userCategories.push(c);
        }
      });
      saveCategories();
      renderCategoryPickers();
    }
  }

  function isCreditError(err) {
    if (!err) return false;
    if (err.status === 402) return true;
    const msg = (err.message || '').toLowerCase();
    return /credit|billing|quota|insufficient.*balance|too low/.test(msg);
  }

  async function importFromPhoto(file) {
    const apiKey = loadApiKey();
    if (!file || !file.type.startsWith('image/')) {
      toast('Please choose an image');
      return;
    }

    // No API key → go straight to OCR fallback (user told us so)
    if (!apiKey) {
      try {
        const rawDataUrl = await fileToDataUrl(file);
        lastImportDataUrl = await compressDataUrl(rawDataUrl, 1568, 0.85);
      } catch (e) {
        toast('Could not load image');
        return;
      }
      toast('Add API key in Settings, or use OCR');
      setTimeout(() => runOcrFallback(lastImportDataUrl), 1200);
      return;
    }

    showLoading('Reading recipe…');
    try {
      const rawDataUrl = await fileToDataUrl(file);
      lastImportDataUrl = await compressDataUrl(rawDataUrl, 1568, 0.85);

      const text = await callClaudeWithImage(apiKey, lastImportDataUrl);
      const parsed = parseRecipeJson(text);
      const recipe = normaliseRecipe(parsed);

      if (!recipe || (!recipe.title && !recipe.ingredients.length && !recipe.method.length)) {
        hideLoading();
        toast('Could not find a recipe in this image');
        return;
      }

      fillFormFromRecipe(recipe);
      hideLoading();
      toast('Recipe imported — review and save');
    } catch (err) {
      hideLoading();
      console.error(err);
      // Out of Claude credits → automatic fallback to OCR
      if (isCreditError(err)) {
        toast('Out of Claude credits — using OCR');
        setTimeout(() => runOcrFallback(lastImportDataUrl), 1200);
        return;
      }
      if (err.status === 401) {
        toast('API key not valid — check Settings');
      } else if (err.status === 429) {
        toast('Rate limited — try again in a moment');
      } else if (err.message && err.message.length < 80) {
        toast(err.message);
      } else {
        toast('Could not read recipe');
      }
    } finally {
      document.getElementById('import-input').value = '';
    }
  }

  // ---------- OCR fallback (Tesseract.js) ----------
  async function runOcrFallback(dataUrl) {
    if (!dataUrl) { toast('No image to read'); return; }
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
    document.getElementById('loading-overlay-msg').textContent = 'Reading text…';
    try {
      const result = await Tesseract.recognize(dataUrl, 'eng', {
        logger: (m) => {
          if (!m) return;
          if (m.status === 'recognizing text') {
            const pct = Math.round((m.progress || 0) * 100);
            document.getElementById('loading-overlay-msg').textContent = `Reading text… ${pct}%`;
          } else if (m.status) {
            document.getElementById('loading-overlay-msg').textContent =
              m.status.charAt(0).toUpperCase() + m.status.slice(1) + '…';
          }
        }
      });
      hideLoading();
      const text = (result && result.data && result.data.text || '').trim();
      if (!text) { toast('No text found in image'); return; }
      document.getElementById('ocr-text').value = text;
      showView('ocr');
    } catch (err) {
      hideLoading();
      console.error(err);
      toast('OCR failed');
    }
  }

  function applyOcrTo(field) {
    const text = document.getElementById('ocr-text').value || '';
    const target = document.getElementById(field === 'method' ? 'method-input' : 'ingredients-input');
    target.value = text;
    showView('edit');
    setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    toast(field === 'method' ? 'Set as Method' : 'Set as Ingredients');
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
    if (r.source && r.source.trim()) {
      lines.push('SOURCE');
      lines.push(r.source.trim());
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
    document.getElementById('settings-btn').addEventListener('click', () => navigate('#/settings'));
    document.getElementById('search-input').addEventListener('input', (e) => {
      searchTerm = e.target.value.trim();
      renderRecipeList();
    });

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

    // Recipe image (cropper)
    document.getElementById('image-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleImageFile(file);
    });
    document.getElementById('image-remove').addEventListener('click', removeImage);

    // Cropper view
    document.getElementById('cropper-done').addEventListener('click', commitCropper);
    document.getElementById('cropper-cancel').addEventListener('click', cancelCropper);

    // Import from photo (Claude API)
    document.getElementById('import-btn').addEventListener('click', () => {
      document.getElementById('import-input').click();
    });
    document.getElementById('import-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importFromPhoto(file);
    });

    // Category quick-add
    document.getElementById('new-category-btn').addEventListener('click', addNewCategoryFromInput);
    document.getElementById('new-category-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addNewCategoryFromInput();
      }
    });

    // OCR fallback review
    document.getElementById('ocr-cancel').addEventListener('click', () => showView('edit'));
    document.getElementById('ocr-to-ingredients').addEventListener('click', () => applyOcrTo('ingredients'));
    document.getElementById('ocr-to-method').addEventListener('click', () => applyOcrTo('method'));

    // Settings
    document.getElementById('settings-back').addEventListener('click', () => navigate('#/'));
    document.getElementById('settings-save').addEventListener('click', saveSettings);
    document.getElementById('api-key-toggle').addEventListener('click', toggleApiKeyVisibility);
    document.getElementById('api-key-clear').addEventListener('click', clearApiKey);

    // Confirm
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
