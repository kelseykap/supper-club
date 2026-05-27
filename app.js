/* =====================================================
   LE — Recipe app
   Local-storage CRUD + simple hash routing
   ===================================================== */

(function () {
  'use strict';

  // ---------- Constants ----------
  const STORAGE_KEY = 'le.recipes.v1';
  const CATEGORIES_KEY = 'le.categories.v1';
  const DEFAULT_CATEGORIES = [
    'Breakfast', 'Lunch', 'Dinner', 'Dessert',
    'Snack', 'Drinks', 'Baking', 'Salad', 'Soup', 'Side'
  ];

  // ---------- State ----------
  let recipes = loadRecipes();
  let userCategories = loadCategories();
  let activeFilter = 'All';
  let searchTerm = '';
  let editingId = null;          // null = new recipe, else id of recipe being edited
  let editingImage = null;       // base64 string or null
  let editingCategories = [];    // array of category strings selected on the form
  let currentRecipeId = null;    // currently being viewed
  let pendingDeleteId = null;

  // ---------- Storage ----------
  function loadRecipes() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('Failed to load recipes', e);
      return [];
    }
  }
  function saveRecipes() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(recipes));
    } catch (e) {
      console.error('Failed to save recipes', e);
      toast('Could not save — storage full?');
    }
  }
  function loadCategories() {
    try {
      const raw = localStorage.getItem(CATEGORIES_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }
  function saveCategories() {
    try {
      localStorage.setItem(CATEGORIES_KEY, JSON.stringify(userCategories));
    } catch (e) { /* ignore */ }
  }

  function allCategories() {
    // Default list + user-added, de-duplicated, preserving order
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
    toast._t = setTimeout(() => { el.hidden = true; }, 2200);
  }

  // ---------- Routing ----------
  function showView(name) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
    const view = document.getElementById('view-' + name);
    if (view) view.classList.add('view--active');
    window.scrollTo(0, 0);
  }

  function navigate(hash) {
    if (location.hash === hash) {
      handleHash();
    } else {
      location.hash = hash;
    }
  }

  function handleHash() {
    const h = location.hash || '#/';
    if (h === '#/' || h === '') {
      currentRecipeId = null;
      renderHome();
      showView('home');
      return;
    }
    const m = h.match(/^#\/recipe\/([^\/]+)$/);
    if (m) {
      const id = m[1];
      const r = recipes.find(x => x.id === id);
      if (!r) { navigate('#/'); return; }
      currentRecipeId = id;
      renderRecipe(r);
      showView('recipe');
      return;
    }
    if (h === '#/new') {
      openForm(null);
      showView('edit');
      return;
    }
    const em = h.match(/^#\/edit\/([^\/]+)$/);
    if (em) {
      const id = em[1];
      const r = recipes.find(x => x.id === id);
      if (!r) { navigate('#/'); return; }
      openForm(r);
      showView('edit');
      return;
    }
    if (h === '#/confirm-delete') {
      showView('confirm');
      return;
    }
    // Unknown — go home
    navigate('#/');
  }

  // ---------- Home rendering ----------
  function renderHome() {
    renderFilterChips();
    renderRecipeList();
  }

  function renderFilterChips() {
    const wrap = document.getElementById('filter-chips');
    // Build list: All + any category that has at least one recipe
    const usedCats = new Set();
    recipes.forEach(r => (r.categories || []).forEach(c => usedCats.add(c)));
    const chips = ['All', ...Array.from(usedCats).sort((a, b) => a.localeCompare(b))];
    wrap.innerHTML = chips.map(c => {
      const active = c === activeFilter ? 'chip--active' : '';
      return `<button type="button" class="chip ${active}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`;
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

  function renderRecipeList() {
    const list = document.getElementById('recipe-list');
    const emptyAll = document.getElementById('empty-state');
    const emptyResults = document.getElementById('no-results');

    let filtered = recipes.slice();
    if (activeFilter !== 'All') {
      filtered = filtered.filter(r => (r.categories || []).includes(activeFilter));
    }
    if (searchTerm) {
      filtered = filtered.filter(r => matchesSearch(r, searchTerm));
    }

    // Sort: most recently updated first
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

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
        : `<div class="recipe-card__thumb">
             <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11h18M5 11V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v4M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8"/></svg>
           </div>`;
      return `
        <button type="button" class="recipe-card" data-id="${r.id}">
          ${thumb}
          <div class="recipe-card__body">
            <h2 class="recipe-card__title">${escapeHtml(r.title || 'Untitled')}</h2>
            <div class="recipe-card__cats">${cats}</div>
          </div>
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
      ${notesHtml}
    `;
  }

  // ---------- Form ----------
  function openForm(recipe) {
    const titleEl = document.getElementById('edit-title');
    const titleInput = document.getElementById('title-input');
    const ingredientsInput = document.getElementById('ingredients-input');
    const methodInput = document.getElementById('method-input');
    const notesInput = document.getElementById('notes-input');
    const preview = document.getElementById('image-preview');
    const removeBtn = document.getElementById('image-remove');

    if (recipe) {
      editingId = recipe.id;
      titleEl.textContent = 'Edit Recipe';
      titleInput.value = recipe.title || '';
      ingredientsInput.value = (recipe.ingredients || []).join('\n');
      methodInput.value = (recipe.method || []).join('\n');
      notesInput.value = recipe.notes || '';
      editingCategories = [...(recipe.categories || [])];
      editingImage = recipe.image || null;
    } else {
      editingId = null;
      titleEl.textContent = 'New Recipe';
      titleInput.value = '';
      ingredientsInput.value = '';
      methodInput.value = '';
      notesInput.value = '';
      editingCategories = [];
      editingImage = null;
    }

    // Image preview
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
    document.getElementById('new-category-input').value = '';
    renderCategoryPickers();
  }

  function renderCategoryPickers() {
    const wrap = document.getElementById('category-pickers');
    // Merge: all known categories + any already on this recipe (case-insensitive)
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
    // Don't duplicate (case-insensitive)
    const known = allCategories();
    const exists = known.some(k => k.toLowerCase() === val.toLowerCase());
    if (!exists) {
      userCategories.push(val);
      saveCategories();
    }
    // Select it if not selected
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
          title, ingredients, method, notes,
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
      const recipe = {
        id, title, ingredients, method, notes,
        categories: [...editingCategories],
        image: editingImage,
        createdAt: now,
        updatedAt: now,
      };
      recipes.unshift(recipe);
      saveRecipes();
      toast('Saved');
      navigate('#/recipe/' + id);
    }
  }

  // ---------- Image handling ----------
  function handleImageFile(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('Please choose an image');
      return;
    }
    // Resize/compress to keep localStorage reasonable
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 1200;
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
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        try {
          editingImage = canvas.toDataURL('image/jpeg', 0.82);
        } catch (err) {
          editingImage = e.target.result;
        }
        const preview = document.getElementById('image-preview');
        preview.classList.add('has-image');
        preview.style.backgroundImage = `url('${editingImage}')`;
        document.getElementById('image-remove').hidden = false;
      };
      img.onerror = () => toast('Could not load image');
      img.src = e.target.result;
    };
    reader.onerror = () => toast('Could not read file');
    reader.readAsDataURL(file);
  }

  function removeImage() {
    editingImage = null;
    const preview = document.getElementById('image-preview');
    preview.classList.remove('has-image');
    preview.style.backgroundImage = '';
    document.getElementById('image-remove').hidden = true;
    document.getElementById('image-input').value = '';
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
    if (r.notes && r.notes.trim()) {
      lines.push('NOTES');
      lines.push(r.notes.trim());
      lines.push('');
    }
    return lines.join('\n').trim();
  }

  async function shareRecipe(r) {
    const text = formatForShare(r);
    // Try the Web Share API first (mobile native sheet — gives the user WhatsApp/etc.)
    if (navigator.share) {
      try {
        await navigator.share({ title: r.title || 'Recipe', text });
        return;
      } catch (e) {
        // User cancelled or share failed — fall through to WhatsApp
        if (e && e.name === 'AbortError') return;
      }
    }
    // Fallback: open WhatsApp web share link
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

    // Edit form
    document.getElementById('edit-cancel').addEventListener('click', () => {
      if (editingId) navigate('#/recipe/' + editingId);
      else navigate('#/');
    });
    document.getElementById('edit-save').addEventListener('click', saveRecipeFromForm);

    // Image
    document.getElementById('image-input').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) handleImageFile(file);
    });
    document.getElementById('image-remove').addEventListener('click', removeImage);

    // Category quick-add
    document.getElementById('new-category-btn').addEventListener('click', addNewCategoryFromInput);
    document.getElementById('new-category-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addNewCategoryFromInput();
      }
    });

    // Confirm dialog
    document.getElementById('confirm-cancel').addEventListener('click', () => {
      pendingDeleteId = null;
      // Go back to the recipe (or home if it no longer exists)
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

  // ---------- PWA: register service worker ----------
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('service-worker.js').catch(() => { /* ignore */ });
      });
    }
  }

  // ---------- Init ----------
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
