/**
 * dt_client.js — Thin browser view for Disintegration Tester.
 * Dashboard / recipe / settings UI mirrors Dt_Dr_Reddy; business logic stays on Python.
 */
(function () {
  'use strict';

  var DT = {
    basketConfig: 6,
    selectedBasket: 1,
    pollTimers: { 1: null, 2: null },
    pollTimer: null, // legacy alias; prefer pollTimers
    sse: null,
    recipeDraft: null,
    modes: { 1: 'manual', 2: 'manual' },
    setTemp: { 1: 37.0, 2: 37.0 },
    products: { 1: null, 2: null },
    batches: { 1: null, 2: null },
    ars: { 1: null, 2: null },
    durations: { 1: null, 2: null },
    media: { 1: null, 2: null },
    mesh: { 1: null, 2: null },
    heaterOn: { 1: false, 2: false },
    configured: { 1: true, 2: true },
    running: { 1: false, 2: false },
    /** Dashboard start-btn phase: idle | preheating | ready | running */
    btnPhase: { 1: 'idle', 2: 'idle' },
    preheatInProgress: { 1: false, 2: false },
    loadCtx: null,
    beakerPick: null,
    beakerPickPurpose: null,
    calBeaker: 1,
    calSessionActive: false,
    latestTemps: {},
  };

  // Declared early so nav-lock helpers can close over them (assigned in validation section).
  var _valPollTimer = null;
  var _valKind = null;
  var _valBasket = 1;
  var _tempValRunning = false;

  function syncDtNavLock() {
    var locked = !!(DT.running[1] || DT.running[2] || _valPollTimer || _tempValRunning || _valKind || DT.calSessionActive);
    var app = document.querySelector('.app-container');
    if (app) app.classList.toggle('dt-op-locked', locked);
    var sidebar = document.querySelector('.sidebar');
    if (sidebar) {
      if (locked) sidebar.classList.add('sidebar-locked');
      else if (typeof isTestRunActive === 'function' && !isTestRunActive() &&
               typeof isValidationRunActive === 'function' && !isValidationRunActive()) {
        sidebar.classList.remove('sidebar-locked');
      }
    }
  }

  /** True while a DT test, stroke/temp validation, or calibration session is active. */
  window.dtIsOperationRunning = function () {
    if (DT.running[1] || DT.running[2]) return true;
    if (_valPollTimer || _tempValRunning || _valKind) return true;
    if (DT.calSessionActive) return true;
    var active = document.querySelector('.page.active');
    var id = active ? active.id : '';
    if (id === 'page-stroke-validation' || id === 'page-temp-validation') return true;
    if (id === 'page-calibration-type-select') return true;
    return false;
  };

  /** Pages that may stay open without aborting the current DT operation. */
  window.dtNavAllowedDuringOp = function (pageName) {
    pageName = String(pageName || '');
    if (pageName === 'report-preview' || pageName === 'approval-verify') return true;
    if (DT.running[1] || DT.running[2]) {
      return pageName === 'home' || pageName === 'test-run';
    }
    if (_valPollTimer || _tempValRunning || _valKind) {
      if (_valKind === 'temp' || _tempValRunning) return pageName === 'temp-validation';
      return pageName === 'stroke-validation';
    }
    var active = document.querySelector('.page.active');
    var id = active ? active.id : '';
    if (id === 'page-temp-validation') return pageName === 'temp-validation';
    if (id === 'page-stroke-validation') return pageName === 'stroke-validation';
    if (DT.calSessionActive || id === 'page-calibration-type-select') {
      return pageName === 'calibration-type-select';
    }
    return true;
  };

  /** Abort running DT test(s), validation, and/or clear calibration session. */
  window.dtAbortActiveOperations = function () {
    var promises = [];
    [1, 2].forEach(function (b) {
      if (!DT.running[b]) return;
      promises.push(
        api('/api/data/dt/runs/' + b + '/stop', {
          method: 'POST',
          body: { aborted: true, reason: 'nav_abort' },
        }).then(function () {
          finishBasketUi(b);
        }).catch(function () {
          finishBasketUi(b);
        })
      );
    });
    if (_valPollTimer || _tempValRunning || _valKind) {
      try { window.stopValidation({ stay: true }); } catch (e) {}
    }
    DT.calSessionActive = false;
    syncDtNavLock();
    return Promise.all(promises);
  };

  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    if (typeof getAuthHeaders === 'function') {
      try { Object.assign(headers, getAuthHeaders() || {}); } catch (e) {}
    }
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body != null ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var err = new Error((j && (j.error || j.message)) || ('HTTP ' + r.status));
          err.payload = j;
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  }

  function toast(msg, kind) {
    if (typeof showToast === 'function') showToast(msg, kind || 'info');
    else if (typeof showAppModal === 'function') showAppModal(msg);
    else if (typeof showModal === 'function') showModal(msg);
    else alert(msg);
  }

  function go(page) {
    if (typeof goToPage === 'function') goToPage(page.replace(/^page-/, ''));
    else if (typeof navigateTo === 'function') navigateTo(page);
  }

  function fmtSec(s) {
    s = Math.max(0, parseInt(s, 10) || 0);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function parseHHMMSS(str) {
    var s = String(str || '').trim();
    if (!s) return null;
    var parts = s.split(':');
    try {
      if (parts.length === 3) {
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10) + parseInt(parts[2], 10) / 60;
      }
      if (parts.length === 2) {
        return parseInt(parts[0], 10) + parseInt(parts[1], 10) / 60;
      }
      var n = parseFloat(s);
      return isNaN(n) ? null : n;
    } catch (e) {
      return null;
    }
  }

  // -------------------- Live temps / SSE --------------------

  function ensureSse() {
    if (DT.sse) return;
    try {
      DT.sse = new EventSource('/api/hardware/stream');
      DT.sse.onmessage = function (ev) {
        try {
          var data = JSON.parse(ev.data);
          if (data.ping) return;
          if (data.type === 'temps' || data.kind === 'temps' || data.IR1 != null || data.temps) {
            var t = data.temps || data;
            updateTempDisplay(t);
            maybeMarkReadyFromTemp(1);
            maybeMarkReadyFromTemp(2);
          }
          if (data.type === 'TR1' || data.type === 'TR2') {
            markBasketReady(data.type === 'TR1' ? 1 : 2, 'tr');
          }
        } catch (e) {}
      };
      DT.sse.onerror = function () {
        try { DT.sse.close(); } catch (e) {}
        DT.sse = null;
        setTimeout(ensureSse, 3000);
      };
    } catch (e) {}
  }

  function updateTempDisplay(t) {
    DT.latestTemps = t || {};
    window.latestTemps = DT.latestTemps;
    function setC(id, val) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = (val == null || val === '') ? '--' : (Number(val).toFixed(1) + '°C');
    }
    function setPlain(id, val) {
      var el = document.getElementById(id);
      if (!el) return;
      el.textContent = (val == null || val === '') ? '--' : Number(val).toFixed(1);
    }
    setC('dt-ir1', t.IR1); setC('dt-ir2', t.IR2);
    setC('dt-ext1', t.EXT1); setC('dt-ext2', t.EXT2);
    setC('temp1', t.IR1); setC('temp2', t.IR2);
    setPlain('dash-ext1', t.EXT1); setPlain('dash-ext2', t.EXT2);
    setC('dt-run-ir', DT.selectedBasket === 1 ? t.IR1 : t.IR2);

    var calB = DT.calBeaker || 1;
    var irEl = document.getElementById('calibration-internal-temp-input');
    var extEl = document.getElementById('calibration-external-temp-input');
    if (irEl) {
      var ir = calB === 2 ? t.IR2 : t.IR1;
      irEl.value = ir != null ? Number(ir).toFixed(1) : '';
    }
    if (extEl) {
      var ext = calB === 2 ? t.EXT2 : t.EXT1;
      extEl.value = ext != null ? Number(ext).toFixed(1) : '';
    }
  }

  function setStartBtnPhase(basket, phase) {
    basket = basket === 2 ? 2 : 1;
    DT.btnPhase[basket] = phase;
    var startBtn = document.getElementById('start' + basket);
    if (!startBtn) return;
    startBtn.classList.remove('is-stop', 'is-preheating', 'is-ready');
    startBtn.disabled = false;
    if (phase === 'preheating') {
      startBtn.textContent = 'Preheating';
      startBtn.classList.add('is-preheating');
      DT.preheatInProgress[basket] = true;
    } else if (phase === 'ready') {
      startBtn.textContent = 'Start';
      startBtn.classList.add('is-ready');
      DT.preheatInProgress[basket] = false;
    } else if (phase === 'running') {
      startBtn.textContent = 'Abort';
      startBtn.classList.add('is-stop');
      DT.preheatInProgress[basket] = false;
    } else {
      startBtn.textContent = 'Preheat';
      DT.preheatInProgress[basket] = false;
    }
  }

  function markBasketReady(basket, reason) {
    basket = basket === 2 ? 2 : 1;
    // Only while actively preheating (ignore stray TR when idle/running)
    if (DT.btnPhase[basket] !== 'preheating' && !DT.preheatInProgress[basket]) return;
    if (DT.btnPhase[basket] === 'running') return;
    if (DT.btnPhase[basket] === 'ready') return;
    setStartBtnPhase(basket, 'ready');
    onBasketReady(basket, reason);
  }

  function maybeMarkReadyFromTemp(basket) {
    if (DT.btnPhase[basket] !== 'preheating' && !DT.preheatInProgress[basket]) return;
    var params = (DT._runParams && DT._runParams[basket]) || {};
    var setT = Number(params.setTemperature != null ? params.setTemperature : DT.setTemp[basket]);
    if (!(setT > 0)) return;
    var ir = basket === 1 ? DT.latestTemps.IR1 : DT.latestTemps.IR2;
    if (ir == null || ir === '') return;
    var tol = 0.5;
    if (Math.abs(Number(ir) - setT) <= tol) {
      markBasketReady(basket, 'setpoint');
    }
  }

  function onBasketReady(basket, reason) {
    var banner = document.getElementById('dt-ready-banner');
    if (banner) {
      banner.style.display = '';
      banner.textContent = 'Basket ' + basket + ' at setpoint — press Start';
      banner.setAttribute('data-basket', String(basket));
    }
    var btn = document.getElementById('dt-confirm-btn');
    if (btn && Number(btn.getAttribute('data-basket')) === basket) {
      btn.disabled = false;
      btn.textContent = 'Confirm Start';
    }
    toast(
      'Basket ' + basket + ' ready' + (reason === 'tr' ? ' (TR)' : reason === 'setpoint' ? ' (set temp)' : ''),
      'success'
    );
  }

  // -------------------- Dashboard --------------------

  function updateModeButtonsUI(basket) {
    var mode = DT.modes[basket] || 'manual';
    var tBtn = document.getElementById('timer-btn-' + basket);
    var mBtn = document.getElementById('manual-btn-' + basket);
    if (tBtn) tBtn.classList.toggle('is-active', mode === 'timer');
    if (mBtn) mBtn.classList.toggle('is-active', mode === 'manual');
  }

  function updateDashboardTempButton() {
    var a = document.getElementById('dashboard-temp-1');
    var b = document.getElementById('dashboard-temp-2');
    if (a) a.textContent = Number(DT.setTemp[1] || 37).toFixed(1);
    if (b) b.textContent = Number(DT.setTemp[2] || 37).toFixed(1);
  }

  function updateProductNames() {
    var el = document.getElementById('dashboard-product-names');
    if (!el) return;
    var parts = [];
    if (DT.products[1]) parts.push('B1: ' + DT.products[1]);
    if (DT.products[2]) parts.push('B2: ' + DT.products[2]);
    el.textContent = parts.join('  |  ');
  }

  function updateHeaterIndicators() {
    [1, 2].forEach(function (b) {
      var el = document.getElementById('heater' + b);
      if (!el) return;
      var on = !!DT.heaterOn[b];
      el.classList.toggle('is-on', on);
      el.classList.toggle('is-off', !on);
      var span = el.querySelector('span');
      if (span) span.textContent = on ? 'Heater On' : 'Heater Off';
    });
  }

  function updateBasketStates() {
    [1, 2].forEach(function (b) {
      var wrap = document.getElementById('basket' + b + '-wrapper');
      if (!wrap) return;
      wrap.classList.toggle('basket-inactive', !DT.configured[b]);
    });
  }

  function updateBasketHoles(basketId, holeCount) {
    var container = document.getElementById('basket' + basketId + '-container');
    if (!container) return;
    var existing = container.querySelectorAll('.basket-hole');
    for (var i = 0; i < existing.length; i++) existing[i].remove();
    var center = container.querySelector('.center-temp');
    if (!center) {
      center = document.createElement('div');
      center.className = 'center-temp';
      center.id = 'temp' + basketId;
      center.textContent = '--';
      container.appendChild(center);
    }
    container.classList.toggle('is-single-tube', holeCount === 1);
    container.classList.remove('completed');

    // Single tube: whole outer circle is the vessel (Dr Reddy) — no inner hole dots.
    if (holeCount === 1) {
      return;
    }

    var positions = [];
    if (holeCount === 3) {
      var r = 33;
      positions = [
        { top: (50 - r) + '%', left: '50%', num: 1 },
        { top: (50 + r * 0.5) + '%', left: (50 + r * 0.866) + '%', num: 2 },
        { top: (50 + r * 0.5) + '%', left: (50 - r * 0.866) + '%', num: 3 },
      ];
    } else if (holeCount === 6) {
      var r6 = 31;
      positions = [
        { top: (50 - r6) + '%', left: '50%', num: 1 },
        { top: (50 - r6 * 0.5) + '%', left: (50 + r6 * 0.866) + '%', num: 2 },
        { top: (50 + r6 * 0.5) + '%', left: (50 + r6 * 0.866) + '%', num: 3 },
        { top: (50 + r6) + '%', left: '50%', num: 4 },
        { top: (50 + r6 * 0.5) + '%', left: (50 - r6 * 0.866) + '%', num: 5 },
        { top: (50 - r6 * 0.5) + '%', left: (50 - r6 * 0.866) + '%', num: 6 },
      ];
    }
    positions.forEach(function (pos) {
      var hole = document.createElement('div');
      hole.className = 'basket-hole';
      hole.textContent = pos.num;
      hole.style.cssText = 'top:' + pos.top + ';left:' + pos.left + ';transform:translate(-50%,-50%);';
      hole.onclick = (function (bid, num) {
        return function (ev) {
          if (ev && ev.stopPropagation) ev.stopPropagation();
          window.dtHandleBasketTap(bid, ev, num);
        };
      })(basketId, pos.num);
      container.appendChild(hole);
    });
  }

  function refreshDashboard() {
    updateModeButtonsUI(1);
    updateModeButtonsUI(2);
    updateDashboardTempButton();
    updateProductNames();
    updateHeaterIndicators();
    updateBasketStates();
    updateBasketHoles(1, DT.basketConfig);
    updateBasketHoles(2, DT.basketConfig);
    var s1 = document.getElementById('set-temp-1');
    var s2 = document.getElementById('set-temp-2');
    if (s1) s1.value = Number(DT.setTemp[1]).toFixed(1);
    if (s2) s2.value = Number(DT.setTemp[2]).toFixed(1);
  }

  window.dtSelectMode = function (basket, mode) {
    if (DT.running[basket]) {
      toast('Cannot change mode while test is running', 'error');
      return;
    }
    DT.modes[basket] = mode === 'timer' ? 'timer' : 'manual';
    updateModeButtonsUI(basket);
  };

  window.showRecipeModeMenu = function () {
    var m = document.getElementById('recipe-mode-menu-modal');
    if (m) m.style.display = 'flex';
  };
  window.hideRecipeModeMenu = function () {
    var m = document.getElementById('recipe-mode-menu-modal');
    if (m) m.style.display = 'none';
  };
  window.dtNavigateLoadRecipe = function () {
    hideRecipeModeMenu();
    if (typeof startRecipeTest === 'function') startRecipeTest();
    else {
      if (typeof window.recipeListMode !== 'undefined') window.recipeListMode = 'load';
      go('manage-recipes');
      if (typeof loadManageRecipes === 'function') loadManageRecipes();
    }
  };
  window.dtNavigateCreateRecipe = function () {
    hideRecipeModeMenu();
    if (typeof startRecipeCreation === 'function') startRecipeCreation();
    else go('create-recipe-step1');
  };

  window.dtHandleBasketTap = function (basket, event, holeNum) {
    if (!DT.running[basket]) return;
    if (DT.modes[basket] !== 'manual') return;
    var hole = holeNum;
    if (hole == null && event && event.target && event.target.classList.contains('basket-hole')) {
      hole = parseInt(event.target.textContent, 10);
    }
    // Single-tube: tap anywhere on the outer basket circle (Dr Reddy).
    if ((hole == null || isNaN(hole)) && DT.basketConfig === 1) {
      hole = 1;
    }
    if (!hole) return;
    dtTapHole(basket, hole);
  };

  window.dtDashboardStart = function (basket) {
    ensureSse();
    basket = basket === 2 ? 2 : 1;
    if (!DT.configured[basket]) {
      toast('Configure beaker ' + basket + ' in Settings → Add Beakers', 'error');
      return;
    }

    var phase = DT.btnPhase[basket] || 'idle';

    // Preheat in progress → confirm stop
    if (phase === 'preheating' || DT.preheatInProgress[basket]) {
      var doAbortPreheat = function () {
        api('/api/data/dt/runs/' + basket + '/stop', {
          method: 'POST',
          body: { aborted: true, reason: 'preheat_abort' },
        }).then(function () {
          finishBasketUi(basket);
          var tEl = document.getElementById('timer' + basket);
          if (tEl) tEl.textContent = '00:00:00';
          toast('Preheating stopped for basket ' + basket, 'info');
          go('home');
        }).catch(function (e) { toast(e.message || 'Failed to stop preheating', 'error'); });
      };
      var preheatMsg = 'Do you want to stop preheating?';
      if (typeof showYesNoModal === 'function') {
        showYesNoModal(preheatMsg, 'Stop Preheat', 'Yes', 'No').then(function (ok) {
          if (ok) doAbortPreheat();
        });
      } else if (typeof showConfirmModal === 'function') {
        showConfirmModal(preheatMsg, 'Stop Preheat').then(function (ok) {
          if (ok) doAbortPreheat();
        });
      } else if (window.confirm(preheatMsg)) {
        doAbortPreheat();
      }
      return;
    }

    // Ready → confirm motor start
    if (phase === 'ready') {
      DT.selectedBasket = basket;
      promptConfirmStart(basket);
      return;
    }

    // Running → abort test
    if (phase === 'running' || DT.running[basket]) {
      api('/api/data/dt/runs/' + basket + '/stop', {
        method: 'POST',
        body: { aborted: true, reason: 'operator_abort' },
      }).then(function () {
        finishBasketUi(basket);
        var tEl = document.getElementById('timer' + basket);
        if (tEl) tEl.textContent = '00:00:00';
        toast('Basket ' + basket + ' aborted', 'info');
        go('home');
      }).catch(function (e) { toast(e.message || 'Abort failed', 'error'); });
      return;
    }

    // Idle → begin preheat
    var product = DT.products[basket] || ('Manual Test B' + basket);
    var temp = Number(DT.setTemp[basket] || 37);
    var mode = DT.modes[basket] || 'manual';
    var dur = DT.durations[basket];
    if (mode === 'timer' && !(dur > 0)) {
      toast('Timer mode needs a duration — load a timer recipe or set duration', 'error');
      return;
    }
    DT.selectedBasket = basket;
    openTestRun(basket, {
      productName: product,
      recipeName: product,
      setTemperature: temp,
      mode: mode,
      durationMinutes: dur,
      basketConfig: DT.basketConfig,
      batchNumber: DT.batches[basket] || '',
      arNumber: DT.ars[basket] || '',
      media: DT.media[basket],
      mesh: DT.mesh[basket],
    });
  };

  // -------------------- Recipe create / load --------------------

  window.dtSelectRecipeMode = function (mode) {
    mode = mode === 'timer' ? 'timer' : 'manual';
    var hidden = document.getElementById('dt-recipe-mode');
    if (hidden) hidden.value = mode;
    var man = document.getElementById('recipe-mode-manual');
    var tim = document.getElementById('recipe-mode-timer');
    var manRadio = document.getElementById('recipe-mode-manual-radio');
    var timRadio = document.getElementById('recipe-mode-timer-radio');
    if (man) man.classList.toggle('is-active', mode === 'manual');
    if (tim) tim.classList.toggle('is-active', mode === 'timer');
    if (manRadio) manRadio.checked = mode === 'manual';
    if (timRadio) timRadio.checked = mode === 'timer';
    var row = document.getElementById('dt-recipe-duration-row');
    if (row) row.style.display = mode === 'timer' ? '' : 'none';
    var page = document.getElementById('page-create-recipe-step1');
    if (page) page.classList.toggle('is-timer-mode', mode === 'timer');
  };

  window.dtToggleRecipeDuration = function () {
    var mode = (document.getElementById('dt-recipe-mode') || {}).value || 'manual';
    window.dtSelectRecipeMode(mode);
  };

  var _dtSaveRecipeInFlight = false;

  window.dtSaveRecipe = function () {
    if (_dtSaveRecipeInFlight) return;
    var name = ((document.getElementById('dt-recipe-name') || {}).value || '').trim();
    var temp = parseFloat((document.getElementById('dt-recipe-temp') || {}).value);
    var mode = (document.getElementById('dt-recipe-mode') || {}).value || 'manual';
    var media = ((document.getElementById('dt-recipe-media') || {}).value || '').trim();
    var mesh = ((document.getElementById('dt-recipe-mesh') || {}).value || '').trim();
    var body = {
      name: name,
      productName: name,
      temp: temp,
      mode: mode,
      duration: null,
      media: media || null,
      mesh: mesh || null,
    };
    if (mode === 'timer') {
      var durStr = ((document.getElementById('dt-recipe-duration') || {}).value || '').trim();
      body.setDuration = durStr;
      body.duration = parseHHMMSS(durStr);
    }
    if (!name) { toast('Recipe name required', 'error'); return; }
    if (isNaN(temp) || temp < 20 || temp > 55) { toast('Temperature must be 20–55°C', 'error'); return; }
    if (mode === 'timer' && !(body.duration > 0)) { toast('Duration required (HH:MM:SS)', 'error'); return; }

    function doSave(token) {
      var headers = {};
      if (token) headers['X-Approval-Verify-Token'] = token;
      _dtSaveRecipeInFlight = true;
      return api('/api/data/recipes', { method: 'POST', body: body, headers: headers }).then(function () {
        toast('Recipe saved', 'success');
        // goToPage already schedules loadManageRecipes — calling it again raced and showed duplicates.
        go('manage-recipes');
      }).then(function () {
        _dtSaveRecipeInFlight = false;
      }, function (e) {
        _dtSaveRecipeInFlight = false;
        throw e;
      });
    }

    var opts = (typeof _approvalVerifyModalOptionsForRecipe === 'function')
      ? _approvalVerifyModalOptionsForRecipe()
      : { purpose: 'recipe', titleText: 'Recipe approval required', subtitleText: 'Enter credentials for a user with Recipe approval permission.' };
    if (typeof openApprovalVerifyModal === 'function') {
      _dtSaveRecipeInFlight = true;
      openApprovalVerifyModal(opts).then(function (token) {
        if (!token) {
          _dtSaveRecipeInFlight = false;
          return;
        }
        return doSave(token).catch(function (e) {
          _dtSaveRecipeInFlight = false;
          toast(e.message || 'Save failed', 'error');
        });
      }).catch(function (e) {
        _dtSaveRecipeInFlight = false;
        toast((e && e.message) || 'QA verification UI is missing.', 'error');
      });
    } else {
      doSave(null).catch(function (e) {
        _dtSaveRecipeInFlight = false;
        toast(e.message || 'Save failed', 'error');
      });
    }
  };

  window.startRecipeTest = function () {
    if (typeof window.recipeListMode !== 'undefined') window.recipeListMode = 'load';
    if (typeof logAuditEvent === 'function') {
      try { logAuditEvent('Opened Load Recipe', 'Load Recipe list opened', { eventType: 'navigation' }); } catch (e) {}
    }
    go('manage-recipes');
  };

  // DT load flow: Batch → AR → Beaker → apply to dashboard
  window.loadRecipeById = function (id) {
    return api('/api/data/recipes/' + id).then(function (res) {
      var recipe = res.recipe || res;
      if (!recipe) { toast('Recipe not found', 'error'); return; }
      if (typeof getEffectiveRecipeApprovalStatus === 'function' &&
          getEffectiveRecipeApprovalStatus(recipe) === 'pending') {
        toast('This recipe is pending QA approval and cannot be loaded', 'error');
        return;
      }
      DT.loadCtx = { recipe: recipe, batch: '', ar: '', beaker: null };
      window.pendingRecipeToLoad = recipe;
      var title = document.getElementById('batch-modal-title');
      if (title) title.textContent = 'Enter Batch Number';
      var overlay = document.getElementById('batch-number-modal');
      var input = document.getElementById('load-recipe-batch-input');
      if (overlay) overlay.style.display = 'flex';
      if (input) { input.value = ''; input.focus(); }
    }).catch(function (e) {
      toast(e.message || 'Load failed', 'error');
    });
  };

  window.confirmBatchNumberAndLoad = function () {
    var input = document.getElementById('load-recipe-batch-input');
    var batch = input ? input.value.trim() : '';
    if (!DT.loadCtx || !DT.loadCtx.recipe) {
      if (typeof closeBatchNumberModal === 'function') closeBatchNumberModal();
      return;
    }
    if (!batch) { toast('Please enter a batch number', 'error'); return; }
    DT.loadCtx.batch = batch;
    var overlay = document.getElementById('batch-number-modal');
    if (overlay) overlay.style.display = 'none';
    var arModal = document.getElementById('ar-number-modal');
    var arInput = document.getElementById('load-recipe-ar-input');
    if (arModal) arModal.style.display = 'flex';
    if (arInput) { arInput.value = ''; arInput.focus(); }
  };

  window.dtCloseArModal = function () {
    var arModal = document.getElementById('ar-number-modal');
    if (arModal) arModal.style.display = 'none';
    DT.loadCtx = null;
    window.pendingRecipeToLoad = null;
  };

  window.dtConfirmArNumber = function () {
    var arInput = document.getElementById('load-recipe-ar-input');
    var ar = arInput ? arInput.value.trim() : '';
    if (!ar) { toast('Please enter an AR number', 'error'); return; }
    if (!DT.loadCtx) return;
    DT.loadCtx.ar = ar;
    var arModal = document.getElementById('ar-number-modal');
    if (arModal) arModal.style.display = 'none';
    openBeakerSelect('load', 'Select beaker for “' + (DT.loadCtx.recipe.name || 'Recipe') + '”');
  };

  function openBeakerSelect(purpose, subtitle) {
    DT.beakerPickPurpose = purpose;
    DT.beakerPick = null;
    var modal = document.getElementById('dt-beaker-select-modal');
    var sub = document.getElementById('dt-beaker-select-sub');
    var both = document.getElementById('dt-beaker-both-btn');
    var proceed = document.getElementById('dt-beaker-proceed-btn');
    if (sub) sub.textContent = subtitle || '';
    if (both) both.style.display = purpose === 'load' ? '' : 'none';
    if (proceed) proceed.style.display = 'none';
    document.querySelectorAll('#dt-beaker-select-modal .beaker-select-btn').forEach(function (b) {
      b.classList.remove('selected', 'is-selected');
    });
    if (modal) modal.style.display = 'flex';
  }

  window.dtPickBeaker = function (val) {
    DT.beakerPick = val;
    document.querySelectorAll('#dt-beaker-select-modal .beaker-select-btn').forEach(function (b) {
      var match = String(b.getAttribute('data-beaker')) === String(val);
      b.classList.toggle('selected', match);
      b.classList.toggle('is-selected', match);
    });
    var proceed = document.getElementById('dt-beaker-proceed-btn');
    if (proceed) proceed.style.display = '';
  };

  window.dtCloseBeakerSelect = function () {
    var modal = document.getElementById('dt-beaker-select-modal');
    if (modal) modal.style.display = 'none';
    DT.beakerPick = null;
    DT.beakerPickPurpose = null;
    DT.loadCtx = null;
  };

  window.dtConfirmBeakerSelect = function () {
    if (DT.beakerPick == null) { toast('Select a beaker', 'error'); return; }
    var purpose = DT.beakerPickPurpose;
    var pick = DT.beakerPick;
    var modal = document.getElementById('dt-beaker-select-modal');
    if (modal) modal.style.display = 'none';

    if (purpose === 'calibration') {
      DT.calBeaker = pick === 2 ? 2 : 1;
      DT.calSessionActive = true;
      syncDtNavLock();
      var numEl = document.getElementById('calibration-beaker-num');
      if (numEl) numEl.textContent = String(DT.calBeaker);
      var sensor = document.getElementById('dt-cal-sensor');
      if (sensor) sensor.value = DT.calBeaker === 2 ? 'IR2' : 'IR1';
      updateTempDisplay(DT.latestTemps || {});
      go('calibration-type-select');
      return;
    }

    if (purpose === 'load' && DT.loadCtx && DT.loadCtx.recipe) {
      applyRecipeToDashboard(DT.loadCtx.recipe, DT.loadCtx.batch, DT.loadCtx.ar, pick);
      DT.loadCtx = null;
      window.pendingRecipeToLoad = null;
      go('home');
      toast('Recipe loaded — press Start on the selected basket', 'success');
    }
  };

  function applyRecipeToDashboard(recipe, batch, ar, beakerPick) {
    var product = recipe.productName || recipe.name || 'Recipe';
    var temperature = parseFloat(recipe.temp != null ? recipe.temp : recipe.setTemperature) || 37.0;
    var mode = recipe.mode || 'manual';
    var duration = recipe.duration;
    if ((duration == null || !(duration > 0)) && recipe.setDuration) {
      duration = parseHHMMSS(recipe.setDuration);
    }
    var targets = beakerPick === 'both' ? [1, 2] : [beakerPick === 2 ? 2 : 1];
    targets.forEach(function (b) {
      DT.products[b] = product;
      DT.batches[b] = batch || '';
      DT.ars[b] = ar || '';
      DT.setTemp[b] = temperature;
      DT.modes[b] = mode;
      DT.durations[b] = duration;
      DT.media[b] = recipe.media || null;
      DT.mesh[b] = recipe.mesh || null;
      DT.configured[b] = true;
      updateModeButtonsUI(b);
    });
    updateDashboardTempButton();
    updateProductNames();
    updateBasketStates();
    if (typeof logAuditEvent === 'function') {
      try {
        logAuditEvent('Loaded recipe', product + ', batch ' + (batch || '--') + ', AR ' + (ar || '--'), {
          eventType: 'lifecycle',
        });
      } catch (e) {}
    }
  }

  window.dtRunRecipe = function (recipe) {
    if (!recipe) return;
    DT.loadCtx = { recipe: recipe, batch: '', ar: '', beaker: null };
    window.pendingRecipeToLoad = recipe;
    var overlay = document.getElementById('batch-number-modal');
    var input = document.getElementById('load-recipe-batch-input');
    if (overlay) overlay.style.display = 'flex';
    if (input) { input.value = ''; input.focus(); }
  };

  // -------------------- Test run --------------------

  function finishBasketUi(basket, opts) {
    opts = opts || {};
    DT.running[basket] = false;
    DT.heaterOn[basket] = false;
    DT.preheatInProgress[basket] = false;
    if (DT._confirmPending) DT._confirmPending[basket] = false;
    stopRunPoll(basket);
    syncDtNavLock();
    setStartBtnPhase(basket, 'idle');
    var container = document.getElementById('basket' + basket + '-container');
    if (container) {
      var ring = container.querySelector('.basket-active-ring');
      if (ring) ring.remove();
      if (opts.resetHoles !== false) {
        container.classList.remove('completed');
        container.querySelectorAll('.basket-hole').forEach(function (el) {
          el.classList.remove('completed');
        });
      }
    }
    updateHeaterIndicators();
    updateModeButtonsUI(basket);
    var banner = document.getElementById('dt-ready-banner');
    if (banner && String(banner.getAttribute('data-basket')) === String(basket)) {
      banner.style.display = 'none';
    }
  }

  function openTestRun(basket, params) {
    ensureSse();
    DT.selectedBasket = basket;
    DT.basketConfig = params.basketConfig || DT.basketConfig || 6;
    DT.running[basket] = true; // run session active (preheat phase counts for nav lock)
    syncDtNavLock();
    DT._runParams = DT._runParams || {};
    DT._runParams[basket] = params;
    setStartBtnPhase(basket, 'preheating');
    // Stay on dashboard test screen (Dt_Dr_Reddy behavior)
    go('home');
    updateProductNames();
    api('/api/data/dt/runs/' + basket + '/preheat', {
      method: 'POST',
      body: {
        setTemperature: params.setTemperature,
        mode: params.mode,
        durationMinutes: params.durationMinutes,
        basketConfig: params.basketConfig || DT.basketConfig,
        productName: params.productName,
        batchNumber: params.batchNumber,
        recipeId: params.recipeId,
        recipeName: params.recipeName || params.productName,
        arNumber: params.arNumber,
        media: params.media,
        mesh: params.mesh,
      },
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Preheat failed');
      toast('Preheating basket ' + basket + '…', 'info');
      DT.heaterOn[basket] = true;
      updateHeaterIndicators();
      startRunPoll(basket);
    }).catch(function (e) {
      DT.running[basket] = false;
      setStartBtnPhase(basket, 'idle');
      toast(e.message || 'Preheat failed', 'error');
    });
  }

  function promptConfirmStart(basket) {
    if (DT._confirmPending && DT._confirmPending[basket]) return;
    DT._confirmPending = DT._confirmPending || {};
    DT._confirmPending[basket] = true;
    var params = (DT._runParams && DT._runParams[basket]) || {};
    var msg = 'Basket ' + basket + ' has reached the set temperature (' +
      Number(params.setTemperature || DT.setTemp[basket] || 37).toFixed(1) +
      '°C). Do you want to start the test?';
    var finish = function (ok) {
      DT._confirmPending[basket] = false;
      if (!ok) {
        // Cancel → stop heaters and return to Preheat (Dt_Dr_Reddy)
        api('/api/data/dt/runs/' + basket + '/stop', {
          method: 'POST',
          body: { aborted: true, reason: 'start_cancelled' },
        }).then(function () {
          finishBasketUi(basket);
        }).catch(function () {
          finishBasketUi(basket);
        });
        return;
      }
      DT.selectedBasket = basket;
      window.dtConfirmStart();
    };
    if (typeof showYesNoModal === 'function') {
      showYesNoModal(msg, 'Start Test', 'Start', 'Cancel').then(finish);
    } else if (window.confirm(msg)) {
      finish(true);
    } else {
      finish(false);
    }
  }

  function renderTestRunShell(basket, params) {
    var set = function (id, v) {
      var el = document.getElementById(id);
      if (el) el.textContent = v == null ? '--' : String(v);
    };
    set('tr-product-name', params.productName || '--');
    set('tr-batch-number', params.batchNumber || '--');
    set('tr-speed', (params.setTemperature != null ? params.setTemperature + '°C' : '--'));
    set('tr-target-rot', (params.basketConfig || DT.basketConfig || 6) + ' tubes');
    set('tr-mode', String(params.mode || 'manual').toUpperCase());
    set('dt-run-basket', 'Basket ' + basket);
    set('dt-run-state', 'PREHEAT');
    var holes = document.getElementById('dt-holes');
    if (holes) {
      holes.innerHTML = '';
      var n = params.basketConfig || DT.basketConfig || 6;
      for (var i = 1; i <= n; i++) {
        (function (hole) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn btn-secondary dt-hole-btn';
          b.textContent = 'Tube ' + hole;
          b.id = 'dt-hole-' + hole;
          b.onclick = function () { dtTapHole(basket, hole); };
          holes.appendChild(b);
        })(i);
      }
      holes.style.display = (params.mode === 'manual') ? '' : 'none';
    }
    ['tr-header-iw1-block', 'tr-header-iw2-block'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    var dtPanel = document.getElementById('dt-test-panel');
    if (dtPanel) dtPanel.style.display = '';
  }

  function reportIdFromResponse(res) {
    if (!res) return null;
    var run = res.run || {};
    var report = res.savedReport || res.lastSavedReport || res.report ||
      run.savedReport || run.lastSavedReport;
    if (!report) return null;
    if (typeof report === 'number') return report;
    var rid = report.id != null ? report.id : report.reportId;
    return rid != null ? rid : null;
  }

  function openPendingTestReport(res, opts) {
    opts = opts || {};
    if (opts.aborted) {
      go('home');
      return;
    }
    var rid = reportIdFromResponse(res);
    if (rid && typeof openReportPreview === 'function') {
      try {
        openReportPreview(rid, { setGate: true });
        return;
      } catch (e) {}
    }
    go('home');
    if (typeof loadReports === 'function') {
      try { loadReports(); } catch (e2) {}
    }
  }

  function startRunPoll(basket) {
    stopRunPoll(basket);
    DT.pollTimers = DT.pollTimers || { 1: null, 2: null };
    DT.pollTimers[basket] = setInterval(function () {
      api('/api/data/dt/runs/' + basket).then(function (res) {
        var run = res.run || {};
        var stateEl = document.getElementById('dt-run-state');
        if (stateEl) stateEl.textContent = run.state || '--';
        var dashTimer = document.getElementById('timer' + basket);
        var elapsed = run.mode === 'timer' && run.remainingSeconds != null
          ? run.remainingSeconds : run.elapsedSeconds;
        var formatted = fmtSec(elapsed);
        if (dashTimer) dashTimer.textContent = formatted;
        var timerEl = document.getElementById('tr-timer');
        if (timerEl) timerEl.textContent = formatted;
        var minEl = document.getElementById('dt-run-min');
        var maxEl = document.getElementById('dt-run-max');
        if (minEl) minEl.textContent = run.minTemp != null ? Number(run.minTemp).toFixed(1) : '--';
        if (maxEl) maxEl.textContent = run.maxTemp != null ? Number(run.maxTemp).toFixed(1) : '--';
        if (run.state === 'AWAIT_CONFIRM' || run.state === 'READY') {
          var btn = document.getElementById('dt-confirm-btn');
          if (btn) { btn.disabled = false; btn.textContent = 'Confirm Start'; }
          markBasketReady(basket, 'run_state');
        }
        if (run.state === 'RUNNING') {
          setStartBtnPhase(basket, 'running');
          var container = document.getElementById('basket' + basket + '-container');
          if (container && !container.querySelector('.basket-active-ring')) {
            var ring = document.createElement('div');
            ring.className = 'basket-active-ring';
            container.appendChild(ring);
          }
          // Mark completed holes on dashboard
          var holes = run.completedHoles || {};
          Object.keys(holes).forEach(function (h) {
            var dashHoles = document.querySelectorAll('#basket' + basket + '-container .basket-hole');
            dashHoles.forEach(function (el) {
              if (String(el.textContent) === String(h)) el.classList.add('completed');
            });
            var el2 = document.getElementById('dt-hole-' + h);
            if (el2) { el2.classList.add('completed'); el2.disabled = true; }
          });
        }
        if (run.state === 'COMPLETE' || run.state === 'ABORTED') {
          finishBasketUi(basket);
          toast(run.status || run.state, run.aborted ? 'error' : 'success');
          openPendingTestReport(res, { aborted: !!run.aborted });
        } else if (run.state === 'IDLE' && DT.running[basket]) {
          // Server cleared the run after auto-save; treat as finished.
          finishBasketUi(basket);
          openPendingTestReport(res, { aborted: false });
        }
      }).catch(function () {});
    }, 1000);
    DT.pollTimer = DT.pollTimers[basket];
  }

  function stopRunPoll(basket) {
    if (basket == null) {
      [1, 2].forEach(function (b) { stopRunPoll(b); });
      if (DT.pollTimer) { clearInterval(DT.pollTimer); DT.pollTimer = null; }
      return;
    }
    DT.pollTimers = DT.pollTimers || { 1: null, 2: null };
    if (DT.pollTimers[basket]) {
      clearInterval(DT.pollTimers[basket]);
      DT.pollTimers[basket] = null;
    }
    if (DT.pollTimer && DT.pollTimers[1] == null && DT.pollTimers[2] == null) {
      DT.pollTimer = null;
    }
  }

  window.dtConfirmStart = function () {
    var basket = DT.selectedBasket;
    api('/api/data/dt/runs/' + basket + '/confirm', { method: 'POST', body: {} })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Start failed');
        if (DT._confirmPending) DT._confirmPending[basket] = false;
        setStartBtnPhase(basket, 'running');
        toast('Test started', 'success');
        var banner = document.getElementById('dt-ready-banner');
        if (banner) banner.style.display = 'none';
        var btn = document.getElementById('dt-confirm-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
      })
      .catch(function (e) {
        if (DT._confirmPending) DT._confirmPending[basket] = false;
        setStartBtnPhase(basket, 'ready');
        toast(e.message || 'Start failed', 'error');
      });
  };

  window.dtTapHole = dtTapHole;
  function dtTapHole(basket, hole) {
    api('/api/data/dt/runs/' + basket + '/tap', { method: 'POST', body: { vessel: hole } })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Tap failed');
        var el = document.getElementById('dt-hole-' + hole);
        if (el) { el.classList.add('completed'); el.disabled = true; }
        var container = document.getElementById('basket' + basket + '-container');
        if (container && DT.basketConfig === 1) {
          container.classList.add('completed');
        }
        var dashHoles = document.querySelectorAll('#basket' + basket + '-container .basket-hole');
        dashHoles.forEach(function (node) {
          if (String(node.textContent) === String(hole)) node.classList.add('completed');
        });
        var run = res.run || {};
        var finished = !!(res.savedReport || res.report ||
          run.state === 'COMPLETE' || run.state === 'ABORTED' ||
          (run.state === 'IDLE' && DT.running[basket]));
        if (finished) {
          finishBasketUi(basket);
          var aborted = !!(run.aborted || run.state === 'ABORTED');
          toast(
            aborted ? 'Test stopped' : 'Test complete — report pending approval',
            aborted ? 'error' : 'success'
          );
          openPendingTestReport(res, { aborted: aborted });
        }
      })
      .catch(function (e) { toast(e.message || 'Tap failed', 'error'); });
  }

  window.dtStopTest = function (aborted) {
    var basket = DT.selectedBasket;
    api('/api/data/dt/runs/' + basket + '/stop', {
      method: 'POST',
      body: { aborted: !!aborted, reason: aborted ? 'operator_abort' : 'completed' },
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Stop failed');
      finishBasketUi(basket);
      toast(aborted ? 'Test aborted' : 'Test stopped', aborted ? 'error' : 'success');
      openPendingTestReport(res, { aborted: !!aborted });
    }).catch(function (e) { toast(e.message || 'Stop failed', 'error'); });
  };

  window.trStopTest = function () { window.dtStopTest(true); };
  window.trHandleStartButton = function () { window.dtConfirmStart(); };
  window.trPauseTest = function () { toast('Pause not used on DT', 'info'); };
  window.trResumeTest = function () {};
  window.trDispenseTest = function () {};

  // -------------------- Validation --------------------

  function clearValPoll() {
    if (_valPollTimer) {
      clearInterval(_valPollTimer);
      _valPollTimer = null;
    }
  }

  function currentValBasket() {
    var hidden = document.getElementById('dt-val-basket');
    var n = parseInt((hidden && hidden.value) || String(_valBasket) || '1', 10);
    return n === 2 ? 2 : 1;
  }

  window.selectBeakerForValidation = function (beakerId) {
    _valBasket = beakerId === 2 ? 2 : 1;
    var hidden = document.getElementById('dt-val-basket');
    if (hidden) hidden.value = String(_valBasket);
    var numEl = document.getElementById('val-beaker-num');
    if (numEl) numEl.textContent = String(_valBasket);
    go('validate-type-select');
  };

  window.updateValidationSelection = function () {
    var selected = document.querySelector('input[name="val-type"]:checked');
    var stroke = document.getElementById('val-stroke');
    var temp = document.getElementById('val-temp');
    if (stroke) stroke.classList.toggle('selected', !!(selected && selected.value === 'stroke'));
    if (temp) temp.classList.toggle('selected', !!(selected && selected.value === 'temp'));
  };

  window.startValidationProcess = function () {
    if (typeof userCanRunValidation === 'function' && !userCanRunValidation()) {
      if (typeof denyPermission === 'function') denyPermission('run validation');
      return;
    }
    var selected = document.querySelector('input[name="val-type"]:checked');
    if (!selected) {
      toast('Please select a validation type', 'error');
      return;
    }
    window.updateValidationSelection();
    var basket = currentValBasket();
    if (selected.value === 'stroke') {
      var strokeBeaker = document.getElementById('stroke-beaker');
      if (strokeBeaker) strokeBeaker.textContent = String(basket);
      var counter = document.getElementById('stroke-counter');
      if (counter) counter.textContent = '0';
      var statusCard = document.getElementById('stroke-validation-status-card');
      if (statusCard) statusCard.style.display = 'none';
      var completeBtn = document.getElementById('stroke-complete-btn');
      if (completeBtn) {
        completeBtn.disabled = true;
        completeBtn.style.opacity = '0.5';
        completeBtn.style.cursor = 'not-allowed';
      }
      go('stroke-validation');
      window.dtStartStrokeValidation();
    } else if (selected.value === 'temp') {
      var tempBeaker = document.getElementById('temp-beaker');
      if (tempBeaker) tempBeaker.textContent = String(basket);
      _tempValRunning = false;
      var msg = document.getElementById('validation-message');
      var st = document.getElementById('validation-status');
      if (msg) msg.textContent = 'Ready to Validate';
      if (st) st.textContent = '-';
      var completeTemp = document.getElementById('complete-temp-validation-btn');
      if (completeTemp) completeTemp.style.display = 'none';
      var startLbl = document.getElementById('validation-stop-btn-text');
      if (startLbl) startLbl.textContent = 'START';
      go('temp-validation');
    }
  };

  window.dtStartStrokeValidation = function () {
    var basket = currentValBasket();
    clearValPoll();
    api('/api/data/dt/validation/stroke/' + basket + '/start', { method: 'POST', body: {} })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Start failed');
        toast('Stroke validation started (60s)', 'info');
        pollValidation('stroke', basket);
      })
      .catch(function (e) { toast(e.message || 'Failed', 'error'); });
  };

  window.dtStartTempValidation = function () {
    var basket = currentValBasket();
    var setInput = document.getElementById('temp-validation-set-temp-input');
    var hidden = document.getElementById('dt-val-temp');
    var temp = parseFloat((setInput && setInput.value) || (hidden && hidden.value) || '37');
    if (isNaN(temp) || temp < 20 || temp > 55) {
      toast('Set temperature must be 20–55°C', 'error');
      return;
    }
    if (hidden) hidden.value = String(temp);
    var setDisp = document.getElementById('set-temp-display');
    if (setDisp) setDisp.textContent = temp.toFixed(1);
    clearValPoll();
    api('/api/data/dt/validation/temp/' + basket + '/start', {
      method: 'POST',
      body: { setTemperature: temp },
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Start failed');
      _tempValRunning = true;
      syncDtNavLock();
      var startLbl = document.getElementById('validation-stop-btn-text');
      if (startLbl) startLbl.textContent = 'STOP';
      var msg = document.getElementById('validation-message');
      if (msg) msg.textContent = 'Temperature hold in progress';
      toast('Temp validation started', 'info');
      pollValidation('temp', basket);
    }).catch(function (e) { toast(e.message || 'Failed', 'error'); });
  };

  window.applyValidationSetTemp = function () {
    var setInput = document.getElementById('temp-validation-set-temp-input');
    var temp = parseFloat(setInput && setInput.value);
    if (isNaN(temp) || temp < 20 || temp > 55) {
      toast('Set temperature must be 20–55°C', 'error');
      return;
    }
    var hidden = document.getElementById('dt-val-temp');
    if (hidden) hidden.value = String(temp);
    var setDisp = document.getElementById('set-temp-display');
    if (setDisp) setDisp.textContent = temp.toFixed(1);
    toast('Set temperature applied: ' + temp.toFixed(1) + '°C', 'success');
  };

  window.toggleTempValidation = function () {
    if (_tempValRunning) {
      window.stopValidation();
      return;
    }
    window.dtStartTempValidation();
  };

  window.stopValidation = function (opts) {
    opts = opts || {};
    clearValPoll();
    var basket = currentValBasket();
    var kind = _valKind;
    if (kind === 'temp' || _tempValRunning) {
      api('/api/data/dt/validation/temp/' + basket + '/abort', { method: 'POST', body: {} }).catch(function () {});
    }
    if (kind === 'stroke') {
      api('/api/data/dt/validation/stroke/' + basket + '/abort', { method: 'POST', body: {} }).catch(function () {});
    }
    _tempValRunning = false;
    _valKind = null;
    syncDtNavLock();
    var startLbl = document.getElementById('validation-stop-btn-text');
    if (startLbl) startLbl.textContent = 'START';
    if (!opts.stay) go('validate-type-select');
  };

  window.exitTempValidation = function () {
    window.stopValidation();
  };

  window.completeValidation = function (kind) {
    kind = kind === 'temp' ? 'temp' : 'stroke';
    var basket = currentValBasket();
    clearValPoll();
    api('/api/data/dt/validation/' + kind + '/' + basket + '/save', { method: 'POST', body: {} })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Save failed');
        toast('Validation report saved (pending approval)', 'success');
        _tempValRunning = false;
        _valKind = null;
        syncDtNavLock();
        var report = res.report || {};
        var rid = report.id;
        if (rid && typeof openReportPreview === 'function') {
          openReportPreview(rid, { setGate: true });
        } else {
          go('reports');
          if (typeof loadReports === 'function') loadReports();
        }
      })
      .catch(function (e) { toast(e.message || 'Save failed', 'error'); });
  };

  function formatHoldRemaining(s) {
    var n = Math.max(0, Math.floor(Number(s) || 0));
    var m = Math.floor(n / 60);
    var sec = n % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function pollValidation(kind, basket) {
    _valKind = kind;
    _valBasket = basket;
    syncDtNavLock();
    var statusEl = document.getElementById('dt-val-status');
    clearValPoll();
    _valPollTimer = setInterval(function () {
      api('/api/data/dt/validation/' + kind + '/' + basket).then(function (res) {
        var s = res.session || {};
        if (statusEl) {
          statusEl.textContent = (s.state || '--') +
            (s.strokesPerMin != null ? (' | ' + s.strokesPerMin + '/min') : '') +
            (s.maxDeviation != null ? (' | dev=' + s.maxDeviation) : '') +
            (s.status ? (' | ' + s.status) : '');
        }

        if (kind === 'stroke') {
          var counter = document.getElementById('stroke-counter');
          if (counter && s.strokesPerMin != null) counter.textContent = String(s.strokesPerMin);
          if (s.state === 'COMPLETE' || s.state === 'ABORTED') {
            clearValPoll();
            if (s.state === 'ABORTED') {
              _valKind = null;
              syncDtNavLock();
            }
            var card = document.getElementById('stroke-validation-status-card');
            var text = document.getElementById('stroke-validation-status-text');
            var btn = document.getElementById('stroke-complete-btn');
            if (card) {
              card.style.display = '';
              card.className = 'dt-val-status-card ' + (s.status === 'PASSED' ? 'is-pass' : 'is-fail');
            }
            if (text) text.textContent = s.status === 'PASSED' ? 'VALIDATION PASSED' : 'VALIDATION FAILED';
            if (btn && s.state === 'COMPLETE') {
              btn.disabled = false;
              btn.style.opacity = '1';
              btn.style.cursor = 'pointer';
            }
          }
        }

        if (kind === 'temp') {
          var liveTemps = DT.latestTemps || {};
          var irKey = basket === 2 ? 'IR2' : 'IR1';
          var liveIr = liveTemps[irKey];
          var samples = s.samples || [];
          var lastSample = samples.length ? samples[samples.length - 1].temp : null;
          var measured = liveIr != null ? liveIr : (lastSample != null ? lastSample : (s.maxTemp != null ? s.maxTemp : null));
          if (measured != null) {
            var meas = document.getElementById('measured-temp-display');
            if (meas) meas.textContent = Number(measured).toFixed(1);
          }
          if (s.setTemperature != null || s.setTemp != null) {
            var setDisp = document.getElementById('set-temp-display');
            var sv = s.setTemperature != null ? s.setTemperature : s.setTemp;
            if (setDisp) setDisp.textContent = Number(sv).toFixed(1);
          }
          if (s.maxDeviation != null) {
            var dev = document.getElementById('deviation-display');
            if (dev) dev.textContent = '±' + Number(s.maxDeviation).toFixed(2) + '°C';
          }
          var rem = null;
          if (s.remainingSec != null) rem = s.remainingSec;
          else if (s.holdRemaining != null) rem = s.holdRemaining;
          else if (s.state === 'HOLDING' && s.holdStartedAtEpoch && s.durationSec) {
            rem = Math.max(0, Number(s.durationSec) - ((Date.now() / 1000) - Number(s.holdStartedAtEpoch)));
          } else if (s.state === 'PREHEAT') {
            rem = s.durationSec || 120;
          }
          if (rem != null) {
            var el = document.getElementById('temp-validation-elapsed');
            if (el) el.textContent = formatHoldRemaining(rem);
          }
          var msg = document.getElementById('validation-message');
          var st = document.getElementById('validation-status');
          if (msg) msg.textContent = s.state || 'Running';
          if (st) st.textContent = s.status || '-';
          if (s.state === 'COMPLETE' || s.state === 'ABORTED') {
            clearValPoll();
            _tempValRunning = false;
            if (s.state === 'ABORTED') {
              _valKind = null;
            }
            syncDtNavLock();
            var startLbl = document.getElementById('validation-stop-btn-text');
            if (startLbl) startLbl.textContent = 'START';
            var completeTemp = document.getElementById('complete-temp-validation-btn');
            if (completeTemp && s.state === 'COMPLETE') completeTemp.style.display = '';
            if (msg) msg.textContent = s.state === 'COMPLETE' ? 'Hold complete' : 'Aborted';
            if (st) st.textContent = s.status || '-';
          }
        }
      }).catch(function () {});
    }, 1000);
  }

  // -------------------- Calibration --------------------

  window.dtOpenCalibrationBeakerSelect = function () {
    openBeakerSelect('calibration', 'Select beaker to calibrate');
  };

  window.dtCalibrateFromPage = function () {
    var measured = parseFloat((document.getElementById('calibration-measured-temp-input') || {}).value);
    var hidden = document.getElementById('dt-cal-temp');
    if (hidden) hidden.value = String(measured);
    var sensor = document.getElementById('dt-cal-sensor');
    if (sensor) sensor.value = (DT.calBeaker === 2) ? 'IR2' : 'IR1';
    window.dtCalibrate();
  };

  window.dtCalibrate = function () {
    var beaker = DT.calBeaker === 2 ? 2 : 1;
    var measuredEl = document.getElementById('calibration-measured-temp-input');
    var temp = measuredEl
      ? parseFloat(measuredEl.value)
      : parseFloat((document.getElementById('dt-cal-temp') || {}).value);
    if (isNaN(temp) || temp < 0 || temp > 55) { toast('Enter valid measured temperature 0–55°C', 'error'); return; }

    function doCal(token) {
      return api('/api/data/calibration', {
        method: 'POST',
        body: {
          beaker: beaker,
          probe: 'BOTH',
          temperature: temp,
          saveReport: true,
        },
        headers: token ? { 'X-Approval-Verify-Token': token } : {},
      }).then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Calibration failed');
        DT.calSessionActive = false;
        syncDtNavLock();
        var sensors = (res.sensors || []).map(function (s) { return s.sensor; }).join('+') ||
          ('IR' + beaker + '+EXT' + beaker);
        toast('Calibrated ' + sensors + ' to ' + temp.toFixed(1) + '°C', 'success');
        var rid = (res.report && res.report.id) || res.reportId ||
          (res.savedReport && res.savedReport.id);
        if (rid && typeof openReportPreview === 'function') {
          openReportPreview(rid, { setGate: true });
        } else {
          go('validate');
        }
      });
    }

    var calOpts = {
      purpose: 'calibration',
      titleText: 'Calibration approval required',
      subtitleText: 'Enter credentials to authorize temperature calibration (IR + EXT).',
    };
    if (typeof openApprovalVerifyModal === 'function') {
      openApprovalVerifyModal(calOpts).then(function (token) {
        if (!token) return;
        doCal(token).catch(function (e) { toast(e.message || 'Failed', 'error'); });
      }).catch(function (e) {
        toast((e && e.message) || 'QA verification UI is missing.', 'error');
      });
    } else {
      doCal(null).catch(function (e) { toast(e.message || 'Failed', 'error'); });
    }
  };

  // -------------------- Settings: beakers / baskets / heater --------------------

  function persistInstrumentSettings() {
    return api('/api/data/dt/instrument-settings', {
      method: 'POST',
      body: {
        basketConfig: DT.basketConfig,
        configuredBeakers: {
          '1': !!DT.configured[1],
          '2': !!DT.configured[2],
        },
        setTemp: {
          '1': Number(DT.setTemp[1] || 37),
          '2': Number(DT.setTemp[2] || 37),
        },
      },
    }).catch(function (e) {
      console.warn('[DT] persist instrument settings failed', e);
      return null;
    });
  }

  function applyInstrumentSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    var cfg = parseInt(settings.basketConfig, 10);
    if ([1, 3, 6].indexOf(cfg) >= 0) DT.basketConfig = cfg;
    var conf = settings.configuredBeakers || settings.configured || {};
    DT.configured[1] = conf['1'] != null ? !!conf['1'] : (conf[1] != null ? !!conf[1] : true);
    DT.configured[2] = conf['2'] != null ? !!conf['2'] : (conf[2] != null ? !!conf[2] : true);
    if (!DT.configured[1] && !DT.configured[2]) {
      DT.configured[1] = true;
      DT.configured[2] = true;
    }
    var temps = settings.setTemp || {};
    var t1 = parseFloat(temps['1'] != null ? temps['1'] : temps[1]);
    var t2 = parseFloat(temps['2'] != null ? temps['2'] : temps[2]);
    if (!isNaN(t1)) DT.setTemp[1] = t1;
    if (!isNaN(t2)) DT.setTemp[2] = t2;
    updateBasketHoles(1, DT.basketConfig);
    updateBasketHoles(2, DT.basketConfig);
    updateBasketStates();
    updateDashboardTempButton();
    var in1 = document.getElementById('set-temp-1');
    var in2 = document.getElementById('set-temp-2');
    if (in1) in1.value = String(DT.setTemp[1]);
    if (in2) in2.value = String(DT.setTemp[2]);
  }

  function loadInstrumentSettings() {
    return api('/api/data/dt/instrument-settings')
      .then(function (res) {
        if (res && res.ok && res.settings) applyInstrumentSettings(res.settings);
      })
      .catch(function () {});
  }

  var _settingsBeakerPick = null;
  window.dtSettingsSelectBeaker = function (val) {
    _settingsBeakerPick = val;
    ['beaker-select-1', 'beaker-select-2', 'beaker-select-both'].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      var match = (id === 'beaker-select-1' && val === 1) ||
        (id === 'beaker-select-2' && val === 2) ||
        (id === 'beaker-select-both' && val === 'both');
      el.classList.toggle('selected', match);
      el.classList.toggle('is-selected', match);
    });
    var btn = document.getElementById('proceed-beaker-btn');
    if (btn) btn.style.display = '';
  };

  window.dtProceedBeakerSelection = function () {
    if (_settingsBeakerPick == null) { toast('Select a beaker', 'error'); return; }
    if (_settingsBeakerPick === 'both') {
      DT.configured[1] = true;
      DT.configured[2] = true;
    } else if (_settingsBeakerPick === 2) {
      DT.configured[1] = false;
      DT.configured[2] = true;
    } else {
      DT.configured[1] = true;
      DT.configured[2] = false;
    }
    updateBasketStates();
    persistInstrumentSettings().then(function () {
      go('home');
      toast('Beaker configuration saved', 'success');
    });
  };

  window.dtSetBasketConfig = function (c) {
    c = parseInt(c, 10);
    if ([1, 3, 6].indexOf(c) < 0) return;
    if (DT.running[1] || DT.running[2]) {
      toast('Cannot change basket config while a test is running', 'error');
      return;
    }
    var apply = function () {
      DT.basketConfig = c;
      updateBasketHoles(1, c);
      updateBasketHoles(2, c);
      persistInstrumentSettings().then(function () {
        go('home');
        toast(c + '-tube basket configuration saved', 'success');
      });
    };
    if (typeof showYesNoModal === 'function') {
      showYesNoModal('Apply ' + c + '-tube basket configuration?', 'Add Baskets', 'Yes', 'No')
        .then(function (ok) { if (ok) apply(); });
    } else {
      apply();
    }
  };

  window.dtToggleHeater = function (basket) {
    var turningOn = !DT.heaterOn[basket];
    var input = document.getElementById('set-temp-' + basket);
    var setTempVal = parseFloat(input && input.value) || DT.setTemp[basket] || 37;
    DT.setTemp[basket] = setTempVal;
    updateDashboardTempButton();

    var t1 = 0, t2 = 0;
    if (turningOn) {
      if (basket === 1) {
        t1 = setTempVal;
        t2 = (DT.configured[2] && DT.heaterOn[2]) ? Number(DT.setTemp[2] || 0) : 0;
      } else {
        t2 = setTempVal;
        t1 = (DT.configured[1] && DT.heaterOn[1]) ? Number(DT.setTemp[1] || 0) : 0;
      }
    } else {
      if (basket === 1) {
        t1 = 0;
        t2 = (DT.configured[2] && DT.heaterOn[2]) ? Number(DT.setTemp[2] || 0) : 0;
      } else {
        t2 = 0;
        t1 = (DT.configured[1] && DT.heaterOn[1]) ? Number(DT.setTemp[1] || 0) : 0;
      }
    }

    api('/api/hardware/dt/preheat', { method: 'POST', body: { t1: t1, t2: t2 } })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Heater command failed');
        DT.heaterOn[basket] = turningOn;
        updateHeaterIndicators();
        var label = document.getElementById('control-text-' + basket);
        if (label) label.textContent = turningOn ? 'Stop' : 'Start';
        toast('Heater ' + basket + (turningOn ? ' ON' : ' OFF'), 'success');
      })
      .catch(function (e) { toast(e.message || 'Heater failed', 'error'); });
  };

  // Keep quick-test helpers for compatibility
  window.startQuickTest = function () {
    ensureSse();
    go('home');
    toast('Use Timer/Manual on the dashboard, then press Start', 'info');
  };
  window.dtToggleQtDuration = function () {};
  window.dtStartQuickRun = function () {};

  window.showCreateRecipe = function () {
    if (typeof startRecipeCreation === 'function') startRecipeCreation();
    else go('create-recipe-step1');
  };

  // Boot
  function boot() {
    ensureSse();
    loadInstrumentSettings().then(function () {
      refreshDashboard();
    });
    // Pull live temps once
    api('/api/hardware/dt/live').then(function (res) {
      if (res && res.temps) updateTempDisplay(res.temps);
    }).catch(function () {});
  }
  document.addEventListener('DOMContentLoaded', boot);
  setTimeout(boot, 400);

  // Refresh dashboard holes when returning home
  var _origGoToPage = window.goToPage;
  if (typeof _origGoToPage === 'function') {
    window.goToPage = function (pageName) {
      var r = _origGoToPage.apply(this, arguments);
      if (String(pageName) === 'home' || String(pageName) === 'page-home') {
        setTimeout(refreshDashboard, 50);
      }
      return r;
    };
  }

  window.DTClient = DT;
})();
