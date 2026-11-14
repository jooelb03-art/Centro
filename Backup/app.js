(() => {
  const STORAGE_INV = "amway_dr_inventory_v1";
  const STORAGE_CAT = "amway_dr_catalog_v1";
  const STORAGE_GCLIENT = "amway_dr_google_client_id";
  const STORAGE_GMETA = "amway_dr_google_meta";

  // Opcional: pega aquí tu Google OAuth Client ID una sola vez antes de publicar
  const DEFAULT_GOOGLE_CLIENT_ID = "";
  const GOOGLE_SCOPES =
    "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/spreadsheets";

  let inventory = [];
  let catalog = [];
  let currentPhotoData = "";
  let statusFilter = "all";
  let toastTimer = null;

  // Google Auth & Cloud state
  let googleAccessToken = "";
  let googleTokenClient = null;
  let googleMeta = { folderId: "", spreadsheetId: "" };
  let isSyncing = false;
  let pendingSync = false;

  const $ = (id) => document.getElementById(id);

  const TAB_TITLES = {
    hoy: "Hoy",
    clientes: "Clientes",
    puntos: "Puntos PV",
    inventario: "Inventario",
    prospectos: "Prospectos",
    mensajes: "Mensajes"
  };

  function formatRD(value) {
    const num = Number(value) || 0;
    const hasDecimals = Math.round(num * 100) % 100 !== 0;
    return (
      "RD$ " +
      num.toLocaleString("en-US", {
        minimumFractionDigits: hasDecimals ? 2 : 0,
        maximumFractionDigits: 2
      })
    );
  }

  function makeId(prefix = "id") {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function showToast(msg) {
    const toast = $("toast");
    toast.textContent = msg;
    toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.add("hidden"), 2600);
  }

  function loadData() {
    try {
      inventory = JSON.parse(localStorage.getItem(STORAGE_INV) || "[]");
      if (!Array.isArray(inventory)) inventory = [];
    } catch {
      inventory = [];
    }
    try {
      catalog = JSON.parse(localStorage.getItem(STORAGE_CAT) || "[]");
      if (!Array.isArray(catalog)) catalog = [];
    } catch {
      catalog = [];
    }
    try {
      googleMeta = JSON.parse(localStorage.getItem(STORAGE_GMETA) || "{}");
      if (!googleMeta || typeof googleMeta !== "object") googleMeta = {};
    } catch {
      googleMeta = {};
    }
  }

  function saveInventory(skipCloud = false) {
    localStorage.setItem(STORAGE_INV, JSON.stringify(inventory));
    if (!skipCloud && googleAccessToken) scheduleCloudSync();
  }

  function saveCatalog(skipCloud = false) {
    localStorage.setItem(STORAGE_CAT, JSON.stringify(catalog));
    if (!skipCloud && googleAccessToken) scheduleCloudSync();
  }

  // Math helpers
  function getProductMath(p) {
    const ibo = Number(p.iboPrice) || 0;
    const customer = Number(p.customerPrice) || 0;
    const special = Number(p.specialPrice) || 0;
    const shipping = Number(p.shipping) || 0;
    const tax = Number(p.tax) || 0;
    const unitsPerBox = Math.max(1, parseInt(p.unitsPerBox, 10) || 1);
    const totalUnits = Math.max(0, parseInt(p.totalUnits, 10) || 0);
    const boxes = Math.floor(totalUnits / unitsPerBox);
    const loose = totalUnits % unitsPerBox;

    const totalCost = ibo + shipping + tax;
    const profitNormal = customer - totalCost;
    const profitSpecial = special > 0 ? special - totalCost : null;
    const pv = Number(p.pv) || 0;

    return {
      ibo,
      customer,
      special,
      shipping,
      tax,
      unitsPerBox,
      totalUnits,
      boxes,
      loose,
      totalCost,
      profitNormal,
      profitSpecial,
      pv
    };
  }

  function getStockStatus(totalUnits) {
    if (totalUnits <= 0) return { key: "out", label: "Agotado", cls: "status-out" };
    if (totalUnits <= 2) return { key: "low", label: "Quedan pocas", cls: "status-low" };
    return { key: "ok", label: "En stock", cls: "status-ok" };
  }

  // Compress photo in browser so iPhone photos fit comfortably in localStorage
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("No se pudo leer la imagen"));
      reader.onload = (e) => {
        const img = new Image();
        img.onerror = () => reject(new Error("Imagen inválida"));
        img.onload = () => {
          const maxSide = 360;
          let { width, height } = img;
          if (width > height && width > maxSide) {
            height = Math.round((height * maxSide) / width);
            width = maxSide;
          } else if (height >= width && height > maxSide) {
            width = Math.round((width * maxSide) / height);
            height = maxSide;
          }
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.72));
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function setModalPhoto(dataUrl) {
    currentPhotoData = dataUrl || "";
    const img = $("photo-preview-img");
    const placeholder = $("photo-preview-box").querySelector(".photo-placeholder");
    const removeBtn = $("btn-remove-photo");
    if (currentPhotoData) {
      img.src = currentPhotoData;
      img.classList.remove("hidden");
      placeholder.classList.add("hidden");
      removeBtn.classList.remove("hidden");
    } else {
      img.src = "";
      img.classList.add("hidden");
      placeholder.classList.remove("hidden");
      removeBtn.classList.add("hidden");
    }
  }

  // Render Top Summary
  function renderSummary() {
    let totalUnits = 0;
    let totalCostVal = 0;
    let totalSaleVal = 0;
    let totalProfitVal = 0;
    let lowCount = 0;

    for (const p of inventory) {
      const m = getProductMath(p);
      totalUnits += m.totalUnits;
      totalCostVal += m.totalCost * m.totalUnits;
      totalSaleVal += m.customer * m.totalUnits;
      totalProfitVal += m.profitNormal * m.totalUnits;
      if (m.totalUnits <= 2) lowCount += 1;
    }

    $("sum-products").textContent = inventory.length;
    $("sum-units").textContent = totalUnits;
    $("sum-cost").textContent = formatRD(totalCostVal);
    $("sum-sale").textContent = formatRD(totalSaleVal);
    $("sum-profit").textContent = formatRD(totalProfitVal);
    $("sum-low").textContent = lowCount;
    $("catalog-count").textContent = catalog.length;
  }

  // Filter & Sort Inventory
  function getVisibleInventory() {
    const query = $("search-input").value.trim().toLowerCase();
    const cat = $("category-filter").value;
    const sortBy = $("sort-select").value;

    const filtered = inventory.filter((p) => {
      const m = getProductMath(p);
      if (statusFilter === "low" && (m.totalUnits === 0 || m.totalUnits > 2)) return false;
      if (statusFilter === "out" && m.totalUnits > 0) return false;
      if (cat !== "all" && p.category !== cat) return false;
      if (query) {
        const hay = `${p.name} ${p.details || ""} ${p.category}`.toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });

    filtered.sort((a, b) => {
      const ma = getProductMath(a);
      const mb = getProductMath(b);
      if (sortBy === "units-asc") return ma.totalUnits - mb.totalUnits;
      if (sortBy === "units-desc") return mb.totalUnits - ma.totalUnits;
      if (sortBy === "profit-desc") return mb.profitNormal - ma.profitNormal;
      return a.name.localeCompare(b.name, "es");
    });

    return filtered;
  }

  // Render Inventory List
  function renderInventory() {
    renderSummary();
    const listEl = $("inventory-list");
    const emptyEl = $("empty-state");
    listEl.innerHTML = "";

    if (inventory.length === 0) {
      emptyEl.classList.remove("hidden");
      return;
    }
    emptyEl.classList.add("hidden");

    const visible = getVisibleInventory();
    if (visible.length === 0) {
      listEl.innerHTML = `<div class="empty-state"><p>No hay productos que coincidan con tu búsqueda o filtro.</p></div>`;
      return;
    }

    for (const p of visible) {
      const m = getProductMath(p);
      const st = getStockStatus(m.totalUnits);

      const card = document.createElement("article");
      card.className = "product-card";
      card.dataset.id = p.id;

      const boxLabel =
        m.unitsPerBox > 1
          ? `${m.boxes} caja${m.boxes === 1 ? "" : "s"}` +
            (m.loose > 0 ? ` + ${m.loose} u.` : "") +
            ` (${m.unitsPerBox} u/caja)`
          : `${m.totalUnits} unidad${m.totalUnits === 1 ? "" : "es"}`;

      const specialLine =
        m.special > 0
          ? `<div class="metric-item">
               <span class="metric-label">Precio especial</span>
               <span class="metric-val text-special">${formatRD(m.special)} (gana ${formatRD(m.profitSpecial)})</span>
             </div>`
          : `<div class="metric-item">
               <span class="metric-label">Puntos PV</span>
               <span class="metric-val">${m.pv} PV / u.</span>
             </div>`;

      card.innerHTML = `
        <div class="product-top">
          <div class="product-thumb">
            ${p.photo ? `<img src="${p.photo}" alt="${escapeHtml(p.name)}" />` : "📦"}
          </div>
          <div class="product-head-info">
            <div class="product-title-row">
              <h3 class="product-name">${escapeHtml(p.name)}</h3>
              <span class="status-badge ${st.cls}">${st.label}</span>
            </div>
            <p class="product-meta">${escapeHtml(p.category)}${m.special > 0 && m.pv > 0 ? ` · ${m.pv} PV` : ""}</p>
            ${p.details ? `<p class="product-details">${escapeHtml(p.details)}</p>` : ""}
          </div>
        </div>

        <div class="product-metrics">
          <div class="metric-item">
            <span class="metric-label">Costo total (IBO + envío/imp.)</span>
            <span class="metric-val">${formatRD(m.totalCost)}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Precio cliente</span>
            <span class="metric-val">${formatRD(m.customer)}</span>
          </div>
          <div class="metric-item">
            <span class="metric-label">Ganancia por unidad</span>
            <span class="metric-val text-profit">${formatRD(m.profitNormal)}</span>
          </div>
          ${specialLine}
        </div>

        <div class="stock-bar">
          <span>En casa: <strong>${m.totalUnits} u.</strong></span>
          <span>${boxLabel}</span>
        </div>

        <div class="card-actions">
          <button type="button" class="action-btn action-btn-sell" data-act="sell" data-id="${p.id}">
            ✅ Vendido 1
          </button>
          <button type="button" class="action-btn action-btn-box" data-act="add-box" data-id="${p.id}">
            +1 caja
          </button>
          <button type="button" class="action-btn" data-act="sub-unit" data-id="${p.id}">
            -1 unidad
          </button>
        </div>

        <div class="card-actions-secondary">
          <button type="button" class="action-btn" data-act="edit" data-id="${p.id}">
            ✏️ Editar
          </button>
          <button type="button" class="action-btn action-btn-danger" data-act="delete" data-id="${p.id}">
            🗑️ Eliminar
          </button>
        </div>
      `;

      listEl.appendChild(card);
    }
  }

  function escapeHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Modal helpers
  function openModal(id) {
    $(id).classList.remove("hidden");
  }

  function closeModal(id) {
    $(id).classList.add("hidden");
  }

  function updateModalAutoCalc() {
    const ibo = Number($("prod-ibo").value) || 0;
    const customer = Number($("prod-customer").value) || 0;
    const special = Number($("prod-special").value) || 0;
    const shipping = Number($("prod-shipping").value) || 0;
    const tax = Number($("prod-tax").value) || 0;

    const totalCost = ibo + shipping + tax;
    const profitNormal = customer - totalCost;
    const profitSpecial = special - totalCost;

    $("calc-total-cost").textContent = formatRD(totalCost);
    $("calc-profit-normal").textContent = formatRD(profitNormal);

    if (special > 0) {
      $("calc-profit-special-row").classList.remove("hidden");
      $("calc-profit-special").textContent = formatRD(profitSpecial);
    } else {
      $("calc-profit-special-row").classList.add("hidden");
    }

    const upb = Math.max(1, parseInt($("prod-units-per-box").value, 10) || 1);
    const boxes = Math.max(0, parseInt($("prod-boxes").value, 10) || 0);
    const loose = Math.max(0, parseInt($("prod-loose").value, 10) || 0);
    const total = boxes * upb + loose;
    $("calc-total-units").textContent = `${total} unidad${total === 1 ? "" : "es"}`;
  }

  function populateCatalogPicker() {
    const select = $("catalog-pick-select");
    select.innerHTML = `<option value="">— Elegir producto guardado —</option>`;
    for (const c of catalog) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name} (${formatRD(c.customerPrice)} · ${c.pv || 0} PV)`;
      select.appendChild(opt);
    }
  }

  function openProductModal(product = null, preloadedPhoto = "") {
    $("product-form").reset();
    $("prod-id").value = "";
    $("prod-shipping").value = "0";
    $("prod-tax").value = "0";
    $("prod-units-per-box").value = "1";
    $("prod-boxes").value = "1";
    $("prod-loose").value = "0";
    $("prod-save-to-catalog").checked = false;

    populateCatalogPicker();
    $("catalog-picker-box").classList.toggle("hidden", catalog.length === 0 || !!product);

    if (product) {
      const m = getProductMath(product);
      $("modal-title").textContent = "Editar producto";
      $("prod-id").value = product.id;
      $("prod-name").value = product.name;
      $("prod-category").value = product.category || "Otro";
      $("prod-pv").value = m.pv || "";
      $("prod-details").value = product.details || "";
      $("prod-ibo").value = m.ibo;
      $("prod-customer").value = m.customer;
      $("prod-special").value = m.special > 0 ? m.special : "";
      $("prod-shipping").value = m.shipping;
      $("prod-tax").value = m.tax;
      $("prod-units-per-box").value = m.unitsPerBox;
      $("prod-boxes").value = m.boxes;
      $("prod-loose").value = m.loose;
      setModalPhoto(product.photo || "");
    } else {
      $("modal-title").textContent = preloadedPhoto ? "Confirmar producto de foto" : "Agregar producto";
      setModalPhoto(preloadedPhoto);
    }

    updateModalAutoCalc();
    openModal("product-modal");
  }

  // Catalog Modal
  function renderCatalogList() {
    const list = $("catalog-list");
    list.innerHTML = "";
    if (catalog.length === 0) {
      list.innerHTML = `<p class="field-hint">Aún no has guardado productos en tu catálogo.</p>`;
      return;
    }
    for (const c of catalog) {
      const item = document.createElement("div");
      item.className = "catalog-item";
      item.innerHTML = `
        <div class="catalog-item-info">
          <strong>${escapeHtml(c.name)}</strong>
          <span>IBO: ${formatRD(c.iboPrice)} · Cliente: ${formatRD(c.customerPrice)} · ${c.pv || 0} PV · ${c.unitsPerBox || 1} u/caja</span>
        </div>
        <button type="button" class="action-btn action-btn-danger" data-cat-del="${c.id}">🗑️</button>
      `;
      list.appendChild(item);
    }
  }

  // Event Listeners
  function bindEvents() {
    // Bottom navigation tabs
    document.querySelectorAll(".nav-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        $(`tab-${tab}`).classList.add("active");
        $("header-title").textContent = TAB_TITLES[tab] || "Inventario";
      });
    });

    // Modal close buttons & backdrops
    document.querySelectorAll("[data-close]").forEach((el) => {
      el.addEventListener("click", () => closeModal(el.dataset.close));
    });

    // Add manual
    $("btn-add-manual").addEventListener("click", () => openProductModal(null, ""));

    // Add by photo (camera)
    $("btn-add-photo").addEventListener("click", () => {
      $("quick-camera-input").value = "";
      $("quick-camera-input").click();
    });

    $("quick-camera-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await compressImage(file);
        openProductModal(null, dataUrl);
      } catch {
        showToast("No se pudo procesar la foto");
      }
    });

    // Photo inside product modal
    $("prod-photo-input").addEventListener("change", async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await compressImage(file);
        setModalPhoto(dataUrl);
      } catch {
        showToast("No se pudo cargar la foto");
      }
    });

    $("btn-remove-photo").addEventListener("click", () => setModalPhoto(""));

    // Live auto-calc inside product form
    [
      "prod-ibo",
      "prod-customer",
      "prod-special",
      "prod-shipping",
      "prod-tax",
      "prod-units-per-box",
      "prod-boxes",
      "prod-loose"
    ].forEach((id) => {
      $(id).addEventListener("input", updateModalAutoCalc);
    });

    // Pick from Catálogo Amway DR
    $("catalog-pick-select").addEventListener("change", (e) => {
      const catItem = catalog.find((c) => c.id === e.target.value);
      if (!catItem) return;
      $("prod-name").value = catItem.name;
      $("prod-category").value = catItem.category || "Otro";
      $("prod-pv").value = catItem.pv || 0;
      $("prod-ibo").value = catItem.iboPrice;
      $("prod-customer").value = catItem.customerPrice;
      $("prod-shipping").value = catItem.shipping || 0;
      $("prod-tax").value = catItem.tax || 0;
      $("prod-units-per-box").value = catItem.unitsPerBox || 1;
      updateModalAutoCalc();
      showToast("Datos rellenados desde el catálogo");
    });

    // Submit Product Form
    $("product-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const id = $("prod-id").value;
      const unitsPerBox = Math.max(1, parseInt($("prod-units-per-box").value, 10) || 1);
      const boxes = Math.max(0, parseInt($("prod-boxes").value, 10) || 0);
      const loose = Math.max(0, parseInt($("prod-loose").value, 10) || 0);

      const productData = {
        id: id || makeId("prod"),
        name: $("prod-name").value.trim(),
        category: $("prod-category").value,
        details: $("prod-details").value.trim(),
        photo: currentPhotoData,
        iboPrice: Number($("prod-ibo").value) || 0,
        customerPrice: Number($("prod-customer").value) || 0,
        specialPrice: Number($("prod-special").value) || 0,
        shipping: Number($("prod-shipping").value) || 0,
        tax: Number($("prod-tax").value) || 0,
        pv: Number($("prod-pv").value) || 0,
        unitsPerBox,
        totalUnits: boxes * unitsPerBox + loose,
        isExample: false,
        updatedAt: new Date().toISOString()
      };

      if (id) {
        const idx = inventory.findIndex((p) => p.id === id);
        if (idx !== -1) {
          productData.isExample = !!inventory[idx].isExample;
          if (productData.photo && productData.photo === inventory[idx].photo) {
            productData.photoDriveId = inventory[idx].photoDriveId || "";
            productData.photoUrl = inventory[idx].photoUrl || "";
          }
          inventory[idx] = productData;
        }
        showToast("Producto actualizado");
      } else {
        inventory.unshift(productData);
        showToast("Producto agregado al inventario");
      }

      if ($("prod-save-to-catalog").checked) {
        catalog.unshift({
          id: makeId("cat"),
          name: productData.name,
          category: productData.category,
          iboPrice: productData.iboPrice,
          customerPrice: productData.customerPrice,
          pv: productData.pv,
          unitsPerBox: productData.unitsPerBox,
          shipping: productData.shipping,
          tax: productData.tax
        });
        saveCatalog();
      }

      saveInventory();
      closeModal("product-modal");
      renderInventory();
    });

    // Card quick actions (delegation)
    $("inventory-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      const act = btn.dataset.act;
      const id = btn.dataset.id;
      const idx = inventory.findIndex((p) => p.id === id);
      if (idx === -1) return;
      const prod = inventory[idx];
      const m = getProductMath(prod);

      if (act === "edit") {
        openProductModal(prod);
      } else if (act === "delete") {
        if (confirm(`¿Eliminar "${prod.name}" del inventario?`)) {
          inventory.splice(idx, 1);
          saveInventory();
          renderInventory();
          showToast("Producto eliminado");
        }
      } else if (act === "add-box") {
        prod.totalUnits = m.totalUnits + m.unitsPerBox;
        saveInventory();
        renderInventory();
        showToast(`+1 caja (${m.unitsPerBox} u.) agregada`);
      } else if (act === "sub-unit") {
        if (m.totalUnits <= 0) {
          showToast("Ya está en 0 unidades");
          return;
        }
        prod.totalUnits = m.totalUnits - 1;
        saveInventory();
        renderInventory();
        showToast("-1 unidad");
      } else if (act === "sell") {
        if (m.totalUnits <= 0) {
          showToast("No hay unidades para vender");
          return;
        }
        prod.totalUnits = m.totalUnits - 1;
        saveInventory();
        renderInventory();
        showToast(`Vendido 1 · Ganancia ${formatRD(m.profitNormal)}`);
      }
    });

    // Search, filter, sort
    $("search-input").addEventListener("input", renderInventory);
    $("category-filter").addEventListener("change", renderInventory);
    $("sort-select").addEventListener("change", renderInventory);

    $("status-filters").addEventListener("click", (e) => {
      const pill = e.target.closest(".pill");
      if (!pill) return;
      statusFilter = pill.dataset.filter;
      document.querySelectorAll("#status-filters .pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
      renderInventory();
    });

    $("btn-filter-low-stock").addEventListener("click", () => {
      statusFilter = "low";
      document.querySelectorAll("#status-filters .pill").forEach((p) => {
        p.classList.toggle("active", p.dataset.filter === "low");
      });
      renderInventory();
    });

    // Catalog Modal
    $("btn-open-catalog").addEventListener("click", () => {
      renderCatalogList();
      openModal("catalog-modal");
    });

    $("catalog-form").addEventListener("submit", (e) => {
      e.preventDefault();
      catalog.unshift({
        id: makeId("cat"),
        name: $("cat-name").value.trim(),
        category: $("cat-category").value,
        pv: Number($("cat-pv").value) || 0,
        iboPrice: Number($("cat-ibo").value) || 0,
        customerPrice: Number($("cat-customer").value) || 0,
        unitsPerBox: Math.max(1, parseInt($("cat-units").value, 10) || 1),
        shipping: Number($("cat-shipping").value) || 0,
        tax: Number($("cat-tax").value) || 0
      });
      saveCatalog();
      $("catalog-form").reset();
      $("cat-units").value = "1";
      $("cat-shipping").value = "0";
      $("cat-tax").value = "0";
      renderCatalogList();
      renderSummary();
      showToast("Guardado en Catálogo Amway DR");
    });

    $("catalog-list").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-cat-del]");
      if (!btn) return;
      catalog = catalog.filter((c) => c.id !== btn.dataset.catDel);
      saveCatalog();
      renderCatalogList();
      renderSummary();
    });

    // Tools Modal (Export / Import / Examples)
    $("btn-open-tools").addEventListener("click", () => openModal("tools-modal"));

    function loadExamples() {
      const examples = [
        {
          id: makeId("ex"),
          name: "[Ejemplo] Bebida energética (caja)",
          category: "Energía",
          details: "Caja de 12 latas — reemplaza con tu producto real",
          photo: "",
          iboPrice: 1200,
          customerPrice: 1650,
          specialPrice: 1500,
          shipping: 0,
          tax: 0,
          pv: 8.5,
          unitsPerBox: 12,
          totalUnits: 12,
          isExample: true
        },
        {
          id: makeId("ex"),
          name: "[Ejemplo] Multivitamínico diario",
          category: "Nutrición",
          details: "Frasco de prueba — reemplaza con tu precio de Amway+",
          photo: "",
          iboPrice: 1850,
          customerPrice: 2450,
          specialPrice: 2200,
          shipping: 0,
          tax: 0,
          pv: 14.2,
          unitsPerBox: 1,
          totalUnits: 2,
          isExample: true
        },
        {
          id: makeId("ex"),
          name: "[Ejemplo] Limpiador concentrado",
          category: "Hogar",
          details: "Botella 1L — reemplaza con tu precio de Amway+",
          photo: "",
          iboPrice: 650,
          customerPrice: 900,
          specialPrice: 0,
          shipping: 0,
          tax: 0,
          pv: 5.1,
          unitsPerBox: 1,
          totalUnits: 0,
          isExample: true
        }
      ];
      inventory = [...examples, ...inventory];
      saveInventory();
      renderInventory();
      closeModal("tools-modal");
      showToast("3 productos de ejemplo cargados");
    }

    $("btn-load-examples").addEventListener("click", loadExamples);
    $("btn-load-examples-tools").addEventListener("click", loadExamples);

    $("btn-delete-examples").addEventListener("click", () => {
      const before = inventory.length;
      inventory = inventory.filter((p) => !p.isExample);
      saveInventory();
      renderInventory();
      closeModal("tools-modal");
      showToast(before === inventory.length ? "No había datos de ejemplo" : "Datos de ejemplo borrados");
    });

    $("btn-clear-all").addEventListener("click", () => {
      if (confirm("¿Seguro que quieres borrar TODO el inventario?")) {
        inventory = [];
        saveInventory();
        renderInventory();
        closeModal("tools-modal");
        showToast("Inventario borrado");
      }
    });

    $("btn-export-data").addEventListener("click", () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        inventory,
        catalog
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `inventario-amway-rd-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast("Archivo exportado");
    });

    $("import-file-input").addEventListener("change", (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (Array.isArray(parsed)) {
            inventory = parsed;
          } else {
            if (Array.isArray(parsed.inventory)) inventory = parsed.inventory;
            if (Array.isArray(parsed.catalog)) catalog = parsed.catalog;
          }
          saveInventory();
          saveCatalog();
          renderInventory();
          closeModal("tools-modal");
          showToast("Inventario importado correctamente");
        } catch {
          showToast("El archivo no es válido");
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    });
  }

  // --- GOOGLE CLOUD SYNC (OAuth + Drive + Sheets) ---
  function getGoogleClientId() {
    return (localStorage.getItem(STORAGE_GCLIENT) || DEFAULT_GOOGLE_CLIENT_ID || "").trim();
  }

  function updateGoogleUI(state, subText = "") {
    const dot = $("google-status-dot");
    const title = $("google-status-title");
    const sub = $("google-status-sub");
    const btnIn = $("btn-google-signin");
    const btnSync = $("btn-google-sync-now");
    const btnOut = $("btn-google-signout");

    dot.classList.remove("dot-offline", "dot-online", "dot-syncing");
    if (state === "online") {
      dot.classList.add("dot-online");
      title.textContent = "Conectado a Google Drive y Sheets";
      sub.textContent = subText || "Sincronizado en la nube";
      btnIn.classList.add("hidden");
      btnSync.classList.remove("hidden");
      btnOut.classList.remove("hidden");
    } else if (state === "syncing") {
      dot.classList.add("dot-syncing");
      title.textContent = "Sincronizando con Google...";
      sub.textContent = subText || "Guardando productos y fotos";
      btnIn.classList.add("hidden");
      btnSync.classList.remove("hidden");
    } else {
      dot.classList.add("dot-offline");
      title.textContent = "Solo guardado en este teléfono";
      sub.textContent = subText || "Conecta tu cuenta Google para guardar en la nube";
      btnIn.classList.remove("hidden");
      btnSync.classList.add("hidden");
      btnOut.classList.add("hidden");
    }
  }

  async function gFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${googleAccessToken}`,
        ...(options.headers || {})
      }
    });
    if (res.status === 401) {
      googleAccessToken = "";
      updateGoogleUI("offline", "Sesión expirada — vuelve a entrar con Google");
      throw new Error("Sesión de Google expirada");
    }
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google API error ${res.status}: ${errText}`);
    }
    return res.json();
  }

  async function ensureGoogleWorkspace() {
    if (!googleMeta.folderId) {
      const q = encodeURIComponent(
        "name='Amway RD - Mi Negocio' and mimeType='application/vnd.google-apps.folder' and trashed=false"
      );
      const found = await gFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      if (found.files && found.files.length > 0) {
        googleMeta.folderId = found.files[0].id;
      } else {
        const created = await gFetch("https://www.googleapis.com/drive/v3/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Amway RD - Mi Negocio",
            mimeType: "application/vnd.google-apps.folder"
          })
        });
        googleMeta.folderId = created.id;
      }
    }

    if (!googleMeta.spreadsheetId) {
      const q = encodeURIComponent(
        "name='Inventario Amway RD' and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
      );
      const found = await gFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`);
      if (found.files && found.files.length > 0) {
        googleMeta.spreadsheetId = found.files[0].id;
      } else {
        const created = await gFetch("https://www.googleapis.com/drive/v3/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Inventario Amway RD",
            mimeType: "application/vnd.google-apps.spreadsheet",
            parents: [googleMeta.folderId]
          })
        });
        googleMeta.spreadsheetId = created.id;

        // Add Inventario & Catalogo tabs
        await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}:batchUpdate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            requests: [
              { updateSheetProperties: { properties: { sheetId: 0, title: "Inventario" }, fields: "title" } },
              { addSheet: { properties: { title: "Catalogo" } } }
            ]
          })
        });
      }
    }

    localStorage.setItem(STORAGE_GMETA, JSON.stringify(googleMeta));
  }

  async function uploadPhotoToDrive(dataUrl, productName) {
    const base64Data = dataUrl.split(",")[1];
    const byteChars = atob(base64Data);
    const byteArray = new Uint8Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
      byteArray[i] = byteChars.charCodeAt(i);
    }
    const blob = new Blob([byteArray], { type: "image/jpeg" });

    const metadata = {
      name: `${productName.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 30)}_${Date.now()}.jpg`,
      parents: [googleMeta.folderId]
    };

    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", blob);

    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
      method: "POST",
      headers: { Authorization: `Bearer ${googleAccessToken}` },
      body: form
    });
    if (!res.ok) throw new Error("Error subiendo foto a Drive");
    const uploaded = await res.json();

    // Make image viewable via link so it loads inside the web app
    await gFetch(`https://www.googleapis.com/drive/v3/files/${uploaded.id}/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "reader", type: "anyone" })
    });

    return {
      photoDriveId: uploaded.id,
      photoUrl: `https://drive.google.com/thumbnail?id=${uploaded.id}&sz=w600`
    };
  }

  async function pushToGoogleSheets() {
    // Upload any new local dataURL photos to Google Drive first
    let photoUpdated = false;
    for (const p of inventory) {
      if (p.photo && p.photo.startsWith("data:image/") && !p.photoDriveId) {
        const uploaded = await uploadPhotoToDrive(p.photo, p.name || "producto");
        p.photoDriveId = uploaded.photoDriveId;
        p.photoUrl = uploaded.photoUrl;
        photoUpdated = true;
      }
    }
    if (photoUpdated) saveInventory(true);

    const invHeader = [
      "ID",
      "Nombre",
      "Categoria",
      "Detalles",
      "Precio IBO",
      "Precio Cliente",
      "Precio Especial",
      "Envio",
      "Impuesto",
      "PV",
      "Unidades/Caja",
      "Total Unidades",
      "Foto Drive URL",
      "Foto Drive ID",
      "Es Ejemplo"
    ];
    const invRows = inventory.map((p) => [
      p.id,
      p.name,
      p.category,
      p.details || "",
      p.iboPrice || 0,
      p.customerPrice || 0,
      p.specialPrice || 0,
      p.shipping || 0,
      p.tax || 0,
      p.pv || 0,
      p.unitsPerBox || 1,
      p.totalUnits || 0,
      p.photoUrl || "",
      p.photoDriveId || "",
      p.isExample ? "SI" : "NO"
    ]);

    const catHeader = ["ID", "Nombre", "Categoria", "PV", "Precio IBO", "Precio Cliente", "Unidades/Caja", "Envio", "Impuesto"];
    const catRows = catalog.map((c) => [
      c.id,
      c.name,
      c.category || "Otro",
      c.pv || 0,
      c.iboPrice || 0,
      c.customerPrice || 0,
      c.unitsPerBox || 1,
      c.shipping || 0,
      c.tax || 0
    ]);

    await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}/values/Inventario!A1:Z1000:clear`, {
      method: "POST"
    });
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}/values/Inventario!A1?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [invHeader, ...invRows] })
      }
    );

    await gFetch(`https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}/values/Catalogo!A1:Z500:clear`, {
      method: "POST"
    });
    await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}/values/Catalogo!A1?valueInputOption=USER_ENTERED`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: [catHeader, ...catRows] })
      }
    );
  }

  async function pullFromGoogleSheetsIfLocalEmpty() {
    const invRes = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}/values/Inventario!A2:O1000`
    );
    const catRes = await gFetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${googleMeta.spreadsheetId}/values/Catalogo!A2:I500`
    );

    const remoteInv = (invRes.values || []).map((r) => ({
      id: r[0] || makeId("prod"),
      name: r[1] || "",
      category: r[2] || "Otro",
      details: r[3] || "",
      iboPrice: Number(r[4]) || 0,
      customerPrice: Number(r[5]) || 0,
      specialPrice: Number(r[6]) || 0,
      shipping: Number(r[7]) || 0,
      tax: Number(r[8]) || 0,
      pv: Number(r[9]) || 0,
      unitsPerBox: Math.max(1, parseInt(r[10], 10) || 1),
      totalUnits: Math.max(0, parseInt(r[11], 10) || 0),
      photoUrl: r[12] || "",
      photoDriveId: r[13] || "",
      photo: r[12] || "",
      isExample: r[14] === "SI"
    }));

    const remoteCat = (catRes.values || []).map((r) => ({
      id: r[0] || makeId("cat"),
      name: r[1] || "",
      category: r[2] || "Otro",
      pv: Number(r[3]) || 0,
      iboPrice: Number(r[4]) || 0,
      customerPrice: Number(r[5]) || 0,
      unitsPerBox: Math.max(1, parseInt(r[6], 10) || 1),
      shipping: Number(r[7]) || 0,
      tax: Number(r[8]) || 0
    }));

    if (inventory.length === 0 && remoteInv.length > 0) {
      inventory = remoteInv;
      saveInventory(true);
    }
    if (catalog.length === 0 && remoteCat.length > 0) {
      catalog = remoteCat;
      saveCatalog(true);
    }
  }

  async function syncWithGoogle(isInitial = false) {
    if (!googleAccessToken) return;
    if (isSyncing) {
      pendingSync = true;
      return;
    }
    isSyncing = true;
    updateGoogleUI("syncing");
    try {
      await ensureGoogleWorkspace();
      if (isInitial) {
        await pullFromGoogleSheetsIfLocalEmpty();
        renderInventory();
      }
      await pushToGoogleSheets();
      const nowStr = new Date().toLocaleTimeString("es-DO", { hour: "2-digit", minute: "2-digit" });
      updateGoogleUI("online", `Última copia: ${nowStr}`);
    } catch (err) {
      console.error(err);
      updateGoogleUI("offline", "Error al sincronizar — guardado local seguro");
      showToast("No se pudo sincronizar con Google");
    } finally {
      isSyncing = false;
      if (pendingSync) {
        pendingSync = false;
        syncWithGoogle(false);
      }
    }
  }

  function scheduleCloudSync() {
    clearTimeout(scheduleCloudSync._t);
    scheduleCloudSync._t = setTimeout(() => syncWithGoogle(false), 700);
  }

  function startGoogleSignIn() {
    const clientId = getGoogleClientId();
    if (!clientId) {
      showToast("Falta el ID de Cliente Google en ⚙️ Opciones");
      $("google-client-id").value = "";
      openModal("tools-modal");
      return;
    }
    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      showToast("Cargando Google... intenta en 2 segundos (requiere https)");
      return;
    }
    googleTokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: GOOGLE_SCOPES,
      callback: (resp) => {
        if (resp.error) {
          showToast("No se inició sesión con Google");
          return;
        }
        googleAccessToken = resp.access_token;
        showToast("Conectado a Google");
        syncWithGoogle(true);
      }
    });
    googleTokenClient.requestAccessToken({ prompt: "consent" });
  }

  // Init
  loadData();
  bindEvents();
  $("google-client-id").value = getGoogleClientId();
  $("btn-google-signin").addEventListener("click", startGoogleSignIn);
  $("btn-google-sync-now").addEventListener("click", () => syncWithGoogle(false));
  $("btn-save-google-client").addEventListener("click", () => {
    const val = $("google-client-id").value.trim();
    localStorage.setItem(STORAGE_GCLIENT, val);
    showToast("ID de Google guardado");
  });
  $("btn-google-signout").addEventListener("click", () => {
    if (googleAccessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(googleAccessToken);
    }
    googleAccessToken = "";
    updateGoogleUI("offline");
    closeModal("tools-modal");
    showToast("Sesión de Google cerrada");
  });
  renderInventory();
})();
