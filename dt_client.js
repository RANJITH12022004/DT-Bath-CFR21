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
    fromRecipe: { 1: false, 2: false },
    durations: { 1: null, 2: null },
    media: { 1: null, 2: null },
    mesh: { 1: null, 2: null },
    heaterOn: { 1: false, 2: false },
    /** True when heat was started from Settings (hardware PHW only, no test run). */
    heaterManual: { 1: false, 2: false },
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
    /** Report IDs waiting to open while the other basket is still in a test. */
    pendingReportQueue: [],
  };

  // Declared early so nav-lock helpers can close over them (assigned in validation section).
  var _valPollTimer = null;
  var _valKind = null;
  var _valBasket = 1;
  var _tempValRunning = false;
  var _valSaveLock = false;
  /** After validation COMPLETE, before Complete & Save — nav stays locked. */
  var _valAwaitingSave = null;
  /** Combined Stroke→Temp session for one beaker. */
  var _valSession = null;

  function clearValAwaitingSave() {
    _valAwaitingSave = null;
  }

  function clearValSession() {
    _valSession = null;
  }

  function setValAwaitingSave(kind, basket) {
    _valAwaitingSave = {
      kind: kind === 'temp' ? 'temp' : 'stroke',
      basket: basket === 2 ? 2 : 1,
    };
  }

  function valSessionActive() {
    return !!(_valSession && _valSession.basket);
  }

  window.dtIsValidationAwaitingSave = function () {
    return !!(_valAwaitingSave || (_valSession && (_valSession.tempDone || _valSession.phase === 'awaiting_due')));
  };

  window.dtIsValidationInProgress = function () {
    if (_valAwaitingSave) return false;
    if (_valSession && (_valSession.phase === 'stroke' || _valSession.phase === 'temp') && !_valSession.tempDone) {
      // Between stroke complete and temp start still counts as in-progress session
      if (_valPollTimer || _tempValRunning || _valKind) return true;
      if (_valSession.strokeDone && !_valSession.tempDone) return true;
    }
    return !!(!_valAwaitingSave && (_valPollTimer || _tempValRunning || _valKind));
  };

  window.dtValidationAwaitingSavePage = function () {
    if (_valAwaitingSave) {
      return _valAwaitingSave.kind === 'temp' ? 'temp-validation' : 'stroke-validation';
    }
    if (_valSession) {
      if (_valSession.tempDone || _valSession.phase === 'awaiting_due' || _valSession.phase === 'temp') {
        return 'temp-validation';
      }
      return 'stroke-validation';
    }
    return null;
  };

  /** True once a beaker test has actually started (motors running), not during preheat/ready. */
  function dtBasketTestStarted(basket) {
    return (DT.btnPhase[basket] || 'idle') === 'running';
  }

  function dtAnyBasketTestStarted() {
    return dtBasketTestStarted(1) || dtBasketTestStarted(2);
  }

  /** Preheat / ready / formal run session before motors — used for auto-logout & logout warn. */
  window.dtIsPreheatOrReadyActive = function () {
    for (var b = 1; b <= 2; b++) {
      if (DT.preheatInProgress[b]) return true;
      var phase = DT.btnPhase[b] || 'idle';
      if (phase === 'preheating' || phase === 'ready') return true;
      // Formal preheat session (home Preheat) before Start
      if (DT.running[b] && phase !== 'running') return true;
    }
    return false;
  };

  function syncDtNavLock() {
    // Nav locks only when the test has started, or validation/calibration is active.
    // Preheat (home or settings heater) must stay freely navigable.
    var locked = !!(
      dtAnyBasketTestStarted() ||
      _valPollTimer ||
      _tempValRunning ||
      _valKind ||
      _valAwaitingSave ||
      valSessionActive() ||
      DT.calSessionActive
    );
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

  /**
   * True while navigation should be guarded (abort-to-leave).
   * Preheat / ready do NOT count — only an actual started test, validation, or calibration.
   */
  window.dtIsOperationRunning = function () {
    if (dtAnyBasketTestStarted()) return true;
    if (_valPollTimer || _tempValRunning || _valKind || _valAwaitingSave || valSessionActive()) return true;
    if (DT.calSessionActive) return true;
    return false;
  };

  /** Pages that may stay open without aborting the current DT operation. */
  window.dtNavAllowedDuringOp = function (pageName) {
    pageName = String(pageName || '');
    if (pageName === 'report-preview' || pageName === 'approval-verify') return true;
    if (dtAnyBasketTestStarted()) {
      return pageName === 'home' || pageName === 'test-run';
    }
    if (_valAwaitingSave || valSessionActive()) {
      // Combined session may be on stroke or temp page
      if (_valSession) {
        if (_valSession.phase === 'stroke' && !_valSession.strokeDone) return pageName === 'stroke-validation';
        return pageName === 'temp-validation' || pageName === 'stroke-validation';
      }
      return pageName === (_valAwaitingSave.kind === 'temp' ? 'temp-validation' : 'stroke-validation');
    }
    if (_valPollTimer || _tempValRunning || _valKind) {
      if (_valKind === 'temp' || _tempValRunning) return pageName === 'temp-validation';
      return pageName === 'stroke-validation';
    }
    if (DT.calSessionActive) {
      return pageName === 'calibration-type-select' || pageName === 'calibrate-beaker';
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
    if (_valAwaitingSave) {
      clearValAwaitingSave();
    }
    if (_valSession) {
      clearValSession();
    }
    if (_valPollTimer || _tempValRunning || _valKind) {
      try { window.stopValidation({ stay: true, force: true, confirmed: true }); } catch (e) {}
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
            // Ready / Start is TR-driven only (Dr Reddy). Do not flip Start from IR setpoint alone.
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
    if (startBtn) {
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
    } else if (phase === 'preheating') {
      DT.preheatInProgress[basket] = true;
    } else {
      DT.preheatInProgress[basket] = false;
    }
    syncDtNavLock();
  }

  function markBasketReady(basket, reason) {
    basket = basket === 2 ? 2 : 1;
    // Formal preheat/run session only (ignore TR during settings-only heater)
    if (!DT.running[basket]) return;
    // Only while actively preheating (ignore stray TR when idle/running)
    if (DT.btnPhase[basket] !== 'preheating' && !DT.preheatInProgress[basket]) return;
    if (DT.btnPhase[basket] === 'running') return;
    if (DT.btnPhase[basket] === 'ready') return;
    setStartBtnPhase(basket, 'ready');
    onBasketReady(basket, reason || 'tr');
  }

  function maybeMarkReadyFromTemp(basket) {
    // Intentionally unused for Start arming — ESP TR is the ready signal.
    return;
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
    toast('Basket ' + basket + ' ready (TR) — press Start', 'success');
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

  function formatProductBatchLine(product, batch) {
    var name = String(product || '').trim();
    if (!name) return '';
    var b = String(batch || '').trim();
    if (b) return name + ' | Batch: ' + b;
    return name;
  }

  function updateProductNames() {
    var el = document.getElementById('dashboard-product-names');
    if (!el) return;
    var parts = [];
    // Always label the beaker so a single loaded recipe shows B1: / B2:
    if (DT.products[1]) {
      parts.push('B1: ' + formatProductBatchLine(DT.products[1], DT.batches[1]));
    }
    if (DT.products[2]) {
      parts.push('B2: ' + formatProductBatchLine(DT.products[2], DT.batches[2]));
    }
    el.textContent = parts.join('  |  ');
  }

  /** Clear loaded recipe / beaker setup so the next login starts with a blank dashboard. */
  window.dtResetSessionUi = function () {
    DT.loadCtx = null;
    DT.recipeDraft = null;
    DT.beakerPick = null;
    DT.beakerPickPurpose = null;
    DT.calSessionActive = false;
    DT.selectedBasket = 1;
    DT.pendingReportQueue = [];
    try { clearValAwaitingSave(); } catch (e0) {}
    try { clearValSession(); } catch (e0b) {}
    try { window.pendingRecipeToLoad = null; } catch (e) {}
    [1, 2].forEach(function (b) {
      DT.products[b] = null;
      DT.batches[b] = null;
      DT.fromRecipe[b] = false;
      DT.durations[b] = null;
      DT.media[b] = null;
      DT.mesh[b] = null;
      DT.modes[b] = 'manual';
      DT.setTemp[b] = 37.0;
      DT.heaterOn[b] = false;
      DT.heaterManual[b] = false;
      DT.running[b] = false;
      DT.preheatInProgress[b] = false;
      DT.btnPhase[b] = 'idle';
      stopRunPoll(b);
      var tEl = document.getElementById('timer' + b);
      if (tEl) tEl.textContent = '00:00:00';
      var container = document.getElementById('basket' + b + '-container');
      if (container) {
        var ring = container.querySelector('.basket-active-ring');
        if (ring) ring.remove();
        container.classList.remove('completed');
        container.querySelectorAll('.basket-hole').forEach(function (el) {
          el.classList.remove('completed');
        });
      }
      setStartBtnPhase(b, 'idle');
      updateModeButtonsUI(b);
      var setTempEl = document.getElementById('set-temp-' + b);
      if (setTempEl) setTempEl.value = '37.0';
    });
    updateProductNames();
    updateHeaterIndicators();
    syncDtNavLock();
    var banner = document.getElementById('dt-ready-banner');
    if (banner) banner.style.display = 'none';
    var arModal = document.getElementById('dt-ar-modal');
    if (arModal) arModal.style.display = 'none';
    var beakerModal = document.getElementById('dt-beaker-select-modal');
    if (beakerModal) beakerModal.style.display = 'none';
  };

  function updateHeaterIndicators() {
    [1, 2].forEach(function (b) {
      var el = document.getElementById('heater' + b);
      if (el) {
        var on = !!DT.heaterOn[b];
        el.classList.toggle('is-on', on);
        el.classList.toggle('is-off', !on);
        el.style.opacity = on ? '1' : '0.6';
        var span = el.querySelector('span');
        if (span) {
          span.textContent = on ? 'Heater On' : 'Heater Off';
          span.style.color = on ? '#f59e0b' : '#6b7280';
        }
      }
      syncHeaterControlUi(b);
    });
  }

  function syncHeaterControlUi(basket) {
    basket = basket === 2 ? 2 : 1;
    var on = !!DT.heaterOn[basket];
    var btn = document.getElementById('heater-control-btn-' + basket);
    var label = document.getElementById('control-text-' + basket);
    if (label) label.textContent = on ? 'Stop' : 'Start';
    if (btn) {
      btn.classList.toggle('btn-primary', !on);
      btn.classList.toggle('btn-danger', on);
      btn.classList.toggle('is-heater-stop', on);
    }
    var setTempEl = document.getElementById('set-temp-' + basket);
    if (setTempEl && DT.setTemp[basket] != null) {
      var cur = parseFloat(setTempEl.value);
      if (!(cur > 0) || Math.abs(cur - Number(DT.setTemp[basket])) > 0.05) {
        setTempEl.value = Number(DT.setTemp[basket]).toFixed(1);
      }
    }
  }

  function stopManualHeater(basket) {
    basket = basket === 2 ? 2 : 1;
    var t1 = 0;
    var t2 = 0;
    if (basket === 1) {
      t2 = (DT.configured[2] && DT.heaterOn[2]) ? Number(DT.setTemp[2] || 0) : 0;
    } else {
      t1 = (DT.configured[1] && DT.heaterOn[1]) ? Number(DT.setTemp[1] || 0) : 0;
    }
    return api('/api/hardware/dt/preheat', { method: 'POST', body: { t1: t1, t2: t2 } })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Heater stop failed');
        DT.heaterOn[basket] = false;
        DT.heaterManual[basket] = false;
        DT.preheatInProgress[basket] = false;
        setStartBtnPhase(basket, 'idle');
        updateHeaterIndicators();
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

    // Preheat in progress → confirm stop (settings heater or formal preheat)
    if (phase === 'preheating' || DT.preheatInProgress[basket]) {
      var doAbortPreheat = function () {
        // Settings-only heater (no formal test run) — stop via hardware PHW
        if (DT.heaterManual[basket] && !DT.running[basket]) {
          stopManualHeater(basket).then(function () {
            var tEl = document.getElementById('timer' + basket);
            if (tEl) tEl.textContent = '00:00:00';
            toast('Preheating stopped for basket ' + basket, 'info');
            go('home');
          }).catch(function (e) { toast(e.message || 'Failed to stop preheating', 'error'); });
          return;
        }
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

    // Ready (TR received) → Start. No recipe loaded → Quick Test for product/batch/mode/media/mesh.
    if (phase === 'ready') {
      DT.selectedBasket = basket;
      if (!DT.fromRecipe[basket] && !DT.products[basket]) {
        openQuickTestSetup(basket, { fromReady: true });
        return;
      }
      // Recipe already loaded — confirm then start motors
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

    // Idle → begin preheat (Quick Test opens later on Start if no recipe)
    beginPreheatFromSetup(basket);
  };

  function openQuickTestSetup(basket, opts) {
    opts = opts || {};
    basket = basket === 2 ? 2 : 1;
    DT._quickTestBasket = basket;
    DT.selectedBasket = basket;
    DT._qtFromReady = !!opts.fromReady;
    resetQuickTestForm();
    var titleEl = document.getElementById('dt-qt-title');
    var subEl = document.getElementById('dt-qt-subtitle');
    if (titleEl) titleEl.textContent = DT._qtFromReady ? 'Quick Test' : 'Quick Test';
    if (subEl) {
      subEl.textContent = DT._qtFromReady
        ? 'Basket ' + basket + ' is ready. Enter product, batch, mode, media and mesh, then start the test.'
        : 'Enter product, batch, mode, media and mesh to begin.';
    }
    var hint = document.getElementById('dt-qt-basket-hint');
    if (hint) {
      hint.textContent = 'Beaker ' + basket + ' — uses dashboard set temperature (' +
        Number(DT.setTemp[basket] || 37).toFixed(1) + ' °C).';
    }
    var startBtn = document.getElementById('dt-qt-start-btn');
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = DT._qtFromReady ? 'Start Test' : 'Start Preheat';
    }
    go('quick-test');
  }

  function resetQuickTestForm() {
    var nameEl = document.getElementById('dt-qt-name');
    var batchEl = document.getElementById('dt-qt-batch');
    var mediaEl = document.getElementById('dt-qt-media');
    var meshEl = document.getElementById('dt-qt-mesh');
    var durEl = document.getElementById('dt-qt-duration');
    if (nameEl) nameEl.value = '';
    if (batchEl) batchEl.value = '';
    if (mediaEl) mediaEl.value = '';
    if (meshEl) meshEl.value = '';
    if (durEl) durEl.value = '00:30:00';
    window.dtSelectQuickTestMode('manual');
  }

  window.dtSelectQuickTestMode = function (mode) {
    mode = mode === 'timer' ? 'timer' : 'manual';
    var hidden = document.getElementById('dt-qt-mode');
    if (hidden) hidden.value = mode;
    var man = document.getElementById('qt-mode-manual');
    var tim = document.getElementById('qt-mode-timer');
    var manRadio = document.getElementById('qt-mode-manual-radio');
    var timRadio = document.getElementById('qt-mode-timer-radio');
    if (man) man.classList.toggle('is-active', mode === 'manual');
    if (tim) tim.classList.toggle('is-active', mode === 'timer');
    if (manRadio) manRadio.checked = mode === 'manual';
    if (timRadio) timRadio.checked = mode === 'timer';
    var row = document.getElementById('dt-qt-duration-row');
    if (row) row.style.display = mode === 'timer' ? '' : 'none';
    var page = document.getElementById('page-quick-test');
    if (page) page.classList.toggle('is-timer-mode', mode === 'timer');
    var paramsHint = document.getElementById('dt-qt-params-hint');
    if (paramsHint) {
      paramsHint.textContent = mode === 'timer' ? 'Batch · duration · media · mesh' : 'Batch · media · mesh';
    }
  };

  window.dtToggleQtDuration = function () {
    var mode = (document.getElementById('dt-qt-mode') || {}).value || 'manual';
    window.dtSelectQuickTestMode(mode);
  };

  window.dtCancelQuickTest = function () {
    DT._quickTestBasket = null;
    DT._qtFromReady = false;
    go('home');
  };

  window.dtStartQuickRun = function () {
    var basket = DT._quickTestBasket === 2 ? 2 : (DT.selectedBasket === 2 ? 2 : 1);
    var fromReady = !!DT._qtFromReady ||
      DT.btnPhase[basket] === 'ready' ||
      (DT.running[basket] && DT.btnPhase[basket] !== 'running');
    var name = ((document.getElementById('dt-qt-name') || {}).value || '').trim();
    var batch = ((document.getElementById('dt-qt-batch') || {}).value || '').trim();
    var mode = ((document.getElementById('dt-qt-mode') || {}).value || 'manual');
    var media = ((document.getElementById('dt-qt-media') || {}).value || '').trim();
    var mesh = ((document.getElementById('dt-qt-mesh') || {}).value || '').trim();
    var durStr = ((document.getElementById('dt-qt-duration') || {}).value || '').trim();
    if (!name) {
      toast('Enter a product name', 'error');
      return;
    }
    if (!batch) {
      toast('Enter a batch number', 'error');
      return;
    }
    if (!media) {
      toast('Enter media', 'error');
      return;
    }
    if (!mesh) {
      toast('Enter mesh', 'error');
      return;
    }
    var duration = null;
    if (mode === 'timer') {
      duration = parseHHMMSS(durStr);
      if (!(duration > 0)) {
        toast('Enter a valid duration (HH:MM:SS) for timer mode', 'error');
        return;
      }
    }
    var temp = Number(DT.setTemp[basket] || 37);
    DT.products[basket] = name;
    DT.batches[basket] = batch;
    DT.fromRecipe[basket] = false;
    DT.modes[basket] = mode;
    DT.durations[basket] = duration;
    DT.media[basket] = media;
    DT.mesh[basket] = mesh;
    DT.configured[basket] = true;
    updateModeButtonsUI(basket);
    updateProductNames();
    updateBasketStates();

    var params = {
      productName: name,
      recipeName: name,
      setTemperature: temp,
      mode: mode,
      durationMinutes: duration,
      basketConfig: DT.basketConfig,
      batchNumber: batch,
      media: media,
      mesh: mesh,
    };
    DT._runParams = DT._runParams || {};
    DT._runParams[basket] = Object.assign({}, DT._runParams[basket] || {}, params);
    DT._quickTestBasket = null;

    var startBtn = document.getElementById('dt-qt-start-btn');
    if (startBtn) startBtn.disabled = true;

    var afterSetup = function () {
      if (typeof logAuditEvent === 'function') {
        try {
          logAuditEvent('Quick test started', name + ', batch ' + batch + ', beaker ' + basket, {
            eventType: 'lifecycle',
          });
        } catch (e) {}
      }
      DT._qtFromReady = false;
      DT.selectedBasket = basket;
      go('home');
      // Already at TR-ready / preheated — start motors now (no second confirm)
      window.dtConfirmStart();
    };

    // After TR → Start → Quick Test: patch setup onto the armed run, then start motors
    if (fromReady || DT.btnPhase[basket] === 'ready' || DT.btnPhase[basket] === 'preheating' || DT.running[basket]) {
      api('/api/data/dt/runs/' + basket + '/setup', {
        method: 'POST',
        body: {
          productName: name,
          batchNumber: batch,
          mode: mode,
          durationMinutes: duration,
          media: media,
          mesh: mesh,
          recipeName: name,
        },
      }).then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Failed to apply setup');
        afterSetup();
      }).catch(function (e) {
        if (startBtn) startBtn.disabled = false;
        toast(e.message || 'Failed to apply setup', 'error');
      });
      return;
    }

    // Opened from menu with no active preheat → start preheat first
    DT._qtFromReady = false;
    if (startBtn) startBtn.disabled = false;
    beginPreheatFromSetup(basket);
  };

  function beginPreheatFromSetup(basket) {
    basket = basket === 2 ? 2 : 1;
    var product = DT.products[basket] || ('Beaker ' + basket);
    var temp = Number(DT.setTemp[basket] || 37);
    var mode = DT.modes[basket] || 'manual';
    var dur = DT.durations[basket];
    // Idle preheat without recipe: use manual mode until Quick Test sets timer details on Start
    if (!DT.fromRecipe[basket] && !DT.products[basket]) {
      mode = 'manual';
      dur = null;
    } else if (mode === 'timer' && !(dur > 0)) {
      toast('Timer mode needs a duration — set duration on Quick Test or load a timer recipe', 'error');
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
      media: DT.media[basket],
      mesh: DT.mesh[basket],
    });
  }

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

  // DT load flow: Batch → Beaker → test dashboard (no AR number)
  window.loadRecipeById = function (id) {
    return api('/api/data/recipes/' + id).then(function (res) {
      var recipe = res.recipe || res;
      if (!recipe) { toast('Recipe not found', 'error'); return; }
      if (typeof getEffectiveRecipeApprovalStatus === 'function' &&
          getEffectiveRecipeApprovalStatus(recipe) === 'pending') {
        toast('This recipe is pending QA approval and cannot be loaded', 'error');
        return;
      }
      DT.loadCtx = { recipe: recipe, batch: '', beaker: null };
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
    if (typeof _closeModalOSK === 'function') {
      try { _closeModalOSK(); } catch (e) {}
    }
    // Go to test dashboard immediately, then pick beaker (no AR step)
    go('home');
    var recipeName = DT.loadCtx.recipe.productName || DT.loadCtx.recipe.name || 'Recipe';
    openBeakerSelect('load', 'Select beaker for “' + recipeName + '”');
  };

  // AR number removed for DT-CFR
  window.dtCloseArModal = function () {};
  window.dtConfirmArNumber = function () {};

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
      applyRecipeToDashboard(DT.loadCtx.recipe, DT.loadCtx.batch, pick);
      DT.loadCtx = null;
      window.pendingRecipeToLoad = null;
      go('home');
      toast('Recipe loaded — press Start on the selected basket', 'success');
    }
  };

  function applyRecipeToDashboard(recipe, batch, beakerPick) {
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
      DT.fromRecipe[b] = true;
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
        logAuditEvent('Loaded recipe', product + ', batch ' + (batch || '--'), {
          eventType: 'lifecycle',
        });
      } catch (e) {}
    }
  }

  window.dtRunRecipe = function (recipe) {
    if (!recipe) return;
    DT.loadCtx = { recipe: recipe, batch: '', beaker: null };
    window.pendingRecipeToLoad = recipe;
    var title = document.getElementById('batch-modal-title');
    if (title) title.textContent = 'Enter Batch Number';
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
    DT.heaterManual[basket] = false;
    DT.preheatInProgress[basket] = false;
    if (DT._confirmPending) DT._confirmPending[basket] = false;
    stopRunPoll(basket);
    syncDtNavLock();
    setStartBtnPhase(basket, 'idle');
    // Clear quick-test setup so the next Start after preheat (no recipe) opens Quick Test again.
    // Recipe-loaded product stays until another recipe is loaded.
    if (!DT.fromRecipe || !DT.fromRecipe[basket]) {
      DT.products[basket] = null;
      DT.batches[basket] = null;
      DT.media[basket] = null;
      DT.mesh[basket] = null;
      DT.durations[basket] = null;
      updateProductNames();
    }
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
    DT.running[basket] = true; // formal preheat/run session (nav locks only once motors start)
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
        media: params.media,
        mesh: params.mesh,
      },
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'Preheat failed');
      toast('Preheating basket ' + basket + '…', 'info');
      DT.heaterOn[basket] = true;
      DT.heaterManual[basket] = false;
      updateHeaterIndicators();
      startRunPoll(basket);
    }).catch(function (e) {
      DT.running[basket] = false;
      DT.heaterOn[basket] = false;
      DT.heaterManual[basket] = false;
      setStartBtnPhase(basket, 'idle');
      updateHeaterIndicators();
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

  function basketFromResponse(res, fallback) {
    var run = (res && res.run) || {};
    var report = (res && (res.savedReport || res.report)) || {};
    var b = run.basket != null ? run.basket : (report.basket != null ? report.basket : report.beaker);
    b = parseInt(b, 10);
    if (b === 1 || b === 2) return b;
    b = parseInt(fallback, 10);
    return (b === 1 || b === 2) ? b : 1;
  }

  /**
   * True only if the sibling basket's test has actually started (motors running).
   * Preheat / ready on the other beaker must NOT block opening this basket's report.
   */
  function siblingBasketStillActive(basket) {
    var other = basket === 2 ? 1 : 2;
    return (DT.btnPhase[other] || 'idle') === 'running';
  }

  function enqueuePendingReport(reportId) {
    if (reportId == null) return;
    DT.pendingReportQueue = DT.pendingReportQueue || [];
    var id = reportId;
    for (var i = 0; i < DT.pendingReportQueue.length; i++) {
      if (String(DT.pendingReportQueue[i]) === String(id)) return;
    }
    DT.pendingReportQueue.push(id);
  }

  /** Open the next queued pending report for approval. Returns true if one was opened. */
  window.dtOpenNextPendingReport = function () {
    DT.pendingReportQueue = DT.pendingReportQueue || [];
    while (DT.pendingReportQueue.length) {
      var rid = DT.pendingReportQueue.shift();
      if (rid == null) continue;
      if (typeof openReportPreview === 'function') {
        try {
          openReportPreview(rid, { setGate: true });
          return true;
        } catch (e) {}
      }
    }
    return false;
  };

  window.dtHasPendingReports = function () {
    return !!(DT.pendingReportQueue && DT.pendingReportQueue.length);
  };

  function openPendingTestReport(res, opts) {
    opts = opts || {};
    var basket = basketFromResponse(res, opts.basket);
    var siblingActive = siblingBasketStillActive(basket);

    if (opts.aborted) {
      // Aborted reports stay closed, but if the sibling just finished waiting, open its queue.
      if (!siblingActive && DT.pendingReportQueue && DT.pendingReportQueue.length) {
        if (window.dtOpenNextPendingReport()) return;
      }
      go('home');
      return;
    }

    var rid = reportIdFromResponse(res);
    if (rid == null) {
      if (!siblingActive && DT.pendingReportQueue && DT.pendingReportQueue.length) {
        if (window.dtOpenNextPendingReport()) return;
      }
      go('home');
      if (typeof loadReports === 'function') {
        try { loadReports(); } catch (e2) {}
      }
      return;
    }

    enqueuePendingReport(rid);

    if (siblingActive) {
      toast('Basket ' + basket + ' complete — report opens when the other running test finishes', 'info');
      go('home');
      return;
    }

    // Both idle: open oldest queued report (leave any remaining for after approval).
    if (window.dtOpenNextPendingReport()) return;
    go('home');
    if (typeof loadReports === 'function') {
      try { loadReports(); } catch (e3) {}
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
          openPendingTestReport(res, { aborted: !!run.aborted, basket: basket });
        } else if (run.state === 'IDLE' && DT.running[basket]) {
          // Server cleared the run after auto-save; treat as finished.
          finishBasketUi(basket);
          openPendingTestReport(res, { aborted: false, basket: basket });
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
    var basket = DT.selectedBasket === 2 ? 2 : 1;
    DT.selectedBasket = basket;

    var applyStartedUi = function () {
      if (DT._confirmPending) DT._confirmPending[basket] = false;
      DT.running[basket] = true;
      DT.heaterManual[basket] = false;
      DT.heaterOn[basket] = true;
      setStartBtnPhase(basket, 'running');
      updateHeaterIndicators();
      toast('Test started', 'success');
      var banner = document.getElementById('dt-ready-banner');
      if (banner) banner.style.display = 'none';
      var btn = document.getElementById('dt-confirm-btn');
      if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }
      startRunPoll(basket);
    };

    var failStart = function (e) {
      if (DT._confirmPending) DT._confirmPending[basket] = false;
      // Keep Start available if we were in ready; otherwise leave phase alone
      if (DT.btnPhase[basket] === 'running') setStartBtnPhase(basket, 'ready');
      else if (DT.btnPhase[basket] !== 'ready') setStartBtnPhase(basket, 'ready');
      toast((e && e.message) || 'Start failed', 'error');
    };

    var doConfirm = function () {
      return api('/api/data/dt/runs/' + basket + '/confirm', { method: 'POST', body: {} })
        .then(function (res) {
          if (!res.ok) throw new Error(res.error || 'Start failed');
          applyStartedUi();
          return res;
        });
    };

    // Ensure a formal run exists (Dr Reddy always START after armed preheat; CFR needs PREHEAT/AWAIT).
    api('/api/data/dt/runs/' + basket)
      .then(function (res) {
        var state = String(((res && res.run) || {}).state || '').toUpperCase();
        if (state === 'PREHEAT' || state === 'READY' || state === 'AWAIT_CONFIRM') {
          return doConfirm();
        }
        var params = (DT._runParams && DT._runParams[basket]) || {};
        var mode = params.mode || DT.modes[basket] || 'manual';
        var dur = params.durationMinutes != null ? params.durationMinutes : DT.durations[basket];
        if (mode === 'timer' && !(Number(dur) > 0)) {
          mode = 'manual';
          dur = null;
        }
        var body = {
          setTemperature: params.setTemperature != null ? params.setTemperature : DT.setTemp[basket],
          mode: mode,
          durationMinutes: dur,
          basketConfig: params.basketConfig || DT.basketConfig || 6,
          productName: params.productName || DT.products[basket] || ('Beaker ' + basket),
          batchNumber: params.batchNumber || DT.batches[basket] || '',
          recipeName: params.recipeName || params.productName || DT.products[basket] || '',
          media: params.media != null ? params.media : DT.media[basket],
          mesh: params.mesh != null ? params.mesh : DT.mesh[basket],
        };
        return api('/api/data/dt/runs/' + basket + '/preheat', { method: 'POST', body: body })
          .then(function (pres) {
            if (!pres.ok) throw new Error(pres.error || 'Could not arm basket for start');
            DT.running[basket] = true;
            DT.heaterManual[basket] = false;
            DT.heaterOn[basket] = true;
            DT._runParams = DT._runParams || {};
            DT._runParams[basket] = Object.assign({}, params, {
              setTemperature: body.setTemperature,
              mode: body.mode,
              durationMinutes: body.durationMinutes,
              productName: body.productName,
              batchNumber: body.batchNumber,
            });
            updateHeaterIndicators();
            return doConfirm();
          });
      })
      .catch(failStart);
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
          openPendingTestReport(res, { aborted: aborted, basket: basket });
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
      openPendingTestReport(res, { aborted: !!aborted, basket: basket });
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
    if (typeof userCanRunValidation === 'function' && !userCanRunValidation()) {
      if (typeof denyPermission === 'function') denyPermission('run validation');
      return;
    }
    _valBasket = beakerId === 2 ? 2 : 1;
    var hidden = document.getElementById('dt-val-basket');
    if (hidden) hidden.value = String(_valBasket);
    var numEl = document.getElementById('val-beaker-num');
    if (numEl) numEl.textContent = String(_valBasket);
    // Fixed flow: Beaker → Stroke → Temp → combined report
    beginCombinedValidationSession(_valBasket);
  };

  window.updateValidationSelection = function () {
    var selected = document.querySelector('input[name="val-type"]:checked');
    var stroke = document.getElementById('val-stroke');
    var temp = document.getElementById('val-temp');
    if (stroke) stroke.classList.toggle('selected', !!(selected && selected.value === 'stroke'));
    if (temp) temp.classList.toggle('selected', !!(selected && selected.value === 'temp'));
  };

  function beginCombinedValidationSession(basket) {
    basket = basket === 2 ? 2 : 1;
    clearValAwaitingSave();
    _valSession = {
      basket: basket,
      phase: 'stroke',
      strokeDone: false,
      tempDone: false,
      strokeSnapshot: null,
    };
    resetStrokeValidationUi(basket);
    syncDtNavLock();
    go('stroke-validation');
  }

  window.startValidationProcess = function () {
    // Legacy type-select Start — still begins combined Stroke→Temp for selected beaker
    if (typeof userCanRunValidation === 'function' && !userCanRunValidation()) {
      if (typeof denyPermission === 'function') denyPermission('run validation');
      return;
    }
    beginCombinedValidationSession(currentValBasket());
  };

  function resetTempValidationUi(basket) {
    basket = basket === 2 ? 2 : 1;
    var tempBeaker = document.getElementById('temp-beaker');
    if (tempBeaker) tempBeaker.textContent = String(basket);
    _tempValRunning = false;
    _valKind = null;
    var msg = document.getElementById('validation-message');
    var st = document.getElementById('validation-status');
    if (msg) msg.textContent = 'Ready to Validate';
    if (st) st.textContent = '-';
    var completeTemp = document.getElementById('complete-temp-validation-btn');
    if (completeTemp) completeTemp.style.display = 'none';
    var startLbl = document.getElementById('validation-stop-btn-text');
    if (startLbl) startLbl.textContent = 'START';
    var elapsed = document.getElementById('temp-validation-elapsed');
    if (elapsed) elapsed.textContent = '02:00';
    var card = document.getElementById('validation-result-card');
    if (card) {
      card.classList.remove('is-pass', 'is-fail');
    }
  }

  function advanceToTempAfterStroke(strokeSession) {
    var basket = currentValBasket();
    var snap = {
      status: strokeSession.status,
      strokesPerMin: strokeSession.strokesPerMin,
      pulsesSeen: strokeSession.pulsesSeen,
      actualStrokes: strokeSession.pulsesSeen != null ? strokeSession.pulsesSeen : strokeSession.strokesPerMin,
      requiredRange: strokeSession.requiredRange || '29-32',
      requiredMin: strokeSession.requiredMin,
      requiredMax: strokeSession.requiredMax,
      durationSec: strokeSession.durationSec || 60,
      sensorSilent: strokeSession.sensorSilent,
      error: strokeSession.error,
      operatorName: strokeSession.operatorName,
      operatorId: strokeSession.operatorId,
      operatorUsername: strokeSession.operatorUsername,
      mock: strokeSession.mock,
      completedAt: strokeSession.endedAt || strokeSession.completedAt,
      testStartTime: strokeSession.startedAt,
      testEndTime: strokeSession.endedAt,
      beaker: basket,
      basket: basket,
      validationSubtype: 'stroke',
    };
    if (!_valSession) {
      _valSession = { basket: basket, phase: 'temp', strokeDone: true, tempDone: false, strokeSnapshot: snap };
    } else {
      _valSession.strokeDone = true;
      _valSession.phase = 'temp';
      _valSession.strokeSnapshot = snap;
      _valSession.tempDone = false;
    }
    clearValAwaitingSave();
    resetTempValidationUi(basket);
    syncDtNavLock();
    toast('Stroke done — continue with temperature validation', 'success');
    go('temp-validation');
  }

  function resetStrokeValidationUi(basket) {
    basket = basket === 2 ? 2 : 1;
    _valSaveLock = false;
    clearValAwaitingSave();
    var strokeBeaker = document.getElementById('stroke-beaker');
    if (strokeBeaker) strokeBeaker.textContent = String(basket);
    var counter = document.getElementById('stroke-counter');
    if (counter) counter.textContent = '0';
    var timer = document.getElementById('stroke-timer');
    if (timer) timer.textContent = '01:00';
    var statusCard = document.getElementById('stroke-validation-status-card');
    if (statusCard) statusCard.style.display = 'none';
    var stopBtn = document.getElementById('stroke-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
    setStrokePrimaryBtn('start');
    syncDtNavLock();
  }

  function setStrokePrimaryBtn(mode) {
    var btn = document.getElementById('stroke-complete-btn');
    if (!btn) return;
    btn.disabled = false;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    if (mode === 'start') {
      btn.textContent = 'Start';
      btn.dataset.mode = 'start';
    } else if (mode === 'running') {
      btn.textContent = 'Running…';
      btn.disabled = true;
      btn.style.opacity = '0.55';
      btn.style.cursor = 'not-allowed';
      btn.dataset.mode = 'running';
    } else if (mode === 'save') {
      btn.textContent = 'Complete & Save';
      btn.dataset.mode = 'save';
    }
  }

  window.dtStrokePrimaryAction = function () {
    var btn = document.getElementById('stroke-complete-btn');
    var mode = (btn && btn.dataset.mode) || 'start';
    if (mode === 'save') {
      window.completeValidation('stroke');
      return;
    }
    if (mode === 'running') return;
    window.dtStartStrokeValidation();
  };

  window.dtStartStrokeValidation = function () {
    var basket = currentValBasket();
    clearValPoll();
    clearValAwaitingSave();
    setStrokePrimaryBtn('running');
    var stopBtn = document.getElementById('stroke-stop-btn');
    if (stopBtn) stopBtn.style.display = '';
    var timer = document.getElementById('stroke-timer');
    if (timer) timer.textContent = '01:00';
    var counter = document.getElementById('stroke-counter');
    if (counter) counter.textContent = '0';
    api('/api/data/dt/validation/stroke/' + basket + '/start', { method: 'POST', body: {} })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Start failed');
        pollValidation('stroke', basket);
      })
      .catch(function (e) {
        setStrokePrimaryBtn('start');
        if (stopBtn) stopBtn.style.display = 'none';
        toast(e.message || 'Failed', 'error');
      });
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
    clearValAwaitingSave();
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
    var basket = currentValBasket();
    var kind = _valKind || (_valAwaitingSave && _valAwaitingSave.kind) ||
      (_valSession && _valSession.phase === 'temp' ? 'temp' : null) ||
      (_valSession && _valSession.phase === 'stroke' ? 'stroke' : null);

    // Finished validation waiting for Complete & Save / due modal — cannot leave yet
    if ((_valAwaitingSave || (_valSession && _valSession.tempDone)) && !opts.force) {
      if (typeof showAppModal === 'function') {
        showAppModal(
          'Hit Complete & Save and approve the report to exit this page.',
          'Validation'
        );
      } else {
        toast('Hit Complete & Save and approve the report to exit', 'info');
      }
      return;
    }

    // Stroke done, waiting to start/finish temp — treat as in-progress session
    var sessionBetween = !!(!_valAwaitingSave && _valSession && _valSession.strokeDone && !_valSession.tempDone);
    var wasRunning = !!(kind || _tempValRunning || _valPollTimer || sessionBetween || valSessionActive());

    // Idle — leave without abort popup / without killing HW
    if (!wasRunning) {
      clearValPoll();
      _tempValRunning = false;
      _valKind = null;
      clearValAwaitingSave();
      clearValSession();
      syncDtNavLock();
      if (!opts.stay) {
        try { _suppressDtOpNavGuardOnce = true; } catch (e) {}
        go('validate-beaker');
      }
      return;
    }

    // Running validation — confirm abort (same pattern as active test)
    if (!opts.confirmed && !opts.force) {
      var doConfirm = typeof showConfirmModal === 'function'
        ? showConfirmModal(
            'Validation is in progress. Do you want to abort and exit?',
            'Operation in progress'
          )
        : Promise.resolve(true);
      Promise.resolve(doConfirm).then(function (ok) {
        if (!ok) return;
        window.stopValidation(Object.assign({}, opts, { confirmed: true, force: true }));
      });
      return;
    }

    clearValPoll();
    var strokeSnap = (_valSession && _valSession.strokeSnapshot) || null;
    var phase = 'stroke';
    if (kind === 'temp' || _tempValRunning) {
      phase = 'temp';
    } else if (sessionBetween || (_valSession && _valSession.strokeDone && !_valSession.tempDone)) {
      phase = 'between';
    } else if (kind === 'stroke' || (_valSession && _valSession.phase === 'stroke')) {
      phase = 'stroke';
    }
    _tempValRunning = false;
    _valKind = null;
    _valSaveLock = false;
    clearValAwaitingSave();
    clearValSession();
    closeValidationDueModal();
    syncDtNavLock();
    var startLbl = document.getElementById('validation-stop-btn-text');
    if (startLbl) startLbl.textContent = 'START';
    var stopBtn = document.getElementById('stroke-stop-btn');
    if (stopBtn) stopBtn.style.display = 'none';
    setStrokePrimaryBtn('start');
    var timer = document.getElementById('stroke-timer');
    if (timer) timer.textContent = '01:00';
    var completeTemp = document.getElementById('complete-temp-validation-btn');
    if (completeTemp) completeTemp.style.display = 'none';

    var openPreview = opts.openPreview !== false && !opts.stay;
    saveAbortedCombinedValidationReport({
      basket: basket,
      phase: phase,
      stroke: strokeSnap,
      openPreview: openPreview,
      stay: !!opts.stay,
    });
  };

  var _valAbortSaveLock = false;
  function saveAbortedCombinedValidationReport(opts) {
    opts = opts || {};
    if (_valAbortSaveLock) return Promise.resolve(null);
    _valAbortSaveLock = true;
    var basket = opts.basket === 2 ? 2 : 1;
    var strokeSnap = opts.stroke != null
      ? opts.stroke
      : ((_valSession && _valSession.strokeSnapshot) || null);
    var phase = opts.phase || 'stroke';
    var openPreview = opts.openPreview !== false && !opts.stay;
    clearValAwaitingSave();
    clearValSession();
    syncDtNavLock();
    return api('/api/data/dt/validation/' + basket + '/combined/abort', {
      method: 'POST',
      body: {
        stroke: strokeSnap,
        phase: phase,
      },
    })
      .then(function (res) {
        _valAbortSaveLock = false;
        if (!res.ok) throw new Error(res.error || 'Abort save failed');
        toast('Validation aborted — report pending approval', 'info');
        var report = res.report || {};
        var rid = report.id;
        if (openPreview && rid && typeof openReportPreview === 'function') {
          openReportPreview(rid, { setGate: true });
          return res;
        }
        if (!opts.stay) {
          try { _suppressDtOpNavGuardOnce = true; } catch (e) {}
          go('validate-beaker');
        }
        return res;
      })
      .catch(function (e) {
        _valAbortSaveLock = false;
        toast(e.message || 'Validation aborted (report not saved)', 'error');
        if (!opts.stay) {
          try { _suppressDtOpNavGuardOnce = true; } catch (e2) {}
          go('validate-beaker');
        }
        return null;
      });
  }

  function saveValidationAndPreview(kind, basket, opts) {
    opts = opts || {};
    if (_valSaveLock) return Promise.resolve(null);
    // Combined Stroke→Temp: open due-interval modal instead of single-kind save
    if (_valSession && _valSession.strokeDone && _valSession.tempDone) {
      openValidationDueModal(basket);
      return Promise.resolve(null);
    }
    _valSaveLock = true;
    return api('/api/data/dt/validation/' + kind + '/' + basket + '/save', { method: 'POST', body: {} })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Save failed');
        toast('Validation report saved (pending approval)', 'success');
        _tempValRunning = false;
        _valKind = null;
        clearValAwaitingSave();
        clearValSession();
        syncDtNavLock();
        var report = res.report || {};
        var rid = report.id;
        if (rid && typeof openReportPreview === 'function') {
          openReportPreview(rid, { setGate: true });
        } else {
          try { _suppressDtOpNavGuardOnce = true; } catch (e) {}
          go('reports');
          if (typeof loadReports === 'function') loadReports();
        }
        return res;
      })
      .catch(function (e) {
        _valSaveLock = false;
        toast(e.message || 'Save failed', 'error');
        throw e;
      });
  }

  function formatLocalDdMmYyyy(d) {
    var dt = d instanceof Date ? d : new Date();
    var dd = String(dt.getDate()).padStart(2, '0');
    var mm = String(dt.getMonth() + 1).padStart(2, '0');
    var yy = dt.getFullYear();
    return dd + '-' + mm + '-' + yy;
  }

  function addMonthsDdMmYyyy(baseDate, months) {
    var d = baseDate instanceof Date ? new Date(baseDate.getTime()) : new Date();
    var m = parseInt(months, 10) || 12;
    var year = d.getFullYear();
    var month = d.getMonth() + m;
    year += Math.floor(month / 12);
    month = ((month % 12) + 12) % 12;
    var day = d.getDate();
    var lastDay = new Date(year, month + 1, 0).getDate();
    if (day > lastDay) day = lastDay;
    return formatLocalDdMmYyyy(new Date(year, month, day));
  }

  function openValidationDueModal(basket) {
    var overlay = document.getElementById('validation-due-modal-overlay');
    if (!overlay) {
      toast('Due-date modal missing', 'error');
      return;
    }
    overlay.dataset.basket = String(basket === 2 ? 2 : 1);
    overlay.style.display = 'flex';
    syncDtNavLock();
  }

  function closeValidationDueModal() {
    var overlay = document.getElementById('validation-due-modal-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  window.cancelValidationDueModal = function () {
    closeValidationDueModal();
  };

  window.selectValidationDueMonths = function (months) {
    var m = parseInt(months, 10);
    if (m !== 3 && m !== 6 && m !== 12) {
      toast('Choose 3, 6, or 12 months', 'error');
      return;
    }
    var overlay = document.getElementById('validation-due-modal-overlay');
    var basket = parseInt((overlay && overlay.dataset.basket) || String(currentValBasket()), 10);
    basket = basket === 2 ? 2 : 1;
    closeValidationDueModal();
    saveCombinedValidationReport(basket, m);
  };

  function saveCombinedValidationReport(basket, months) {
    if (_valSaveLock) return;
    _valSaveLock = true;
    var today = new Date();
    var last = formatLocalDdMmYyyy(today);
    var next = addMonthsDdMmYyyy(today, months);
    var strokeSnap = (_valSession && _valSession.strokeSnapshot) || null;
    var body = {
      stroke: strokeSnap,
      pendingValidationDue: {
        months: months,
        lastValidationDate: last,
        nextValidationDate: next,
        dueKind: 'validation',
        beaker: basket,
      },
    };
    api('/api/data/dt/validation/' + basket + '/combined/save', { method: 'POST', body: body })
      .then(function (res) {
        if (!res.ok) throw new Error(res.error || 'Save failed');
        toast('Validation report saved (pending approval)', 'success');
        _tempValRunning = false;
        _valKind = null;
        _valSaveLock = false;
        clearValAwaitingSave();
        clearValSession();
        syncDtNavLock();
        var completeTemp = document.getElementById('complete-temp-validation-btn');
        if (completeTemp) completeTemp.style.display = 'none';
        var report = res.report || {};
        var rid = report.id;
        if (rid && typeof openReportPreview === 'function') {
          openReportPreview(rid, { setGate: true });
        } else {
          try { _suppressDtOpNavGuardOnce = true; } catch (e) {}
          go('reports');
          if (typeof loadReports === 'function') loadReports();
        }
        return res;
      })
      .catch(function (e) {
        _valSaveLock = false;
        toast(e.message || 'Save failed', 'error');
      });
  }

  window.exitTempValidation = function () {
    window.stopValidation();
  };

  window.completeValidation = function (kind) {
    kind = kind === 'temp' ? 'temp' : 'stroke';
    var basket = currentValBasket();
    clearValPoll();
    _valSaveLock = false;
    // Combined session after both done → due modal
    if (_valSession && _valSession.strokeDone && (kind === 'temp' || _valSession.tempDone)) {
      if (!_valSession.tempDone) _valSession.tempDone = true;
      _valSession.phase = 'awaiting_due';
      setValAwaitingSave('temp', basket);
      syncDtNavLock();
      openValidationDueModal(basket);
      return;
    }
    saveValidationAndPreview(kind, basket, {});
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
          var liveCount = s.pulsesSeen != null ? s.pulsesSeen
            : (s.strokesPerMin != null ? s.strokesPerMin : null);
          if (counter && liveCount != null) counter.textContent = String(liveCount);
          var rem = s.remainingSec;
          // During travel-to-start (STARTING), keep full 60s on the timer.
          if (s.state === 'STARTING') {
            rem = s.durationSec != null ? s.durationSec : 60;
          } else if (rem == null && s.state === 'RUNNING' && s.startedAtEpoch && s.durationSec) {
            rem = Math.max(0, Number(s.durationSec) - ((Date.now() / 1000) - Number(s.startedAtEpoch)));
          }
          if (s.state === 'COMPLETE' || s.state === 'ABORTED') rem = 0;
          if (rem != null) {
            var timerEl = document.getElementById('stroke-timer');
            if (timerEl) timerEl.textContent = formatHoldRemaining(rem);
          }
          if (s.state === 'COMPLETE' || s.state === 'ABORTED') {
            clearValPoll();
            var wasAborted = s.state === 'ABORTED';
            _valKind = null;
            if (wasAborted) {
              var stopBtnA = document.getElementById('stroke-stop-btn');
              if (stopBtnA) stopBtnA.style.display = 'none';
              var cardA = document.getElementById('stroke-validation-status-card');
              var textA = document.getElementById('stroke-validation-status-text');
              if (cardA) {
                cardA.style.display = '';
                cardA.className = 'dt-val-status-card is-fail';
              }
              if (textA) textA.textContent = 'VALIDATION ABORTED';
              setStrokePrimaryBtn('start');
              // Persist aborted report for approval (operator abort via Stop already does this;
              // this covers HW/session abort while still on the page).
              saveAbortedCombinedValidationReport({ basket: basket, phase: 'stroke', openPreview: true });
            } else {
              // Combined flow: stash stroke and continue to temperature
              var stopBtn = document.getElementById('stroke-stop-btn');
              if (stopBtn) stopBtn.style.display = 'none';
              var card = document.getElementById('stroke-validation-status-card');
              var text = document.getElementById('stroke-validation-status-text');
              var finalCount = s.pulsesSeen != null ? s.pulsesSeen
                : (s.strokesPerMin != null ? s.strokesPerMin : null);
              if (counter && finalCount != null) counter.textContent = String(finalCount);
              if (card) {
                card.style.display = '';
                card.className = 'dt-val-status-card ' + (s.status === 'PASSED' ? 'is-pass' : 'is-fail');
              }
              if (text) {
                var countLabel = finalCount != null ? (' (' + finalCount + ' strokes)' ) : '';
                text.textContent = ((s.status === 'PASSED' ? 'VALIDATION PASSED' : 'VALIDATION FAILED') + countLabel);
              }
              setStrokePrimaryBtn('running');
              advanceToTempAfterStroke(s);
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
            var tempAborted = s.state === 'ABORTED';
            _valKind = null;
            if (tempAborted) {
              var startLblA = document.getElementById('validation-stop-btn-text');
              if (startLblA) startLblA.textContent = 'START';
              var msgA = document.getElementById('validation-message');
              var stA = document.getElementById('validation-status');
              if (msgA) msgA.textContent = 'Aborted';
              if (stA) stA.textContent = s.status || '-';
              saveAbortedCombinedValidationReport({ basket: basket, phase: 'temp', openPreview: true });
            } else {
              if (_valSession) {
                _valSession.tempDone = true;
                _valSession.phase = 'awaiting_due';
              }
              setValAwaitingSave('temp', basket);
              syncDtNavLock();
              var startLbl = document.getElementById('validation-stop-btn-text');
              if (startLbl) startLbl.textContent = 'START';
              var msg = document.getElementById('validation-message');
              var st = document.getElementById('validation-status');
              if (msg) msg.textContent = 'Hold complete';
              if (st) st.textContent = s.status || '-';
              var completeTemp = document.getElementById('complete-temp-validation-btn');
              if (completeTemp) {
                completeTemp.style.display = '';
                toast('Validation finished — press Complete & Save', 'success');
              }
            }
          }
        }
      }).catch(function () {});
    }, 1000);
  }

  // -------------------- Calibration --------------------

  window.selectBeakerForCalibration = function (beakerId) {
    var pick = beakerId === 2 ? 2 : 1;
    if (!DT.configured[pick]) {
      toast('Configure beaker ' + pick + ' in Settings → Add Beakers', 'error');
      return;
    }
    DT.calBeaker = pick;
    DT.calSessionActive = true;
    syncDtNavLock();
    var numEl = document.getElementById('calibration-beaker-num');
    if (numEl) numEl.textContent = String(DT.calBeaker);
    var sensor = document.getElementById('dt-cal-sensor');
    if (sensor) sensor.value = DT.calBeaker === 2 ? 'IR2' : 'IR1';
    updateTempDisplay(DT.latestTemps || {});
    go('calibration-type-select');
  };

  window.dtClearCalibrationSession = function () {
    DT.calSessionActive = false;
    syncDtNavLock();
  };

  window.dtOpenCalibrationBeakerSelect = function () {
    // Prefer dedicated page (Validate → Calibrate flow); keep modal only as fallback.
    if (typeof goToPage === 'function') {
      goToPage('calibrate-beaker');
      return;
    }
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
    basket = basket === 2 ? 2 : 1;
    if (!DT.configured[basket]) {
      toast('Configure beaker ' + basket + ' in Settings → Add Beakers', 'error');
      return;
    }
    // If a full test run is active on this basket, do not use settings heater toggle
    if (DT.running[basket] && !DT.heaterManual[basket] &&
        (DT.btnPhase[basket] === 'running' || DT.btnPhase[basket] === 'ready')) {
      toast('Stop the active test on beaker ' + basket + ' first', 'error');
      return;
    }

    var turningOn = !DT.heaterOn[basket];
    var input = document.getElementById('set-temp-' + basket);
    var setTempVal = parseFloat(input && input.value) || DT.setTemp[basket] || 37;
    DT.setTemp[basket] = setTempVal;
    if (typeof updateDashboardTempButton === 'function') updateDashboardTempButton();

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
        if (turningOn) {
          DT.heaterManual[basket] = true;
          // Mirror settings heater onto home dashboard (Preheating + Heater On).
          // Manual heat does not create a formal run — TR will not arm Start until
          // dashboard Preheat is used (or this session is upgraded by Preheat).
          if (!DT.running[basket] || DT.heaterManual[basket]) {
            if (DT.btnPhase[basket] !== 'running' && DT.btnPhase[basket] !== 'ready') {
              setStartBtnPhase(basket, 'preheating');
            }
          }
        } else {
          // Turning off from settings — stop formal preheat run if active, else clear manual heat
          if (DT.running[basket] && !DT.heaterManual[basket] &&
              (DT.btnPhase[basket] === 'preheating' || DT.preheatInProgress[basket] || DT.btnPhase[basket] === 'ready')) {
            api('/api/data/dt/runs/' + basket + '/stop', {
              method: 'POST',
              body: { aborted: true, reason: 'preheat_abort' },
            }).then(function () {
              finishBasketUi(basket);
              updateHeaterIndicators();
            }).catch(function () {
              DT.heaterManual[basket] = false;
              finishBasketUi(basket);
              updateHeaterIndicators();
            });
            toast('Heater ' + basket + ' OFF', 'success');
            return;
          }
          DT.heaterManual[basket] = false;
          DT.preheatInProgress[basket] = false;
          if (!DT.running[basket] && DT.btnPhase[basket] !== 'running') {
            setStartBtnPhase(basket, 'idle');
          }
        }
        updateHeaterIndicators();
        toast('Heater ' + basket + (turningOn ? ' ON' : ' OFF'), 'success');
      })
      .catch(function (e) { toast(e.message || 'Heater failed', 'error'); });
  };

  // Keep quick-test helpers for compatibility
  window.startQuickTest = function () {
    ensureSse();
    var basket = DT.selectedBasket === 2 ? 2 : 1;
    if (!DT.configured[basket]) {
      basket = DT.configured[1] ? 1 : (DT.configured[2] ? 2 : 1);
    }
    openQuickTestSetup(basket);
  };

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

  // Refresh dashboard / heater UI when returning home or opening heater settings
  var _origGoToPage = window.goToPage;
  if (typeof _origGoToPage === 'function') {
    window.goToPage = function (pageName) {
      var r = _origGoToPage.apply(this, arguments);
      var p = String(pageName || '');
      if (p === 'home' || p === 'page-home') {
        setTimeout(refreshDashboard, 50);
      } else if (p === 'heater-control' || p === 'page-heater-control') {
        setTimeout(function () {
          updateHeaterIndicators();
          syncHeaterControlUi(1);
          syncHeaterControlUi(2);
        }, 50);
      }
      return r;
    };
  }

  window.DTClient = DT;
})();
