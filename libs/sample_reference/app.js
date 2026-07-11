   /*
 * app.js - The kiosk UI logic that makes this thing actually work
 * 
 * This is where the UI pretends to be smart and talks to the real hardware.
 * It handles all the user interactions, state management, and the fun stuff
 * like printing and exporting reports.
 * 
 * Backend endpoints we care about:
 * - POST /api/print - For A4 and thermal printing (because paper still exists)
 * - POST /api/export_reports - For dumping reports to USB (the modern floppy disk)
 * - GET/POST/DELETE /api/storage/<key> - Where we stash all our data
 * 
 * Storage + PDFs live on an internal USB pendrive on the Pi. Don't unplug it
 * while tests are running unless you enjoy debugging serial logs.
 * 
 * Dear future me (and the AI): please don't break this unless you enjoy
 * debugging serial logs at 3am.
 * 
 * MAIN CHANGES IN THIS PR:
 * - Lines ~11300-11328: Exposed OSK API functions (openOSKForInput, closeOSK)
 * - Lines ~11299-11505: Enhanced universal OSK key handler with caps lock/number layer support
 * - Lines ~5065-5160: Updated handlePrintA4() to send HTML to /api/print_a4
 * - Lines ~5162-5241: Updated handlePrintThermal() to send HTML to /api/print_thermal
 * - Lines ~1486-1500: Enhanced sendPreheat() with explicit t1/t2 debug logging
 */

// Global variable to track the currently selected report for printing
let currentReportMeta = null;

// FIX: Prevent duplicate login execution on Raspberry Pi
let loginInProgress = false;

// FIX: Backend readiness check helper
async function checkBackendReady() {
  try {
    const res = await fetchWithTimeout('/api/health', {}, 5000);
    return res.ok;
  } catch {
    return false;
  }
}

// Log config on startup so we know what mode we're in
console.log('[KIOSK] config:', DEFAULT_CONFIG);

// Request priority system - temp calls are low priority, other commands are high priority
var requestManager = {
  pendingTempRequest: null,
  pendingRequests: new Map(), // Track pending requests by URL to prevent duplicates
  lastTempCallTime: 0,
  tempCallDelay: 2000, // 2 second delay between temp calls
  isHighPriorityRequest: false,
  systemInitialized: false, // Track if initial temp scan is complete
  continuousTempPolling: null, // Interval ID for continuous polling
  requestPriority: {
    CRITICAL: 3,    // Heater, motor commands
    HIGH: 2,        // Temperature reads during tests
    NORMAL: 1,      // Regular temperature polling
    BACKGROUND: 0   // Background operations
  },
  
  // Cancel any pending temp request
  cancelPendingTempRequest: function() {
    if (this.pendingTempRequest) {
      console.log('[RequestManager] Cancelling pending temp request due to high priority command');
      // Abort the fetch if it has an AbortController
      if (this.pendingTempRequest.abortController) {
        this.pendingTempRequest.abortController.abort();
      }
      this.pendingTempRequest = null;
    }
  },
  
  // Cancel pending requests by URL (deduplication)
  cancelPendingRequest: function(url) {
    var pending = this.pendingRequests.get(url);
    if (pending) {
      console.log('[RequestManager] Cancelling duplicate request:', url);
      if (pending.abortController) {
        pending.abortController.abort();
      }
      this.pendingRequests.delete(url);
      return true;
    }
    return false;
  },
  
  // Register a pending request
  registerRequest: function(url, abortController, priority) {
    // Cancel any existing request with same URL if priority is higher
    var existing = this.pendingRequests.get(url);
    if (existing && priority > (existing.priority || 0)) {
      console.log('[RequestManager] Cancelling lower priority duplicate request:', url);
      if (existing.abortController) {
        existing.abortController.abort();
      }
    }
    this.pendingRequests.set(url, {
      abortController: abortController,
      timestamp: Date.now(),
      priority: priority || this.requestPriority.NORMAL
    });
  },
  
  // Unregister a request
  unregisterRequest: function(url) {
    this.pendingRequests.delete(url);
  },
  
  // Check if enough time has passed since last temp call
  canMakeTempCall: function() {
    var now = Date.now();
    var timeSinceLastCall = now - this.lastTempCallTime;
    if (timeSinceLastCall < this.tempCallDelay) {
      var waitTime = this.tempCallDelay - timeSinceLastCall;
      console.log('[RequestManager] Temp call rate limited, need to wait', waitTime, 'ms');
      return { canMake: false, waitTime: waitTime };
    }
    return { canMake: true, waitTime: 0 };
  },
  
  // Mark temp call time
  markTempCall: function() {
    this.lastTempCallTime = Date.now();
  }
};

// Track preheat status for auto-popup trigger
var preheatMonitor = {
  activePreheats: {}, // { basketId: { setTemp: number, startTime: number } }
  
  // Start monitoring preheat for a basket
  startMonitoring: function(basketId, setTemp) {
    this.activePreheats[basketId] = {
      setTemp: setTemp,
      startTime: Date.now(),
      popupShown: false
    };
    console.log('[PreheatMonitor] Started monitoring basket', basketId, 'target:', setTemp, '°C');
  },
  
  // Stop monitoring preheat for a basket
  stopMonitoring: function(basketId) {
    if (this.activePreheats[basketId]) {
      delete this.activePreheats[basketId];
      console.log('[PreheatMonitor] Stopped monitoring basket', basketId);
    }
  },
  
  // Disabled: popup triggered only by ESP32 TR1/TR2 via EventSource
  checkAndTrigger: function(temps) {
    // No-op: popup triggered only by ESP32 TR1/TR2 via EventSource
  }
};

// Continuous temperature polling that runs all the time
var continuousTempPollingInterval = null;

// Initialize temperature system - FIRST THING on startup
// Temps are pushed by bridge via SSE; also fetch /api/temp once for immediate display (no calibration needed)
async function initializeTemperatureSystem() {
  console.log('[TempInit] Starting temperature system - bridge SSE + initial fetch for immediate temps');
  try {
    requestManager.systemInitialized = true;
    // Fetch cached temps from bridge immediately (live display without calibration)
    var hwMode = (typeof DEFAULT_CONFIG !== 'undefined') ? DEFAULT_CONFIG.hardwareMode : null;
    if (hwMode === 'bridge') {
      try {
        var r = await fetch('/api/temp');
        if (r && r.ok) {
          var data = await r.json();
          if (data && data.timestamp > 0) {
            window.latestTemps = window.latestTemps || {};
            Object.assign(window.latestTemps, { IR1: data.IR1, IR2: data.IR2, EXT1: data.EXT1, EXT2: data.EXT2, timestamp: data.timestamp });
            if (typeof applyTempsToUI === 'function') applyTempsToUI(window.latestTemps);
          }
        }
      } catch (fetchErr) {
        console.debug('[TempInit] Initial /api/temp fetch failed (SSE will provide temps):', fetchErr);
      }
    }
    if (window.latestTemps && window.latestTemps.timestamp && typeof applyTempsToUI === 'function') {
      applyTempsToUI(window.latestTemps);
    }
    console.log('[TempInit] Temperature system initialized - live temps without calibration');
  } catch (e) {
    console.error('[TempInit] Error:', e);
    requestManager.systemInitialized = true;
  }
}

// No-op: temps come from bridge via SSE
function startContinuousTempPolling() {
  console.log('[TempPolling] Temps from bridge SSE - no polling');
}

// Stop continuous temperature polling (if needed)
function stopContinuousTempPolling() {
  if (continuousTempPollingInterval) {
    clearTimeout(continuousTempPollingInterval);
    continuousTempPollingInterval = null;
    requestManager.continuousTempPolling = null;
    console.log('[TempPolling] Stopped continuous temperature polling');
  }
}

// Trigger test start popup when temperature reaches target (called by preheat monitor)
async function triggerTestStartPopup(basketId) {
  console.log('[triggerTestStartPopup] Triggering popup for basket', basketId);
  
  // Temps from bridge SSE (window.latestTemps)
  var temps = window.latestTemps || null;
  
  // Get set temperature
  const setTempValue = Number(setTemp[basketId] || 37.0);
  
  // Get current IR temperature (direct mapping)
  var irTemp = null;
  if (basketId === 1) {
    irTemp = (temps && (temps.IR1 || temps.basket1)) ? Number(temps.IR1 || temps.basket1) : null;
  } else if (basketId === 2) {
    irTemp = (temps && (temps.IR2 || temps.basket2)) ? Number(temps.IR2 || temps.basket2) : null;
  }
  
  var currentTempStr = 'N/A';
  if (irTemp !== null && !isNaN(irTemp)) {
    currentTempStr = irTemp.toFixed(1) + '°C';
  }
  var targetTempStr = setTempValue.toFixed(1) + '°C';
  
  // Show confirmation popup
  var confirmMessage = `Basket ${basketId} has reached the set temperature (${currentTempStr} / Target: ${targetTempStr}).\n Do you want to start the test?`;
  
  console.log('[triggerTestStartPopup] Showing confirmation popup with message:', confirmMessage);
  
  // Use showModalConfirm to get user confirmation (fallback to confirm if modal not available)
  var confirmFn = window.showModalConfirm || (typeof showModalConfirm === 'function' ? showModalConfirm : null);
  var userConfirmed = false;
  if (confirmFn) {
    userConfirmed = await confirmFn(confirmMessage);
  } else {
    userConfirmed = window.confirm ? window.confirm(confirmMessage) : confirm(confirmMessage);
  }
  
  if (!userConfirmed) {
    console.log('[triggerTestStartPopup] User cancelled test start');
    // Reset UI state
    var btn = document.getElementById('start' + basketId);
    if (btn) {
      btn.textContent = 'Start';
      btn.style.background = '#10b981';
      btn.disabled = false;
    }
    window.preheatInProgress[basketId] = false;
    testRunning[basketId] = false;
    
    // Update mode button UI to re-enable mode switching
    if (typeof updateModeButtonsUI === 'function') {
      updateModeButtonsUI(basketId);
    }
    
    preheatMonitor.stopMonitoring(basketId);
    return;
  }
  
  // User confirmed - proceed with test start
  console.log('[triggerTestStartPopup] User confirmed - proceeding to START command');
  
  // Get button and container elements
  var btn = document.getElementById('start' + basketId);
  var container = document.getElementById('basket' + basketId + '-container');
  
  // Set testStartTime ONLY at actual test start (after confirmation)
  testStartTime[basketId] = Date.now();
  
  // Initialize timer state (similar to startTest)
  if (!timers[basketId]) {
    timers[basketId] = {running: false, secs: 0, interval: null, tempPollInterval: null, elapsedStarted: false};
  }
  var mode = basketModes[basketId] || 'timer';
  var duration = basketDurations[basketId];
  var isTimerMode = mode === 'timer';
  
  if (isTimerMode && duration !== null && duration !== undefined && duration > 0) {
    timers[basketId].secs = Math.floor(duration * 60);
  } else {
    timers[basketId].secs = 0;
  }
  timers[basketId].elapsedStarted = false;
  
  // Clear preheat flag and enable button for STOP
  window.preheatInProgress[basketId] = false;
  
  // Stop preheat monitoring (test started)
  preheatMonitor.stopMonitoring(basketId);
  
  // Stop preheat temperature polling (test will have its own polling)
  stopPreheatTempPolling(basketId);
  
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Stop';
    btn.style.background = '#ef4444';
  }
  
  // Set test as running
  testRunning[basketId] = true;
  
  // Update mode button UI to disable mode switching during test
  if (typeof updateModeButtonsUI === 'function') {
    updateModeButtonsUI(basketId);
  }
  
  // Send START command to ESP32 to start motor strokes (PRIORITIZE THIS)
  try {
    let startResult;
    console.log('[triggerTestStartPopup] Sending START command for basket', basketId, 'with temp:', setTempValue);
    
    // Send START command based on basket ID
    if (basketId === 1) {
      console.log('[triggerTestStartPopup] Calling sendStartB1 with temp:', setTempValue);
      startResult = await sendStartB1(setTempValue);
      console.log('[triggerTestStartPopup] sendStartB1 returned:', startResult);
    } else if (basketId === 2) {
      console.log('[triggerTestStartPopup] Calling sendStartB2 with temp:', setTempValue);
      startResult = await sendStartB2(setTempValue);
      console.log('[triggerTestStartPopup] sendStartB2 returned:', startResult);
    } else if (basketId === 3) {
      const t1 = setTemp[1] || setTempValue;
      const t2 = setTemp[2] || setTempValue;
      console.log('[triggerTestStartPopup] Calling sendStartB3 with t1:', t1, 't2:', t2);
      if (typeof sendStartB3 === 'function') {
        startResult = await sendStartB3(t1, t2);
        console.log('[triggerTestStartPopup] sendStartB3 returned:', startResult);
      }
    }
    
    // Check if START command was successful
    if (startResult && startResult.error) {
      console.error('[triggerTestStartPopup] Start command failed:', startResult.error);
      if (typeof showToast === 'function') {
        showToast('Failed to start motor: ' + startResult.error, 'error');
      } else if (typeof showModal === 'function') {
        showModal('Failed to start motor: ' + startResult.error);
      }
      // Reset UI state on failure
      if (btn) {
        btn.textContent = 'Start';
        btn.style.background = '#10b981';
      }
      testRunning[basketId] = false;
      window.preheatInProgress[basketId] = false;
      
      // Update mode button UI to re-enable mode switching
      if (typeof updateModeButtonsUI === 'function') {
        updateModeButtonsUI(basketId);
      }
      
      return;
    }
    
    // Verify the command was actually sent (check for 'ok' or 'cmd' in response)
    if (!startResult || (!startResult.ok && !startResult.cmd)) {
      console.error('[triggerTestStartPopup] Start command response invalid:', startResult);
      if (typeof showToast === 'function') {
        showToast('Motor start command failed. Please check equipment connection.', 'error');
      }
      if (btn) {
        btn.textContent = 'Start';
        btn.style.background = '#10b981';
      }
      testRunning[basketId] = false;
      window.preheatInProgress[basketId] = false;
      
      // Update mode button UI to re-enable mode switching
      if (typeof updateModeButtonsUI === 'function') {
        updateModeButtonsUI(basketId);
      }
      
      return;
    }
    
    console.log('[triggerTestStartPopup] Start command sent successfully:', startResult);
    console.log('[triggerTestStartPopup] Motor strokes should now be running for basket', basketId);
    
    // Show success message
    if (typeof showToast === 'function') {
      showToast('Test started successfully. Motor strokes running.', 'success');
    }
  } catch (e) {
    console.error('[triggerTestStartPopup] Failed to start motor:', e, e.stack);
    if (typeof showToast === 'function') {
      showToast('Motor control failed. Please check the equipment connection and try again.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('Motor control failed. Please check the equipment connection and try again.');
    }
    // Reset UI state on failure
    if (btn) {
      btn.textContent = 'Start';
      btn.style.background = '#10b981';
    }
    testRunning[basketId] = false;
    window.preheatInProgress[basketId] = false;
    
    // Update mode button UI to re-enable mode switching
    if (typeof updateModeButtonsUI === 'function') {
      updateModeButtonsUI(basketId);
    }
    
    return;
  }
  
  // Start elapsed timer (mode and duration already set above)
  if (typeof startElapsedTimer === 'function') {
    startElapsedTimer(basketId, mode, duration, isTimerMode);
  }
  
  // Add active ring to container
  if (container && !container.querySelector('.basket-active-ring')) {
    var ring = document.createElement('div');
    ring.className = 'basket-active-ring';
    container.appendChild(ring);
  }
  
  // Update basket states
  if (typeof updateBasketStates === 'function') {
    updateBasketStates();
  }
}

// Temperature validation: show popup when TR received for selected beaker, then start 2-min holding
function triggerValidationTempReachedPopup(basketId) {
  if (typeof tempValidationPreheatArmed === 'undefined' || !tempValidationPreheatArmed) return;
  tempValidationPreheatArmed = false;
  var msg = 'Temperature reached for validation.\nHolding will start for 2 minutes.';
  var confirmFn = window.showModalConfirm || (typeof showModalConfirm === 'function' ? showModalConfirm : null);
  if (confirmFn) {
    confirmFn(msg).then(function(ok) {
      if (ok && typeof startHoldingPhase === 'function') startHoldingPhase();
    }).catch(function() {});
  } else {
    if (window.confirm ? window.confirm(msg) : confirm(msg)) {
      if (typeof startHoldingPhase === 'function') startHoldingPhase();
    }
  }
}

window.triggerValidationTempReachedPopup = triggerValidationTempReachedPopup;

// Initialize Lucide icons on DOM ready
document.addEventListener('DOMContentLoaded', function () {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:772',message:'DOMContentLoaded fired',data:{readyState:document.readyState,hasLoginBtn:!!document.getElementById('login-btn'),hasKeyboardRoot:!!document.getElementById('keyboard-root')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'D'})}).catch(()=>{});
  // #endregion agent log
  console.log('[Init] DOM Content Loaded - Starting initialization sequence');

  // Load persisted 12/24-hour display preference early (affects top-bar clock).
  // Stored as "true"/"false" (string) or boolean.
  (async function initUse24HourPreference(){
    try {
      var saved = await StorageAdapter.get('use24Hour');
      if (saved !== null && saved !== undefined) {
        use24Hour = (saved === true || saved === 'true' || saved === 1 || saved === '1');
      }
    } catch (e) {
      console.warn('[Init] Failed to load use24Hour preference:', e);
    }
    if (typeof updateClock === 'function') updateClock();
  })();
  
  // STEP 1: Initialize temperature system FIRST (before anything else)
  // This will scan temperatures and start continuous polling
  initializeTemperatureSystem().then(function() {
    console.log('[Init] Temperature system initialized - proceeding with UI setup');
    
    // STEP 2: Setup UI after temperature system is ready
    // Ensure login screen is shown first (before any other initialization)
    console.log('[Init] Ensuring login screen is shown first');
    var loginScreen = document.getElementById('screen-login');
    if (loginScreen) {
      loginScreen.classList.add('active');
      loginScreen.style.display = 'flex';
      loginScreen.style.visibility = 'visible';
      loginScreen.style.zIndex = '200';
      // Hide all other screens
      var allScreens = document.querySelectorAll('.screen');
      for (var i = 0; i < allScreens.length; i++) {
        if (allScreens[i].id !== 'screen-login') {
          allScreens[i].classList.remove('active');
          allScreens[i].style.display = 'none';
          allScreens[i].style.visibility = 'hidden';
        }
      }
      // Hide sidebar on login screen
      var sidebar = document.getElementById('sidebar');
      if (sidebar) {
        sidebar.classList.remove('visible');
        sidebar.style.opacity = '0';
        sidebar.style.pointerEvents = 'none';
      }
      
      // FIX: Prevent blank area clicks from focusing input fields
      loginScreen.addEventListener('click', function(e) {
        // Only prevent focus if clicking on the screen itself or non-interactive elements
        var target = e.target;
        // Allow clicks on inputs, buttons, and other interactive elements
        if (target.tagName === 'INPUT' || target.tagName === 'BUTTON' || target.tagName === 'A' || 
            target.closest('input') || target.closest('button') || target.closest('a')) {
          return; // Allow normal behavior for interactive elements
        }
        // Prevent focus on blank area clicks
        if (document.activeElement && 
            (document.activeElement.id === 'login-uid' || document.activeElement.id === 'login-pwd')) {
          document.activeElement.blur();
        }
        e.stopPropagation();
      }, { passive: true });
    }
    
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
    
    // FIX: Wire up login button with proper event listener to prevent duplicate execution
    var loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
      // FIX: Remove ALL existing handlers to prevent duplicates
      loginBtn.onclick = null;
      loginBtn.replaceWith(loginBtn.cloneNode(true)); // Remove all event listeners
      loginBtn = document.getElementById('login-btn'); // Get fresh reference
      
      // Add single event listener
      loginBtn.setAttribute('data-login-bound', 'true');
      loginBtn.addEventListener('click', function(e) {
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:838',message:'login button clicked',data:{hasHandleLogin:typeof handleLogin === 'function'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
        // #endregion agent log
        e.preventDefault();
        e.stopPropagation();
        if (typeof handleLogin === 'function') {
          handleLogin(e);
        }
      });
      console.log('[Init] Login button event listener attached');
    }
    
    console.log('[Init] Initialization sequence complete');
  }).catch(function(e) {
    console.error('[Init] Error during initialization:', e);
    // Continue with UI setup even if temp init fails
    var loginScreen = document.getElementById('screen-login');
    if (loginScreen) {
      loginScreen.classList.add('active');
      loginScreen.style.display = 'flex';
      loginScreen.style.visibility = 'visible';
      loginScreen.style.zIndex = '200';
    }
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
    
    // FIX: Wire up login button with proper event listener (fallback if temp init fails)
    // NOTE: Only attach if not already attached above
    var loginBtn = document.getElementById('login-btn');
    if (loginBtn && !loginBtn.hasAttribute('data-login-bound')) {
      loginBtn.setAttribute('data-login-bound', 'true');
      loginBtn.onclick = null;
      loginBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof handleLogin === 'function') {
          handleLogin(e);
        }
      });
      console.log('[Init] Login button event listener attached (fallback)');
    }
  });
  
  // Wire up the start/stop buttons for both baskets (because we have two of them)
  for (var id = 1; id <= 2; id++) {
    (function(basketId) {
      var btn = document.getElementById('start' + basketId);
      if (btn) {
        btn.onclick = function() {
          // Get the button again to ensure we have the correct one
          var currentBtn = document.getElementById('start' + basketId);
          if (!currentBtn) return;
          
          // If preheat is in progress for this basket, show abort confirmation
          if (window.preheatInProgress && window.preheatInProgress[basketId]) {
            console.log('[Button] Preheat in progress, showing abort confirmation for basket', basketId);
            // Show confirmation to abort preheating (use async IIFE since onclick handler isn't async)
            (async function() {
              // FIX: Use showModalConfirm only, remove window.confirm fallback
              var confirmed = false;
              if (typeof showModalConfirm === 'function') {
                confirmed = await showModalConfirm(
                  'Preheating is in progress. Do you want to abort the test and stop preheating?'
                );
              }
              
              if (confirmed) {
                // Abort preheating and reset state for THIS basket only
                try {
                  // Use per-basket stop command (not global sendStopAll)
                  await sendStopForBasket(basketId);
                  // Reset button state for this basket only
                  currentBtn.textContent = 'Start';
                  currentBtn.style.background = '#10b981';
                  currentBtn.disabled = false;
                  window.preheatInProgress[basketId] = false;
                  testRunning[basketId] = false;
                  heaterOn[basketId] = false;
                  if (typeof updateModeButtonsUI === 'function') {
                    updateModeButtonsUI(basketId);
                  }
                  if (typeof updateHeaterControlUI === 'function') {
                    updateHeaterControlUI();
                  }
                  if (typeof showToast === 'function') {
                    showToast('Preheating aborted for basket ' + basketId + '.', 'info');
                  }
                  console.log('[Button] Preheat aborted for basket', basketId, '- other basket state unchanged');
                } catch (e) {
                  console.error('[Button] Error aborting preheat:', e);
                  if (typeof showToast === 'function') {
                    showToast('Failed to abort preheating. Please try again.', 'error');
                  }
                }
              }
            })();
            return;
          }
          
          if (timers[basketId].running || testRunning[basketId]) {
            // Stop the test - send STOP command for this specific basket only
            console.log('[Button] Stop button clicked for basket', basketId);
            (async function() {
              try {
                // FIX: Use per-basket stop command instead of sendStopAll()
                const result = await sendStopForBasket(basketId);
                if (result && result.error) {
                  console.error('[Button] Stop command failed:', result.error);
                  if (typeof showToast === 'function') {
                    showToast('Failed to stop the test. Please try again or use the emergency stop if available.', 'error');
                  }
                }
                if (typeof stopTest === 'function') {
                  stopTest(basketId, { aborted: true });
                } else {
                  console.error('[Button] stopTest function not available');
                }
              } catch (e) {
                console.error('[Button] Stop exception:', e);
              }
            })();
            return;
          } else {
            // Start the test - ensure configuredBeakers is set and always call startTest
            console.log('[Button] Start button clicked for basket', basketId);
            configuredBeakers[basketId] = true;
            
            // Always use startTest function
            if (typeof startTest === 'function') {
              startTest(basketId).catch(function(e) {
                console.error('[Button] startTest exception:', e);
                if (typeof showModal === 'function') {
                  showModal('Failed to start the test. Please check that the equipment is ready and try again.');
                }
              });
            } else {
              console.error('[Button] startTest function not available');
              if (typeof showModal === 'function') {
                showModal('Failed to start the test. Please check that the equipment is ready and try again.');
              }
            }
          }
        };
      }
    })(id);
  }
  
  // Initialize temperature inputs (with a delay because DOM is sometimes slow to cooperate)
  setTimeout(function() {
    if (typeof initTemperatureInputs === 'function') {
      initTemperatureInputs();
    }
  }, 200);
  
  // Wire validation stop button and other action buttons
  document.addEventListener('click', function(ev) {
    const b = ev.target.closest && ev.target.closest('[data-action]');
    if (!b) return;
    const action = b.dataset.action;
    if (action === 'validation-stop') {
      // ensure UI stops and stop command goes to ESP - use global stop for validation
      sendStopAll('validation-stop-button').then(function() {
        if (typeof stopValidation === 'function') {
          stopValidation();
        }
        if (typeof showToast === 'function') {
          showToast('Stop command sent', 'info');
        }
      }).catch(function(e) {
        console.error('[Validation] Stop failed:', e);
      });
    }
  });
  
  // Wire calibration buttons
  document.getElementById('btn-cal-ir1')?.addEventListener('click', async function() {
    const val = Number(document.getElementById('cal-ir1-input')?.value || 25.0);
    const r = await sendCalIR1(val);
    if (typeof showToast === 'function') {
      showToast('CAL IR1 -> ' + (r.cmd || r.error ? JSON.stringify(r) : 'OK'), 'info');
    }
  });
  
  document.getElementById('btn-cal-ir2')?.addEventListener('click', async function() {
    const val = Number(document.getElementById('cal-ir2-input')?.value || 25.0);
    const r = await sendCalIR2(val);
    if (typeof showToast === 'function') {
      showToast('CAL IR2 -> ' + (r.cmd || r.error ? JSON.stringify(r) : 'OK'), 'info');
    }
  });
  
  document.getElementById('btn-cal-ext1')?.addEventListener('click', async function() {
    const val = Number(document.getElementById('cal-ext1-input')?.value || 25.0);
    const r = await sendCalEXT1(val);
    if (typeof showToast === 'function') {
      showToast('CAL EXT1 -> ' + (r.cmd || r.error ? JSON.stringify(r) : 'OK'), 'info');
    }
  });
  
  document.getElementById('btn-cal-ext2')?.addEventListener('click', async function() {
    const val = Number(document.getElementById('cal-ext2-input')?.value || 25.0);
    const r = await sendCalEXT2(val);
    if (typeof showToast === 'function') {
      showToast('CAL EXT2 -> ' + (r.cmd || r.error ? JSON.stringify(r) : 'OK'), 'info');
    }
  });
});

/* ========== DEFAULT CONFIG ========== */
// This is where we decide if we're talking to real hardware or just pretending

// default to 'bridge' on Pi but allow safe automatic fallback to 'local' if bridge unreachable
var DEFAULT_CONFIG = {
  storageMode: 'bridge',    // 'local' or 'bridge'
  bridgeBase: '/api',
  hardwareMode: 'bridge'    // 'sim' or 'bridge'
};

// allow overrides with URL params or process env placeholder (for kiosk: pass ?storage=local)
var urlp = new URLSearchParams(window.location.search);
if (urlp.get('hw')) DEFAULT_CONFIG.hardwareMode = urlp.get('hw');
if (urlp.get('storage')) DEFAULT_CONFIG.storageMode = urlp.get('storage');

// log modes
console.info('[CONFIG] storageMode=%s, hardwareMode=%s, bridgeBase=%s', DEFAULT_CONFIG.storageMode, DEFAULT_CONFIG.hardwareMode, DEFAULT_CONFIG.bridgeBase);



/* ========== StorageAdapter (switchable) ========== */
// This is our storage abstraction layer - it can talk to the backend or use localStorage
// Because sometimes the backend is down and we need to fall back gracefully

const StorageAdapter = (function(){

  let mode = DEFAULT_CONFIG.storageMode;

  let bridgeBase = DEFAULT_CONFIG.bridgeBase;



  // Local storage fallback (for when the backend decides to take a nap)
  const local = {

    get(key){

      try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }

      catch(e){ console.error('StorageAdapter local.get parse error', e); return null; }

    },

    set(key,val){

      try { localStorage.setItem(key, JSON.stringify(val)); }

      catch(e){ console.error('StorageAdapter local.set error', e); }

    },

    remove(key){ localStorage.removeItem(key); }

  };



  async function get(key){
    if(mode === 'local') return local.get(key);

    try {
      const r = await fetchWithTimeout(`${bridgeBase}/storage/${encodeURIComponent(key)}`, {}, 10000);

      if(!r.ok) {
        console.warn(`[StorageAdapter] Bridge read failed for '${key}', falling back to local storage`);
        return local.get(key);
      }

      var contentType = r.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        console.warn(`[StorageAdapter] Bridge returned non-JSON for '${key}', falling back to local storage`);
        return local.get(key);
      }

      try {
        return await r.json();
      } catch (jsonError) {
        console.warn(`[StorageAdapter] JSON parse failed for '${key}', falling back to local storage:`, jsonError);
        return local.get(key);
      }
    } catch (e) {
      console.warn(`[StorageAdapter] Bridge unavailable for '${key}', falling back to local storage:`, e.message);
      return local.get(key);
    }
  }



  async function set(key, val){
    if(mode === 'local'){ local.set(key,val); return; }

    try {
      const r = await fetchWithTimeout(`${bridgeBase}/storage/${encodeURIComponent(key)}`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(val)
      }, 10000);

      if(!r.ok) {
        console.warn(`[StorageAdapter] Bridge write failed for '${key}', falling back to local storage`);
        local.set(key, val);
        return;
      }
      
      var contentType = r.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        console.warn(`[StorageAdapter] Bridge returned non-JSON for write '${key}', using local storage`);
        local.set(key, val);
        return;
      }
    } catch (e) {
      console.warn(`[StorageAdapter] Bridge unavailable for '${key}', falling back to local storage:`, e.message);
      local.set(key, val);
    }
  }



  function remove(key){ 
    if(mode === 'local') return local.remove(key); 
    try {
      fetch(`${bridgeBase}/storage/${encodeURIComponent(key)}`, { method:'DELETE' }).catch(() => {
        console.warn(`[StorageAdapter] Bridge remove failed for '${key}', falling back to local storage`);
        local.remove(key);
      });
    } catch (e) {
      console.warn(`[StorageAdapter] Bridge unavailable for remove '${key}', using local storage:`, e.message);
      local.remove(key);
    }
  }



  function configure(opts = {}){

    if(opts.mode) mode = opts.mode;

    if(opts.bridgeBase) bridgeBase = opts.bridgeBase;

  }

  return { get, set, remove, configure };

})();

// After StorageAdapter is created, enforce safe mode detection at runtime:
// CHANGED: Show toast when fallback occurs
(async function ensureStorageMode() {
  try {
    // quick probe only if configured for bridge
    if (DEFAULT_CONFIG.storageMode === 'bridge') {
      // FIX: Add timeout for Pi (may hang if bridge is down) - use AbortController for compatibility
      var controller = new AbortController();
      var timeoutId = setTimeout(function() { controller.abort(); }, 3000);
      
      const probe = await fetchWithTimeout(DEFAULT_CONFIG.bridgeBase + '/storage/ping', { 
        method: 'GET', 
        cache: 'no-store',
        signal: controller.signal
      }, 5000).catch(function(err) {
        clearTimeout(timeoutId);
        return null;
      });
      clearTimeout(timeoutId);
      
      if (!probe || !probe.ok) {
        console.warn('[StorageAdapter] Bridge not reachable — switching storageMode => local (fallback)');
        StorageAdapter.configure({ mode: 'local' });
        // CHANGED: Show visible toast when fallback occurs (only after DOM ready)
        if (typeof document !== 'undefined' && document.readyState !== 'loading') {
          if (typeof showToast === 'function') {
            showToast('Bridge (backend) unreachable — some features will be offline', 'error');
          }
        }
      } else {
        // FIX: Verify response is JSON, not HTML error page
        var contentType = probe.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          StorageAdapter.configure({ mode: 'bridge' });
        } else {
          console.warn('[StorageAdapter] Bridge ping returned non-JSON, using local mode');
          StorageAdapter.configure({ mode: 'local' });
        }
      }
    } else {
      StorageAdapter.configure({ mode: 'local' });
    }
  } catch(e) {
    console.warn('[StorageAdapter] Probe error switching to local', e);
    StorageAdapter.configure({ mode: 'local' });
    // CHANGED: Show visible toast when fallback occurs (only after DOM ready)
    if (typeof document !== 'undefined' && document.readyState !== 'loading') {
      if (typeof showToast === 'function') {
        showToast('Bridge (backend) unreachable — some features will be offline', 'error');
      }
    }
  }
})();



/* ========== HardwareAdapter (simulated + bridge hooks) ========== */
// This is where the UI pretends to be smart and talks to the real hardware
// Or simulates it if we're in dev mode (because testing on real hardware is expensive)

const HardwareAdapter = (function(){

  let mode = DEFAULT_CONFIG.hardwareMode;

  // Simulated state for when we're not using real hardware (because sometimes you need to test without breaking things)
  let simState = {

    temps: { basket1:37.0, basket2:37.0, ext1:25.0, ext2:25.0 },

    heaterOn: { h1:false, h2:false },

    motorsRunning: { m1:false, m2:false },

    strokes: { s1:0, s2:0 },

    started: false

  };

  let simInterval = null;



  function startSimulatorTick(){

    if(simInterval) return; // Don't start multiple intervals (because that's wasteful)

    simInterval = setInterval(()=>{

      // Temperature drift (because physics is a thing, even in simulation)
      for(const k in simState.temps){

        const sign = (simState.heaterOn.h1 || simState.heaterOn.h2) ? 1 : -0.05;

        simState.temps[k] = +(simState.temps[k] + (Math.random()*0.15)*sign).toFixed(2);

      }

      // Strokes when motors running (because motors do motor things)
      if(simState.motorsRunning.m1) simState.strokes.s1 += 1;

      if(simState.motorsRunning.m2) simState.strokes.s2 += 1;

      // Broadcast stroke stream by invoking onData callbacks (because someone needs to know about this)
      if(onDataCallback) onDataCallback(`S1:${simState.strokes.s1},S2:${simState.strokes.s2}`);

    }, 1000);

  }



  let onDataCallback = null;

  function onData(cb){ onDataCallback = cb; }



  async function readTemps(){ 
    // Read temperatures from hardware (or fake it if we're simulating)
    if(mode === 'sim'){ return {...simState.temps}; }

    try {
      // Temps come from bridge via SSE - use window.latestTemps
      return Promise.resolve(window.latestTemps || { IR1: 0, IR2: 0, EXT1: 0, EXT2: 0 });
    } catch (e) {
      console.error('[HardwareAdapter] Temp read exception:', e);
      throw e;
    }
  }



  async function heaterControl({id, on, pwm}) {

    if(mode === 'sim'){ simState.heaterOn[id] = !!on; return {ok:true}; }

    const r = await retryFetch(`${DEFAULT_CONFIG.bridgeBase}/heater`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id,on,pwm})
    }, 1, 500, 15000); // Retry once with 0.5s backoff, 15s timeout

    if(!r.ok) throw new Error('heater control failed'); return r.json();

  }



  async function motorControl({id, cmd, value}){

    if(mode === 'sim'){

      if(cmd === 'start') simState.motorsRunning[id] = true;

      if(cmd === 'stop' || cmd === 'park') simState.motorsRunning[id] = false;

      return {ok:true};

    }

    const r = await retryFetch(`${DEFAULT_CONFIG.bridgeBase}/motor`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({id,cmd,value})
    }, 1, 500, 15000); // Retry once with 0.5s backoff, 15s timeout

    if(!r.ok) throw new Error('motor control failed'); return r.json();

  }



  async function startStrokeCounting(basket){
    // REMOVED: ESP stroke counting - using simulated data only
    // Stroke counting now handled by auto-increment in startStrokeValidationReal()
    if(mode === 'sim'){ simState.started = true; startSimulatorTick(); return {ok:true}; }
    
    // No ESP call - return success immediately
    return {ok: true};
  }



  function configure(opts = {}){ if(opts.mode) mode = opts.mode; }



  // boot behavior for sim: call onData with "System Ready"

  setTimeout(()=>{ if(onDataCallback) onDataCallback('System Ready'); }, 100);



  return { configure, readTemps, heaterControl, motorControl, startStrokeCounting, onData, _simState: simState };

})();

// Expose HardwareAdapter globally for bridge EventSource integration (because global state is sometimes necessary)
window.HardwareAdapter = HardwareAdapter;

function applyTempsToUI(temps) {
  if (!temps) return;
  
  var hasAny = (temps.IR1 !== undefined || temps.IR2 !== undefined ||
                temps.EXT1 !== undefined || temps.EXT2 !== undefined);
  if (!hasAny) return;
  
  updateTempsToDOM(temps);
}

// Immediate DOM update function (no delays)
// Uses only IR1, IR2, EXT1, EXT2 from JSON type:'temps' payload.
function updateTempsToDOM(temps) {
  if (!temps) return;
  
  console.log('[updateTempsToDOM] Updating UI at ' + new Date().toLocaleTimeString() + 
             ' - IR1=' + (temps.IR1 !== undefined ? temps.IR1.toFixed(1) : '--') + 
             ', IR2=' + (temps.IR2 !== undefined ? temps.IR2.toFixed(1) : '--'));
  
  // Record temperatures during active tests: Basket 1 -> IR1, Basket 2 -> IR2
  for (var basketId = 1; basketId <= 2; basketId++) {
    if (testRunning[basketId] && testStartTime[basketId]) {
      var tempValue = (basketId === 1) ? temps.IR1 : temps.IR2;
      if (tempValue !== null && tempValue !== undefined && typeof tempValue === 'number' && !isNaN(tempValue)) {
        var tempRecord = {t: Date.now()};
        if (basketId === 1) {
          tempRecord.basket1 = tempValue;
        } else {
          tempRecord.basket2 = tempValue;
        }
        recordedTemps[basketId].push(tempRecord);
      }
    }
  }
  
  // Basket temperatures: temp1 = IR1, temp2 = IR2
  var temp1El = document.getElementById('temp1');
  var temp2El = document.getElementById('temp2');
  if (temp1El && temps.IR1 !== undefined && typeof temps.IR1 === 'number' && !isNaN(temps.IR1) && isFinite(temps.IR1)) {
    temp1El.textContent = temps.IR1.toFixed(1) + '°C';
  }
  if (temp2El && temps.IR2 !== undefined && typeof temps.IR2 === 'number' && !isNaN(temps.IR2) && isFinite(temps.IR2)) {
    temp2El.textContent = temps.IR2.toFixed(1) + '°C';
  }
  
  // Probe displays: #probe-1 = EXT1, #probe-2 = EXT2
  const p1 = document.querySelector('#probe-1 .probe-circle .text-white');
  const p2 = document.querySelector('#probe-2 .probe-circle .text-white');
  if (p1 && temps.EXT1 !== undefined && typeof temps.EXT1 === 'number' && !isNaN(temps.EXT1) && isFinite(temps.EXT1)) {
    p1.textContent = temps.EXT1.toFixed(1) + '°C';
  }
  if (p2 && temps.EXT2 !== undefined && typeof temps.EXT2 === 'number' && !isNaN(temps.EXT2) && isFinite(temps.EXT2)) {
    p2.textContent = temps.EXT2.toFixed(1) + '°C';
  }
  
  // Calibration screen live update: when on temp-calibration-input, update inputs from latest temps
  var calScreen = document.getElementById('screen-temp-calibration-input');
  if (calScreen && calScreen.classList.contains('active')) {
    var internalTempInput = document.getElementById('calibration-internal-temp-input');
    var externalTempInput = document.getElementById('calibration-external-temp-input');
    var beakerNum = (typeof validationBeaker !== 'undefined' && validationBeaker !== null) ? validationBeaker : 1;
    if (beakerNum === 1 && temps.IR1 !== undefined && temps.EXT1 !== undefined) {
      if (internalTempInput) internalTempInput.value = temps.IR1.toFixed(1) + '°C';
      if (externalTempInput) externalTempInput.value = temps.EXT1.toFixed(1) + '°C';
    } else if (beakerNum === 2 && temps.IR2 !== undefined && temps.EXT2 !== undefined) {
      if (internalTempInput) internalTempInput.value = temps.IR2.toFixed(1) + '°C';
      if (externalTempInput) externalTempInput.value = temps.EXT2.toFixed(1) + '°C';
    }
  }
  
  // Temp validation screen live update: when on temp-validation, update measured temp (raw sensor, no calibration) and deviation
  var tempValidationScreen = document.getElementById('screen-temp-validation');
  if (tempValidationScreen && tempValidationScreen.classList.contains('active')) {
    var measuredTempDisplayEl = document.getElementById('measured-temp-display');
    var deviationDisplayEl = document.getElementById('deviation-display');
    var setTempDisplayEl = document.getElementById('set-temp-display');
    var beakerNum = (typeof validationBeaker !== 'undefined' && validationBeaker !== null) ? validationBeaker : 1;
    var rawTemp = null;
    if (beakerNum === 1 && temps.IR1 !== undefined && typeof temps.IR1 === 'number' && !isNaN(temps.IR1)) {
      rawTemp = temps.IR1;
    } else if (beakerNum === 2 && temps.IR2 !== undefined && typeof temps.IR2 === 'number' && !isNaN(temps.IR2)) {
      rawTemp = temps.IR2;
    }
    if (measuredTempDisplayEl && rawTemp !== null) {
      measuredTempDisplayEl.textContent = Number(rawTemp).toFixed(1);
    }
    if (deviationDisplayEl && measuredTempDisplayEl && setTempDisplayEl) {
      var setV = parseFloat(setTempDisplayEl.textContent) || 37.0;
      var measV = parseFloat(measuredTempDisplayEl.textContent);
      if (!isNaN(measV)) {
        var dev = Math.abs(measV - setV);
        deviationDisplayEl.textContent = '\u00B1' + dev.toFixed(2) + '\u00B0C';
      }
    }
  }
  
  // Heater temperature displays (if present)
  const h1 = document.getElementById('heater1-temp');
  const h2 = document.getElementById('heater2-temp');
  if (h1 && temps.h1 !== undefined) h1.textContent = temps.h1.toFixed(1) + '°C';
  if (h2 && temps.h2 !== undefined) h2.textContent = temps.h2.toFixed(1) + '°C';
}

// Debounce TR1/TR2 so ESP's double-send (0.5s apart) doesn't show popup twice
var lastHeaterReadyPopupTime = { 1: 0, 2: 0 };
var HEATER_READY_DEBOUNCE_MS = 2500;

// Bridge SSE glue: forwards serial lines from /api/stream to HardwareAdapter.onData
// This is where we listen to the hardware stream and pretend we understand what it's saying
(function attachBridgeStream(){
  try {
    const hwMode = (typeof DEFAULT_CONFIG !== 'undefined') ? DEFAULT_CONFIG.hardwareMode : null;
    if (hwMode === 'bridge') {
      console.log('[KIOSK] hardwareMode=bridge — connecting EventSource /api/stream');
      const es = new EventSource('/api/stream');
      
      es.onmessage = e => {
        // FIX: Handle TR1/TR2 events - try JSON first, then fallback to string format
        try {
          const data = JSON.parse(e.data);
          if (data && typeof data.type === 'string' && data.type.startsWith('TR1')) {
            // Validation flow: on temp-validation screen, TR1 for beaker 1 triggers "Temperature reached" popup
            var tempValScreen = document.getElementById('screen-temp-validation');
            if (tempValScreen && tempValScreen.classList.contains('active') &&
                typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed &&
                (typeof validationBeaker === 'undefined' ? 1 : validationBeaker) === 1) {
              if (Date.now() - lastHeaterReadyPopupTime[1] < HEATER_READY_DEBOUNCE_MS) return;
              lastHeaterReadyPopupTime[1] = Date.now();
              console.log('[EventSource] TR1 received - temperature reached for validation (beaker 1)');
              if (typeof triggerValidationTempReachedPopup === 'function') {
                triggerValidationTempReachedPopup(1);
              }
              return;
            }
            // Test flow: Ignore TR1 if basket 1 test is already running or not in preheat/armed state
            if (typeof testRunning !== 'undefined' && testRunning && testRunning[1]) {
              console.log('[EventSource] TR1 received but basket 1 test already running - ignoring');
              return;
            }
            if (!window.preheatInProgress || !window.preheatInProgress[1]) {
              console.log('[EventSource] TR1 received but basket 1 not preheating/armed - ignoring');
              return;
            }
            if (Date.now() - lastHeaterReadyPopupTime[1] < HEATER_READY_DEBOUNCE_MS) {
              console.log('[EventSource] Ignoring duplicate TR1 (debounce)');
              return;
            }
            lastHeaterReadyPopupTime[1] = Date.now();
            console.log('[EventSource] Received TR1 event (JSON) - heater ready for basket 1');
            if (typeof triggerTestStartPopup === 'function') {
              triggerTestStartPopup(1).catch(function(err) {
                console.error('[EventSource] Error triggering test start popup for basket 1:', err);
              });
            } else {
              console.warn('[EventSource] triggerTestStartPopup function not available');
            }
            return;
          }
          if (data && typeof data.type === 'string' && data.type.startsWith('TR2')) {
            // Validation flow: on temp-validation screen, TR2 for beaker 2 triggers "Temperature reached" popup
            var tempValScreen2 = document.getElementById('screen-temp-validation');
            if (tempValScreen2 && tempValScreen2.classList.contains('active') &&
                typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed &&
                (typeof validationBeaker === 'undefined' ? 2 : validationBeaker) === 2) {
              if (Date.now() - lastHeaterReadyPopupTime[2] < HEATER_READY_DEBOUNCE_MS) return;
              lastHeaterReadyPopupTime[2] = Date.now();
              console.log('[EventSource] TR2 received - temperature reached for validation (beaker 2)');
              if (typeof triggerValidationTempReachedPopup === 'function') {
                triggerValidationTempReachedPopup(2);
              }
              return;
            }
            // Test flow: Ignore TR2 if basket 2 test is already running or not in preheat/armed state
            if (typeof testRunning !== 'undefined' && testRunning && testRunning[2]) {
              console.log('[EventSource] TR2 received but basket 2 test already running - ignoring');
              return;
            }
            if (!window.preheatInProgress || !window.preheatInProgress[2]) {
              console.log('[EventSource] TR2 received but basket 2 not preheating/armed - ignoring');
              return;
            }
            if (Date.now() - lastHeaterReadyPopupTime[2] < HEATER_READY_DEBOUNCE_MS) {
              console.log('[EventSource] Ignoring duplicate TR2 (debounce)');
              return;
            }
            lastHeaterReadyPopupTime[2] = Date.now();
            console.log('[EventSource] Received TR2 event (JSON) - heater ready for basket 2');
            if (typeof triggerTestStartPopup === 'function') {
              triggerTestStartPopup(2).catch(function(err) {
                console.error('[EventSource] Error triggering test start popup for basket 2:', err);
              });
            } else {
              console.warn('[EventSource] triggerTestStartPopup function not available');
            }
            return;
          }
          if (data && data.type === 'temps') {
            console.log('[SSE Temps] IR1=' + (data.IR1 !== undefined ? data.IR1.toFixed(1) : '--') + 
                       ', IR2=' + (data.IR2 !== undefined ? data.IR2.toFixed(1) : '--') + 
                       ', EXT1=' + (data.EXT1 !== undefined ? data.EXT1.toFixed(1) : '--') + 
                       ', EXT2=' + (data.EXT2 !== undefined ? data.EXT2.toFixed(1) : '--'));
            window.latestTemps = window.latestTemps || {};
            Object.assign(window.latestTemps, data);
            if (typeof applyTempsToUI === 'function') applyTempsToUI(data);
            // Also update dashboard widgets (temp-t1, temp-t2, etc.) if present
            if (typeof updateTempWidgets === 'function') {
              const ts = data.timestamp ? Math.floor(data.timestamp / 1000) : null;
              updateTempWidgets({
                t1: data.IR1, t2: data.IR2,
                ext1: data.EXT1, ext2: data.EXT2,
                ts: ts
              });
            }
            return;
          }
        } catch (parseErr) {
          // Not JSON - check for TR1/TR2 as raw string (e.g. from bridge or legacy ESP)
          var raw = (e.data || '').trim().toUpperCase();
          if (raw.indexOf('TR1') !== -1 || raw.indexOf('TR2') !== -1) {
            var hasTR1 = raw.indexOf('TR1') !== -1;
            var hasTR2 = raw.indexOf('TR2') !== -1;
            var vb = (typeof validationBeaker !== 'undefined' && validationBeaker !== null) ? validationBeaker : 1;
            var tempValScreenRaw = document.getElementById('screen-temp-validation');
            var valArmed = tempValScreenRaw && tempValScreenRaw.classList.contains('active') &&
                           typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed;
            if (hasTR1 && valArmed && vb === 1 && Date.now() - lastHeaterReadyPopupTime[1] >= HEATER_READY_DEBOUNCE_MS) {
              lastHeaterReadyPopupTime[1] = Date.now();
              console.log('[EventSource] TR1 (raw) - temperature reached for validation (beaker 1)');
              if (typeof triggerValidationTempReachedPopup === 'function') triggerValidationTempReachedPopup(1);
              return;
            }
            if (hasTR2 && valArmed && vb === 2 && Date.now() - lastHeaterReadyPopupTime[2] >= HEATER_READY_DEBOUNCE_MS) {
              lastHeaterReadyPopupTime[2] = Date.now();
              console.log('[EventSource] TR2 (raw) - temperature reached for validation (beaker 2)');
              if (typeof triggerValidationTempReachedPopup === 'function') triggerValidationTempReachedPopup(2);
              return;
            }
            var pre1 = window.preheatInProgress && window.preheatInProgress[1];
            var pre2 = window.preheatInProgress && window.preheatInProgress[2];
            var can1 = hasTR1 &&
                       (!testRunning || !testRunning[1]) &&
                       pre1 &&
                       (Date.now() - lastHeaterReadyPopupTime[1] >= HEATER_READY_DEBOUNCE_MS);
            var can2 = hasTR2 &&
                       (!testRunning || !testRunning[2]) &&
                       pre2 &&
                       (Date.now() - lastHeaterReadyPopupTime[2] >= HEATER_READY_DEBOUNCE_MS);
            if (can1) {
              lastHeaterReadyPopupTime[1] = Date.now();
              console.log('[EventSource] Received TR1 (raw) - heater ready for basket 1');
              if (typeof triggerTestStartPopup === 'function') {
                triggerTestStartPopup(1).catch(function(err) {
                  console.error('[EventSource] Error triggering test start popup for basket 1:', err);
                });
              }
              return;
            }
            if (can2) {
              lastHeaterReadyPopupTime[2] = Date.now();
              console.log('[EventSource] Received TR2 (raw) - heater ready for basket 2');
              if (typeof triggerTestStartPopup === 'function') {
                triggerTestStartPopup(2).catch(function(err) {
                  console.error('[EventSource] Error triggering test start popup for basket 2:', err);
                });
              }
              return;
            }
          }
        }
        
        // Make sure trim and forward only non-empty messages (because empty messages are useless)
        const line = (e.data || '').trim();
        if (!line) {
          // Log occasionally if we're getting too many blank messages (debugging)
          if (Math.random() < 0.01) { // Log 1% of blank messages to avoid spam
            console.debug('[EventSource] Received blank message');
          }
          return;
        }
        
        // Debug: log stroke-related messages
        if (line.includes('S1') || line.includes('S2')) {
          console.debug('[EventSource] Received stroke data:', line);
        }
        
        // Temperature data comes only from JSON type:'temps' payload above; do not parse temps from raw line.
        // Extract stroke line if present (sanitization, because we don't trust the hardware)
        const strokeLine = extractStrokeLine(line);
        const processedLine = strokeLine || line;
        
        // if HardwareAdapter exposes onData or a global handler, use it:
        if (window.HardwareAdapter && typeof window.HardwareAdapter.onData === 'function') {
          window.HardwareAdapter.onData(processedLine);
        } else {
          // dispatch a custom event for backward compatibility
          window.dispatchEvent(new CustomEvent('hardware:data', { detail: processedLine }));
        }
      };
      
      // Add connection status logging
      es.onopen = function() {
        console.log('[EventSource] Connected to /api/stream - ready to receive ESP32 messages');
      };
      
      es.onerror = function(err) {
        console.warn('[EventSource] Error or reconnection:', err);
        // EventSource automatically reconnects, but log for debugging
        // Check readyState to determine if it's a connection error or reconnection
        if (es.readyState === EventSource.CONNECTING) {
          console.log('[EventSource] Reconnecting to /api/stream...');
        } else if (es.readyState === EventSource.CLOSED) {
          console.error('[EventSource] Connection closed - will attempt to reconnect');
        }
      };
      
      // Store reference for cleanup if needed
      window._bridgeEventSource = es;
    }
  } catch (err) {
    console.error('attachBridgeStream error', err);
  }
})();



/* ========== StateMachine (centralized states) ========== */

const StateMachine = (function(){

  const states = { IDLE:'IDLE', RUNNING:'RUNNING', PAUSED:'PAUSED', HOMING:'HOMING', ERROR:'ERROR', REPORTING:'REPORTING' };

  let current = states.IDLE;

  const listeners = new Set();

  function onChange(cb){ listeners.add(cb); return ()=>listeners.delete(cb); }

  function set(state){ current = state; listeners.forEach(cb=>cb(current)); }

  function get(){ return current; }

  return { states, get, set, onChange };

})();



/* ========== Saving mutex to prevent concurrent writes ========== */

let _saving = false;

async function safeSave(key, val){

  while(_saving) await new Promise(r=>setTimeout(r,50));

  _saving = true;

  try { await StorageAdapter.set(key, val); }

  finally{ _saving = false; }

}

// ===== network helpers with timeout and retry =====

/**
 * Fetch with timeout using AbortController
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options (method, headers, body, etc.)
 * @param {number} timeoutMs - Timeout in milliseconds (default: 10000)
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      const timeoutError = new Error(`Request timeout after ${timeoutMs}ms: ${url}`);
      timeoutError.name = 'TimeoutError';
      timeoutError.url = url;
      throw timeoutError;
    }
    throw error;
  }
}

/**
 * Retry fetch with exponential backoff
 * @param {string} url - The URL to fetch
 * @param {object} options - Fetch options
 * @param {number} maxRetries - Maximum number of retries (default: 2)
 * @param {number} initialBackoffMs - Initial backoff in milliseconds (default: 1000)
 * @param {number} timeoutMs - Timeout per attempt in milliseconds (default: 10000)
 * @returns {Promise<Response>}
 */
async function retryFetch(url, options = {}, maxRetries = 2, initialBackoffMs = 1000, timeoutMs = 10000) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        // Exponential backoff: wait before retry
        const backoffMs = initialBackoffMs * Math.pow(2, attempt - 1);
        console.log(`[RetryFetch] Retry attempt ${attempt}/${maxRetries} for ${url} after ${backoffMs}ms`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
      
      const response = await fetchWithTimeout(url, options, timeoutMs);
      
      // Only retry on network errors or 5xx errors
      if (response.ok || response.status < 500) {
        return response;
      }
      
      // For 5xx errors, throw to trigger retry
      if (response.status >= 500) {
        throw new Error(`Server error ${response.status}: ${response.statusText}`);
      }
      
      return response;
    } catch (error) {
      lastError = error;
      const isRetryable = error.name === 'TimeoutError' || 
                         error.name === 'TypeError' || 
                         (error.message && error.message.includes('Failed to fetch'));
      
      if (!isRetryable || attempt >= maxRetries) {
        // Don't retry non-retryable errors or if we've exhausted retries
        if (attempt >= maxRetries) {
          console.error(`[RetryFetch] All ${maxRetries + 1} attempts failed for ${url}`, error);
        }
        throw error;
      }
      
      console.warn(`[RetryFetch] Attempt ${attempt + 1} failed for ${url}:`, error.message);
    }
  }
  
  throw lastError;
}

// ===== network helper =====
async function postJson(url, body = {}, options = {}) {
  // Check if system is initialized - block if temp scan not complete (skip for calibration to avoid blocking)
  if (!options.skipInitCheck && !requestManager.systemInitialized) {
    console.warn('[postJson] System not initialized - waiting for temperature scan...');
    // Wait for initialization (max 10 seconds)
    var waitStart = Date.now();
    while (!requestManager.systemInitialized && (Date.now() - waitStart) < 10000) {
      await new Promise(function(resolve) {
        setTimeout(resolve, 100);
      });
    }
    if (!requestManager.systemInitialized) {
      console.error('[postJson] System initialization timeout - proceeding anyway');
      requestManager.systemInitialized = true; // Unblock to prevent deadlock
    }
  }
  
  // Mark as high priority request - cancel any pending temp calls
  requestManager.isHighPriorityRequest = true;
  requestManager.cancelPendingTempRequest();
   // Enhanced logging for ESP32 commands - these will show in server terminal
   const bodyStr = JSON.stringify(body || {});
   console.log('[ESP32] ===== SENDING TO ESP32 =====');
   console.log('[ESP32] URL:', url);
   console.log('[ESP32] Command Data:', body);
   console.log('[ESP32] JSON Body:', bodyStr);
   console.log('[ESP32] ============================');
   
   try {
     // #region agent log
     fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:703',message:'postJson before fetch',data:{url:url,body:bodyStr},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
     // #endregion agent log
     const resp = await fetchWithTimeout(url, {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: bodyStr
     }, 15000); // 15 second timeout for commands
     console.log('[ESP32] Response Status:', resp.status, resp.statusText);
     // #region agent log
     fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:708',message:'postJson after fetch',data:{status:resp.status,statusText:resp.statusText,ok:resp.ok},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
     // #endregion agent log
     if (!resp.ok) {
       const err = await resp.text();
       console.error('[ESP32] ERROR - Request failed:', resp.status, err);
       console.log('[ESP32] ============================');
       // #region agent log
       fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:710',message:'postJson HTTP error',data:{status:resp.status,error:err},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
       // #endregion agent log
       return { error: err || resp.statusText };
     }
     const jsonData = await resp.json();
     console.log('[ESP32] Response Data:', jsonData);
     // #region agent log
     fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:715',message:'postJson response data',data:{jsonData:jsonData,hasOk:!!jsonData?.ok,hasCmd:!!jsonData?.cmd},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
     // #endregion agent log
     if (jsonData.cmd) {
       console.log('[ESP32] Command sent to ESP32:', jsonData.cmd);
       // #region agent log
       fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:717',message:'postJson ESP32 command',data:{cmd:jsonData.cmd},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'C'})}).catch(()=>{});
       // #endregion agent log
     }
     console.log('[ESP32] ============================');
     return jsonData;
   } catch (e) {
     console.error('[ESP32] EXCEPTION:', e, e.stack);
     console.log('[ESP32] ============================');
     // #region agent log
     fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:723',message:'postJson exception',data:{error:String(e),stack:e?.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
     // #endregion agent log
     return { error: String(e) };
   } finally {
     // Clear high priority flag after request completes
     requestManager.isHighPriorityRequest = false;
   }
 }
window.postJson = postJson;

// ===== hardware command helpers =====
/**
 * Send global STOP command to ESP32 (stops all baskets).
 * This should ONLY be used for:
 * - Validation stop (stopping hardware for validation)
 * - Logout or emergency-stop scenarios where stopping everything is desired
 * 
 * For stopping individual baskets, use sendStopForBasket(basketId) instead.
 * 
 * @param {string} context - Optional context string for logging (e.g., "validation-stop", "logout")
 * @returns {Promise<Object>} Result from stop command
 */
async function sendStopAll(context) {
  console.log('[HW] sendStopAll called' + (context ? ' from ' + context : ''));
  try {
    const result = await postJson('/api/stop');
    if (result.error) {
      console.error('[HW] sendStopAll failed:', result.error);
    } else {
      console.log('[HW] sendStopAll success:', result);
    }
    return result;
  } catch (e) {
    console.error('[HW] sendStopAll exception:', e);
    return { error: String(e) };
  }
}

async function sendStop1() {
  console.log('[HW] sendStop1 called - stopping basket 1 only');
  try {
    const result = await postJson('/api/stop1');
    if (result.error) {
      console.error('[HW] sendStop1 failed:', result.error);
    } else {
      console.log('[HW] sendStop1 success - basket 1 stopped:', result);
    }
    return result;
  } catch (e) {
    console.error('[HW] sendStop1 exception:', e);
    return { error: String(e) };
  }
}

async function sendStop2() {
  console.log('[HW] sendStop2 called - stopping basket 2 only');
  try {
    const result = await postJson('/api/stop2');
    if (result.error) {
      console.error('[HW] sendStop2 failed:', result.error);
    } else {
      console.log('[HW] sendStop2 success - basket 2 stopped:', result);
    }
    return result;
  } catch (e) {
    console.error('[HW] sendStop2 exception:', e);
    return { error: String(e) };
  }
}

/**
 * Send stop command for a specific basket.
 * Uses per-basket stop commands (STOP1/STOP2) instead of global STOP.
 * This ensures stopping one basket does not affect the other basket.
 * 
 * @param {number} basketId - Basket ID (1 or 2)
 * @returns {Promise<Object>} Result from stop command
 */
async function sendStopForBasket(basketId) {
  console.log('[HW] sendStopForBasket called for basket', basketId);
  if (basketId === 1) {
    return await sendStop1();
  } else if (basketId === 2) {
    return await sendStop2();
  } else {
    // For basket 3 or unknown, use global stop with context
    console.warn('[HW] sendStopForBasket called with unknown basketId:', basketId, '- using global stop');
    return await sendStopAll('unknown-basket-' + basketId);
  }
}

// Maintain heater state object for per-basket control
var HEATER_STATE = HEATER_STATE || {t1: 0, t2: 0};

// Send preheat for specific basket only (preserves other basket state)
async function sendPreheatForBasket(basketId, temp) {
  // Update only the specified basket in state
  HEATER_STATE = HEATER_STATE || {t1: 0, t2: 0};
  if (basketId === 1) {
    HEATER_STATE.t1 = Number(temp) || 0;
  } else if (basketId === 2) {
    HEATER_STATE.t2 = Number(temp) || 0;
  } else {
    console.error('[HW] sendPreheatForBasket: invalid basketId:', basketId);
    return { error: 'Invalid basket ID' };
  }
  
  // Use /api/preheat - sends PHW with both values so firmware receives full state
  console.log('[HW] sendPreheatForBasket - basket:', basketId, 'temp:', temp, 'state:', HEATER_STATE);
  try {
    const result = await postJson('/api/preheat', {
      h1: HEATER_STATE.t1,
      h2: HEATER_STATE.t2
    });
    if (result && result.error) {
      console.error('[HW] sendPreheatForBasket failed:', result.error);
      return { error: result.error };
    }
    console.log('[HW] sendPreheatForBasket success');
    return { ok: true, data: result };
  } catch (e) {
    console.error('[HW] sendPreheatForBasket exception:', e);
    return { error: String(e) };
  }
}

async function sendPreheat(h1, h2) {
  // CRITICAL: Always send both t1 and t2 explicitly with debug logging
  const t1 = Number(h1) || 0;
  const t2 = Number(h2) || 0;
  HEATER_STATE = {t1: t1, t2: t2}; // Update global state
  console.log('[HW] sendPreheat called - t1:', t1, 't2:', t2);
  try {
    const result = await postJson('/api/preheat', { h1: t1, h2: t2 });
    if (result.error) {
      console.error('[HW] sendPreheat failed - t1:', t1, 't2:', t2, 'error:', result.error);
    } else {
      console.log('[HW] sendPreheat success - t1:', t1, 't2:', t2, 'result:', result);
    }
    return result;
  } catch (e) {
    console.error('[HW] sendPreheat exception - t1:', t1, 't2:', t2, 'error:', e);
    return { error: String(e) };
  }
}

async function sendStartB1(temp) {
  console.log('[HW] sendStartB1 called with temp:', temp);
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:812',message:'sendStartB1 entry',data:{temp:temp,basketId:1},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion agent log
  try {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:815',message:'before postJson call',data:{endpoint:'/api/start-b1',payload:{temp:Number(temp)}},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion agent log
    const result = await postJson('/api/start-b1', { temp: Number(temp) });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:816',message:'after postJson call',data:{result:result,hasOk:!!result?.ok,hasCmd:!!result?.cmd,hasError:!!result?.error},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion agent log
    if (result.error) {
      console.error('[HW] sendStartB1 failed:', result.error);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:818',message:'sendStartB1 error path',data:{error:result.error},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion agent log
    } else {
      console.log('[HW] sendStartB1 success:', result);
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:820',message:'sendStartB1 success path',data:{result:result},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion agent log
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:821',message:'sendStartB1 return',data:{returning:result},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion agent log
    return result;
  } catch (e) {
    console.error('[HW] sendStartB1 exception:', e);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:823',message:'sendStartB1 exception',data:{error:String(e),stack:e?.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion agent log
    return { error: String(e) };
  }
}

async function sendStartB2(temp) {
  console.log('[HW] sendStartB2 called with temp:', temp);
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:828',message:'sendStartB2 entry',data:{temp:temp,basketId:2},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
  // #endregion agent log
  try {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:831',message:'before postJson call B2',data:{endpoint:'/api/start-b2',payload:{temp:Number(temp)}},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion agent log
    const result = await postJson('/api/start-b2', { temp: Number(temp) });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:832',message:'after postJson call B2',data:{result:result,hasOk:!!result?.ok,hasCmd:!!result?.cmd,hasError:!!result?.error},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
    // #endregion agent log
    if (result.error) {
      console.error('[HW] sendStartB2 failed:', result.error);
    } else {
      console.log('[HW] sendStartB2 success:', result);
    }
    return result;
  } catch (e) {
    console.error('[HW] sendStartB2 exception:', e);
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:839',message:'sendStartB2 exception',data:{error:String(e),stack:e?.stack},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion agent log
    return { error: String(e) };
  }
}

async function sendStartB3(t1, t2) {
  console.log('[HW] sendStartB3 called with t1:', t1, 't2:', t2);
  try {
    const result = await postJson('/api/start-b3', { t1: Number(t1), t2: Number(t2) });
    if (result.error) {
      console.error('[HW] sendStartB3 failed:', result.error);
    } else {
      console.log('[HW] sendStartB3 success:', result);
    }
    return result;
  } catch (e) {
    console.error('[HW] sendStartB3 exception:', e);
    return { error: String(e) };
  }
}

async function sendCalIR1(temp, skipInitCheck) { 
  console.log('[HW] sendCalIR1', temp);
  return postJson('/api/cal-ir1', { temp: Number(temp) }, skipInitCheck ? { skipInitCheck: true } : {}); 
}

async function sendCalIR2(temp, skipInitCheck) { 
  console.log('[HW] sendCalIR2', temp);
  return postJson('/api/cal-ir2', { temp: Number(temp) }, skipInitCheck ? { skipInitCheck: true } : {}); 
}

async function sendCalEXT1(temp, skipInitCheck) { 
  console.log('[HW] sendCalEXT1', temp);
  return postJson('/api/cal-ext1', { temp: Number(temp) }, skipInitCheck ? { skipInitCheck: true } : {}); 
}

async function sendCalEXT2(temp, skipInitCheck) { 
  console.log('[HW] sendCalEXT2', temp);
  return postJson('/api/cal-ext2', { temp: Number(temp) }, skipInitCheck ? { skipInitCheck: true } : {}); 
}

/* Utility: quick wrapper to patch existing code */

function applyConfigOverrides(cfg){

  if(!cfg) return;

  if(cfg.storageMode) StorageAdapter.configure({ mode: cfg.storageMode });

  if(cfg.bridgeBase) StorageAdapter.configure({ bridgeBase: cfg.bridgeBase });

  if(cfg.hardwareMode) HardwareAdapter.configure({ mode: cfg.hardwareMode });

}



/* parse stroke message helper */

function parseStrokeMsg(msg){
  if (!msg || typeof msg !== 'string') return null;
  
  msg = msg.trim();
  if (!msg) return null;

  // Support multiple formats: S1:123, S1:123,S2:456, S1=123, etc.
  if (msg.includes('S1:') || msg.includes('S2:') || msg.includes('S1=') || msg.includes('S2=')) {
    const out = {};
    
    // Try colon format first (S1:123,S2:456)
    if (msg.includes(':')) {
      const parts = msg.split(',');
      parts.forEach(p => {
        const [k, v] = p.split(':');
        if (k && v) {
          const key = k.trim();
          const val = Number(v.trim());
          if (!isNaN(val)) {
            out[key] = val;
          }
        }
      });
    }
    // Try equals format (S1=123,S2=456)
    else if (msg.includes('=')) {
      const parts = msg.split(',');
      parts.forEach(p => {
        const [k, v] = p.split('=');
        if (k && v) {
          const key = k.trim();
          const val = Number(v.trim());
          if (!isNaN(val)) {
            out[key] = val;
          }
        }
      });
    }
    
    // Return if we found at least one valid stroke reading
    if (Object.keys(out).length > 0) {
      return out; // { S1:12, S2:15 }
    }
  }

  return null;
}

/* Extract stroke line from potentially multi-line messages (sanitization helper) */
function extractStrokeLine(line){
  if (!line || typeof line !== 'string') return null;
  
  // find the first occurrence of S1: or S2: or S1= or S2=
  const idx1 = line.indexOf('S1:');
  const idx2 = line.indexOf('S2:');
  const idx3 = line.indexOf('S1=');
  const idx4 = line.indexOf('S2=');
  
  const indices = [idx1, idx2, idx3, idx4].filter(i => i !== -1);
  if (indices.length === 0) return null;
  
  const idx = Math.min(...indices);
  const sub = line.slice(idx);
  // optionally strip leading "Reply:" etc
  const clean = sub.split(/\r?\n/)[0].trim();
  
  // Only return if it actually contains stroke data
  if (clean && (clean.includes('S1') || clean.includes('S2'))) {
    return clean;
  }
  
  return null;
}



/* forward hardware data into UI events */

/* ================= Stroke Validation Live Update ================= */

let strokeValidationActive = false;
let strokeCounts = { s1: 0, s2: 0 };

function enterStrokeValidationScreen() {
  strokeValidationActive = true;
  strokeCounts = { s1: 0, s2: 0 };
  updateStrokeValidationUI();
}

function exitStrokeValidationScreen() {
  strokeValidationActive = false;
}

function updateStrokeValidationUI() {
  // Use existing stroke-counter element (adapts to current HTML structure)
  const strokeCounterEl = document.getElementById('stroke-counter');
  if (strokeCounterEl) {
    // Show the count for the active beaker
    const beakerNum = typeof validationBeaker !== 'undefined' ? validationBeaker : 1;
    const activeCount = beakerNum === 1 ? strokeCounts.s1 : strokeCounts.s2;
    strokeCounterEl.textContent = activeCount;
  }
  
  // Also update stroke-count-1 and stroke-count-2 if they exist (for future use)
  const s1 = document.getElementById('stroke-count-1');
  const s2 = document.getElementById('stroke-count-2');
  if (s1) s1.textContent = strokeCounts.s1;
  if (s2) s2.textContent = strokeCounts.s2;
}

/* REMOVED: ESP stroke reading hook - using simulated data only */
// Stroke counting now uses auto-increment in startStrokeValidationReal() only
// No ESP data parsing for strokes
const __oldOnData = HardwareAdapter.onData;

HardwareAdapter.onData = function (line) {
  // REMOVED: Stroke parsing from ESP - using simulated data only
  // Stroke counts are now managed by auto-increment interval in startStrokeValidationReal()
  if (typeof __oldOnData === 'function') {
    __oldOnData(line);
  }
};

/* ================= Recipe Time Typing ================= */

function enableRecipeTimeTyping() {
  // Find recipe duration input (adapt to existing ID)
  var recipeDurationInput = document.getElementById('recipe-duration');
  if (recipeDurationInput) {
    var scrollableParent = recipeDurationInput.closest('.scrollable');
    if (scrollableParent) {
      scrollableParent.classList.add('no-input-scroll');
    }
    recipeDurationInput.addEventListener('focus', function() {
      if (typeof openOSKForInput === 'function') {
        openOSKForInput(recipeDurationInput);
      }
    });
  }
}

/* ================= Validation Temperature Typing ================= */

function enableValidationTempTyping() {
  var tempValidationInput = document.getElementById('temp-validation-set-temp-input');
  if (tempValidationInput) {
    var scrollableParent = tempValidationInput.closest('.scrollable');
    if (scrollableParent) {
      scrollableParent.classList.add('no-input-scroll');
    }
    tempValidationInput.addEventListener('focus', function() {
      if (typeof openOSKForInput === 'function') {
        openOSKForInput(tempValidationInput);
      }
    });
  }
}

/* ================= Calibration Typing ================= */

function enableCalibrationTyping() {
  var selectors = [
    '#calibration-measured-temp-input'
  ];
  
  selectors.forEach(function(sel) {
    var input = document.querySelector(sel);
    if (!input) return;
    var scrollableParent = input.closest('.scrollable');
    if (scrollableParent) {
      scrollableParent.classList.add('no-input-scroll');
    }
    input.addEventListener('focus', function() {
      if (typeof openOSKForInput === 'function') {
        openOSKForInput(input);
      }
    });
  });
}

// PATCH 4: Call calibration typing once on page load
if (typeof document !== 'undefined' && document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    if (typeof enableCalibrationTyping === 'function') {
      enableCalibrationTyping();
    }
  });
} else {
  // DOM already loaded
  if (typeof enableCalibrationTyping === 'function') {
    enableCalibrationTyping();
  }
}

/* Manage Members helper utilities added by Cursor patch */

/* UI: centralized modal & toast */
function showModalConfirm(message){
  console.log('[showModalConfirm] Called with message:', message);
  return new Promise(resolve => {
    // create a simple confirm modal (reusable)
    const existing = document.getElementById('cursor-confirm-modal');
    if(existing){ 
      console.log('[showModalConfirm] Removing existing modal');
      existing.remove(); 
    }
    const modal = document.createElement('div');
    modal.id = 'cursor-confirm-modal';
    modal.className = 'modal active';
    modal.style.cssText = 'display: flex !important; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0, 0, 0, 0.7); z-index: 11000; justify-content: center; align-items: center;';
    modal.innerHTML = `
      <div class="modal-content" style="background: #1f2937; border-radius: 20px; padding: 32px; max-width: 600px; border: 4px solid #4b5563; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);" onclick="event.stopPropagation();">
        <h2 style="font-size:24px;font-weight:bold;margin-bottom:16px;color:white;text-align:center;">Confirm</h2>
        <p style="margin-bottom:24px;color:white;font-size:18px;text-align:center;">${message}</p>
        <div style="display:flex;gap:12px;justify-content:center;">
          <button id="cursor-confirm-cancel" class="action-btn-large bg-gray-600 hover:bg-gray-700 text-white" style="min-width:120px;padding:16px 24px;">Cancel</button>
          <button id="cursor-confirm-ok" class="action-btn-large bg-green-600 hover:bg-green-700 text-white" style="min-width:120px;padding:16px 24px;">Confirm</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    console.log('[showModalConfirm] Modal appended to body');
    
    // Use setTimeout to ensure DOM is ready
    setTimeout(() => {
      // Add click handlers
      const cancelBtn = document.getElementById('cursor-confirm-cancel');
      const okBtn = document.getElementById('cursor-confirm-ok');
      
      if (!cancelBtn || !okBtn) {
        console.error('[showModalConfirm] Buttons not found! Resolving as false');
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
        resolve(false);
        return;
      }
      
      const cleanup = () => {
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
          console.log('[showModalConfirm] Modal cleaned up');
        }
      };
      
      cancelBtn.onclick = (e) => { 
        e.stopPropagation();
        console.log('[showModalConfirm] Cancel clicked');
        cleanup(); 
        resolve(false); 
      };
      okBtn.onclick = (e) => { 
        e.stopPropagation();
        console.log('[showModalConfirm] Confirm clicked');
        cleanup(); 
        resolve(true); 
      };
      
      // Prevent clicks on modal content from bubbling to backdrop
      const modalContent = modal.querySelector('.modal-content');
      if (modalContent) {
        modalContent.onclick = (e) => {
          e.stopPropagation();
        };
      }
      
      // Also close on backdrop click
      modal.onclick = (e) => {
        if (e.target === modal) {
          console.log('[showModalConfirm] Backdrop clicked');
          cleanup();
          resolve(false);
        }
      };
      
      console.log('[showModalConfirm] Modal setup complete, waiting for user input');
    }, 10);
  });
}

// Make showModalConfirm globally accessible
window.showModalConfirm = showModalConfirm;

// Production-grade error codes with user-friendly messages (Restart the Device for equipment issues)
const ERROR_CODES = {
  ESP_DISCONNECTED: {code: 'E1001', msg: 'Internal connection to equipment failed. Please restart the device and try again.'},
  ESP_TIMEOUT: {code: 'E1002', msg: 'Equipment did not respond in time. Please restart the device and try again.'},
  ESP_PARSE_ERROR: {code: 'E1003', msg: 'Equipment data error. Please restart the equipment and try again.'},
  UNKNOWN: {code: 'E9999', msg: 'A system error occurred. Please restart the device and try again or contact support if the problem persists.'}
};

// Map error codes to user-friendly messages (because users don't speak error code)
function getErrorMessage(errorCode) {
  if (!errorCode || typeof errorCode !== 'string') {
    return 'A system error occurred. Please restart the device and try again or contact support if the problem persists.';
  }
  
  // Map ERR_ codes to friendly messages
  const errorMessages = {
    'ERR_STOP_FAILED': 'Failed to stop the test. Please try again or use the emergency stop if available.',
    'ERR_START_FAILED': 'Failed to start the test. Please check that the equipment is ready and try again.',
    'ERR_MOTOR_FAILED': 'Motor control failed. Please check the equipment connection and try again.',
    'ERR_PREHEAT_FAILED': 'Failed to start heating. Please check the heater connection and try again.',
    'ERR_TEMP_NOT_REACHED': 'Temperature did not reach the target. Please check the heater and try again.',
    'ERR_NETWORK': 'Network connection error. Please check your connection and try again.',
    'ERR_PERMISSION': 'You do not have permission to perform this action. Please contact your administrator.',
    'ERR_LOGIN_FAILED': 'Login failed. Please check your User ID and Password and try again.',
    'ERR_INVALID_INPUT': 'Invalid input. Please check your entries and try again.',
    'ERR_DUPLICATE_ID': 'This Employee ID already exists. Please use a different ID.',
    'ERR_ADD_MEMBER_FAILED': 'Failed to add member. Please check all fields and try again.'
  };
  
  // Check if it's an ERR_ code
  if (errorCode.startsWith('ERR_')) {
    return errorMessages[errorCode] || 'An error occurred. Please try again.';
  }
  
  // Map E-codes to user-friendly messages (with Restart the Device where applicable)
  var eCodeMap = {
    'E1001': 'Internal connection to equipment failed. Please restart the device and try again.',
    'E1002': 'Equipment did not respond in time. Please restart the device and try again.',
    'E1003': 'Equipment data error. Please restart the equipment and try again.',
    'E9999': 'A system error occurred. Please restart the device and try again or contact support if the problem persists.',
    'E2001': 'Heater parameters are missing. Please check settings and try again or restart the device.',
    'E3001': 'Report data is missing. Please try again.',
    'E3002': 'Could not generate report. Please try again.',
    'E3004': 'Report file is too large. Maximum size is 50 MB.',
    'E4001': 'Pendrive not detected. Please connect the pendrive and restart the device.',
    'E3003': 'USB drive not detected. Please plug in the USB drive and try again.'
  };
  var eMatch = errorCode.match(/^(E\d{4})/);
  if (eMatch && eCodeMap[eMatch[1]]) {
    return eCodeMap[eMatch[1]];
  }
  
  // Check if it's an E code (like E1001: message)
  if (errorCode.includes(':')) {
    var parts = errorCode.split(':');
    if (parts.length >= 2) {
      return parts.slice(1).join(':').trim(); // Return the message part
    }
  }
  
  // If it already looks like a friendly message, return as-is
  if (!errorCode.startsWith('ERR_') && !errorCode.startsWith('E')) {
    return errorCode;
  }
  
  // Default fallback
  return 'Something went wrong. Please restart the device and try again or contact support if the problem persists.';
}

// Error code mapping function
function getErrorCode(errorMessage) {
  if (!errorMessage || typeof errorMessage !== 'string') {
    return ERROR_CODES.UNKNOWN.code + ': ' + ERROR_CODES.UNKNOWN.msg;
  }
  
  const msg = errorMessage.toLowerCase();
  
  // Map hardware errors to production codes
  if (msg.includes('esp not connected') || msg.includes('not reading from esp') || msg.includes('serial') || msg.includes('uart') || msg.includes('esp') && (msg.includes('error') || msg.includes('failed') || msg.includes('disconnect'))) {
    return ERROR_CODES.ESP_DISCONNECTED.code + ': ' + ERROR_CODES.ESP_DISCONNECTED.msg;
  }
  if (msg.includes('timeout')) {
    return ERROR_CODES.ESP_TIMEOUT.code + ': ' + ERROR_CODES.ESP_TIMEOUT.msg;
  }
  if (msg.includes('parse') || msg.includes('corrupt') || msg.includes('invalid data')) {
    return ERROR_CODES.ESP_PARSE_ERROR.code + ': ' + ERROR_CODES.ESP_PARSE_ERROR.msg;
  }
  
  // Map common error messages to error codes
  // Export / USB / pendrive errors must NOT be misclassified as "start test failed".
  // NOTE: "restart" contains "start" as a substring, so avoid msg.includes('start') for start-test mapping.
  if (msg.includes('pendrive')) {
    return 'E4001';
  }
  if (
    (msg.includes('usb') && msg.includes('drive') && (msg.includes('not detected') || msg.includes('not found') || msg.includes('not mounted'))) ||
    msg.includes('export drive not mounted')
  ) {
    return 'E3003';
  }
  if (msg.includes('temperature') && (msg.includes('not reached') || msg.includes('not reach'))) {
    return 'ERR_TEMP_NOT_REACHED';
  }
  if (msg.includes('stop command') && msg.includes('failed')) {
    return 'ERR_STOP_FAILED';
  }
  if (msg.includes('motor') && (msg.includes('failed') || msg.includes('error'))) {
    return 'ERR_MOTOR_FAILED';
  }
  if (msg.includes('preheat') && (msg.includes('failed') || msg.includes('error'))) {
    return 'ERR_PREHEAT_FAILED';
  }
  // Start-test errors: match "start" as a word or known phrases, not substring in "restart".
  const hasStartWord = /\bstart\b/.test(msg);
  const looksLikeStartTest =
    msg.includes('failed to start') ||
    msg.includes('start test') ||
    msg.includes('start command') ||
    (hasStartWord && msg.includes('test'));
  if (looksLikeStartTest && (msg.includes('failed') || msg.includes('error'))) {
    return 'ERR_START_FAILED';
  }
  if (msg.includes('network') || msg.includes('fetch') || msg.includes('connection')) {
    return 'ERR_NETWORK';
  }
  if (msg.includes('permission') || msg.includes('access denied')) {
    return 'ERR_PERMISSION';
  }
  if (msg.includes('login') && (msg.includes('failed') || msg.includes('invalid'))) {
    return 'ERR_LOGIN_FAILED';
  }
  if (msg.includes('timeout')) {
    return ERROR_CODES.ESP_TIMEOUT.code + ': ' + ERROR_CODES.ESP_TIMEOUT.msg;
  }
  
  // If message already looks like an error code (starts with ERR_ or E), return as-is
  if (msg.startsWith('err_') || msg.startsWith('e1') || msg.startsWith('e9')) {
    return errorMessage;
  }
  
  // Default: return generic error code
  return ERROR_CODES.UNKNOWN.code + ': ' + ERROR_CODES.UNKNOWN.msg;
}

function showToast(msg, type='info', duration=2500){
  // Convert error messages to user-friendly messages (because users deserve clarity)
  let displayMsg = msg;
  if (type === 'error') {
    // FIX: Do NOT convert login errors - show exact message to avoid generic "Unexpected error"
    if (msg.includes('Login failed:') || msg.includes('storage or system error') || 
        msg.includes('Invalid username or password') || msg.includes('Invalid username') || 
        msg.includes('Invalid password') || msg === 'Invalid username or password') {
      displayMsg = msg; // Use exact message for login errors
    } else if (
      msg.startsWith('ERR_') &&
      !msg.includes('Login failed') &&
      !msg.includes('storage or system error') &&
      !msg.includes('Invalid username') &&
      !msg.includes('Invalid password')
    ) {
      // FIX: Prevent already-processed login errors from being reinterpreted
      displayMsg = getErrorMessage(msg);
    } else {
      // Convert error message to code, then to friendly message
      // FIX: Skip conversion for login-related invalid messages
      const msgLower = msg.toLowerCase();
      if (msgLower.includes('invalid username') || msgLower.includes('invalid password') || 
          msgLower.includes('invalid username or password')) {
        displayMsg = msg; // Keep original message for login errors
      } else {
        var errorCode = getErrorCode(msg);
        displayMsg = getErrorMessage(errorCode);
      }
    }
  }
  
  // simple toast at bottom-right
  const id = 'cursor-toast';
  let t = document.getElementById(id);
  if(!t){
    t = document.createElement('div'); t.id = id;
    t.style.position = 'fixed'; t.style.right='24px'; t.style.bottom='24px';
    t.style.zIndex = 11000; t.style.pointerEvents='auto';
    document.body.appendChild(t);
  }
  const el = document.createElement('div');
  el.style.marginTop = '8px';
  el.style.padding = '12px 18px';
  el.style.borderRadius = '12px';
  el.style.minWidth = '220px';
  el.style.boxShadow = '0 8px 24px rgba(0,0,0,0.4)';
  el.style.color = 'white';
  el.style.fontWeight = '600';
  el.style.background = type==='error' ? '#ef4444' : (type==='success' ? '#10b981' : '#111827');
  el.innerText = displayMsg;
  t.appendChild(el);
  setTimeout(()=>{ el.style.opacity = '0'; setTimeout(()=>el.remove(),400); }, duration);
}

// ========== ROLE-BASED ACCESS CONTROL (RBAC) ==========
// This is where we decide who can do what (because not everyone should have admin powers)
// Default behavior: ALLOW everything unless explicitly restricted (because being restrictive is annoying)
// Restrictions are stored as: { featureKey: 'restriction-type' }
// Restriction types: 'no-access', 'view-only', 'edit-blocked'

// TODO: Parse user acesses.xlsx and populate this structure (because manual entry is tedious)
// ========== ROLE-BASED ACCESS CONTROL (RBAC) ==========
// 
// IMPORTANT: This structure defines RESTRICTIONS, not permissions (because we're optimists by default).
// Default behavior: Everything is ALLOWED unless explicitly restricted here (because saying "no" is more work).
// 
// To populate from Excel file "user acesses.xlsx":
// 1. Read the Excel file and identify columns: Role, Feature/Screen/Action, Access/Restriction
// 2. For each row where Access = "No Access" or similar restriction:
//    - Add the feature key to the role's restriction object
//    - Use restriction types: 'no-access', 'view-only', 'edit-blocked'
// 3. Map Excel feature names to internal feature keys (see SCREEN_FEATURE_MAP and ACTION_FEATURE_MAP)
//
// Example Excel row: "Supervisor | Factory Settings | No Access"
//   → Add: 'Supervisor': { 'factory-settings': 'no-access' }
//
// Example Excel row: "User | Reports | View Only"
//   → Add: 'User': { 'reports': 'view-only' }
//
// Restriction types:
//   - 'no-access': Completely blocks access (navigation + UI hidden)
//   - 'view-only': Allows viewing but blocks editing actions (save, delete, etc.)
//   - 'edit-blocked': Similar to view-only, blocks edit/delete/save actions
//
// Restriction codes:
// - "no-access"   → cannot open screen / cannot perform action
// - "view-only"   → can open screen but cannot modify / save / delete
// Anything not mentioned for a role is ALLOWED by default.
var ROLE_RESTRICTIONS = {
  admin: {
    // Admin: Factory settings disabled (because even admins shouldn't mess with factory settings)
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',  // Only factory role can reset
  },
  supervisor: {
    // USER MANAGEMENT (because supervisors shouldn't be able to mess with user accounts)
    'user-manage': 'view-only',      // Can view members list but cannot edit/add/delete users (because power corrupts).
    'user-add': 'no-access',        // Cannot open Add Member screen (because we don't trust them that much).
    'user-delete': 'no-access',     // Custom action key: cannot delete users (because deletion is permanent).
    'user-change-role': 'no-access',// Custom action key: cannot change user roles (because role changes are serious business).
    
    // SETTINGS / FACTORY (because factory settings are sensitive)
    'factory-settings': 'view-only', // Can view but not save changes (because we don't want them breaking things).
    'factory-reset': 'no-access',    // Only factory role can reset
    'edit-datetime': 'no-access',    // Cannot edit date and time (only admin and factory can).
    
    // REPORTS (because reports are important)
    'reports-delete': 'no-access',  // Cannot delete reports (because we need audit trails).
    
    // RECIPES (because recipes are recipes)
    'recipe-delete': 'no-access',   // Cannot delete recipes (because someone might need that recipe later).
    
    // VALIDATION / CALIBRATION
    // Supervisor CAN run validation & calibration → no restriction entries here (because they need to do their job).
  },
  user: {
    // USER MANAGEMENT
    'user-manage': 'no-access',
    'user-add': 'no-access',
    'user-delete': 'no-access',
    'user-change-role': 'no-access',
    
    // SETTINGS / FACTORY
    // User CAN open Settings screen, but specific items are restricted below
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',    // Only factory role can reset
    'edit-datetime': 'no-access',    // Cannot edit date and time (only admin and factory can).
    // User CAN now access heater control
    
    // RECIPES
    // User CAN create and edit recipes
    'recipe-delete': 'no-access',   // Cannot delete recipes.
    // User CAN view recipe list, create, edit, and run tests using recipes.
    
    // REPORTS
    'reports-delete': 'no-access',  // Cannot delete reports.
    // User CAN view and print/export reports (view only).
    
    // VALIDATION / CALIBRATION
    'validate-temp-calibration': 'no-access', // Cannot perform calibration, only run validation and record Pass/Fail.
  },
  factory: {
    // Factory has full access: no restrictions
    // (Keep object empty intentionally - same as Admin)
    // Explicitly allow all features including add/edit members
  }
};

// Map screen IDs to feature keys for access control
var SCREEN_FEATURE_MAP = {
  'login': 'login',
  'dashboard': 'dashboard',
  'profile': 'profile',
  'validate-select': 'validate-menu',
  'validate-type-select': 'validate-menu',
  'stroke-validation': 'validate-stroke',
  'temp-validation': 'validate-temp',
  'temp-calibration-input': 'validate-temp-calibration',
  'calibration': 'validate-temp-calibration',
  'reports': 'reports-view',
  'report-preview': 'reports-view',
  'settings': 'settings',
  'factory-settings': 'factory-settings',
  'heater-control': 'heater-control',
  'recipe-list': 'recipe-list',
  'create-recipe': 'recipe-edit',
  'add-beakers': 'beaker-setup',
  'add-baskets': 'basket-setup',
  'manage-members': 'user-manage',
  'add-members': 'user-add',
  'edit-date-time': 'edit-datetime'
};

// Map action names to feature keys for function-level access control
var ACTION_FEATURE_MAP = {
  'add-member': 'add-members',
  'delete-member': 'manage-members',
  'change-role': 'manage-members',
  'edit-member': 'manage-members',
  'save-factory-settings': 'factory-settings',
  'save-recipe': 'create-recipe',
  'delete-recipe': 'create-recipe',
  'edit-recipe': 'create-recipe',
  'start-validation': 'validate',
  'start-test': 'validate',
  'start-temperature-validation': 'validate-temp',
  'start-stroke-validation': 'validate-stroke',
  'calibrate-temperature': 'calibration',
  'export-reports': 'reports',
  'print-report': 'reports-preview',
  'delete-report': 'reports',
  'save-profile': 'profile'
};

// RBAC Helper Functions (because checking permissions should be easy, not a pain)
function getCurrentRole() {
  var role = null;
  if (window.currentUser && window.currentUser.role) {
    role = window.currentUser.role;
  } else if (currentUser && currentUser.role) {
    role = currentUser.role;
  }
  // Normalize role to lowercase for consistent comparison
  return role ? String(role).toLowerCase() : null;
}

// Get restriction for a role and feature (returns restriction type or null)
function getRestriction(role, featureKey) {
  if (!role || !featureKey) return null;
  var normRole = String(role).toLowerCase();
  var roleRules = ROLE_RESTRICTIONS[normRole] || {};
  return roleRules[featureKey] || null;
}

// Check if a feature is restricted (returns true if restricted, false if allowed)
function isFeatureRestricted(role, featureKey) {
  return !!getRestriction(role, featureKey);
}

// Check if user can access a feature (returns true if allowed, false if blocked)
function canAccess(role, featureKey) {
  if (!role || !featureKey) return false;
  var normRole = String(role).toLowerCase();
  // Factory and Admin users have full access to all features
  if (normRole === 'factory' || normRole === 'admin') {
    return true;
  }
  
  var restriction = getRestriction(normRole, featureKey);
  if (!restriction) return true;              // default allow
  if (restriction === 'no-access') return false;
  // 'view-only' still counts as "can access screen", but actions must be blocked separately.
  return true;
}

// Check if feature is view-only
function isViewOnly(role, featureKey) {
  return getRestriction(role, featureKey) === 'view-only';
}

// Check if user can perform an action (edit, delete, etc.)
function canPerformAction(role, featureKey, action) {
  if (!role) return false;
  var normRole = String(role).toLowerCase();
  
  // Factory and Admin users can perform all actions
  if (normRole === 'factory' || normRole === 'admin') {
    return true;
  }
  
  var restriction = getRestriction(normRole, featureKey);
  if (!restriction) return true; // No restriction = allow all actions
  
  if (restriction === 'no-access') return false;
  if (restriction === 'view-only') {
    // View-only allows viewing but blocks editing actions
    var editActions = ['edit', 'delete', 'create', 'save', 'change', 'calibrate', 'start'];
    return editActions.indexOf(action.toLowerCase()) === -1;
  }
  if (restriction === 'edit-blocked') {
    // Edit-blocked allows viewing but blocks editing
    var editActions = ['edit', 'delete', 'save', 'change'];
    return editActions.indexOf(action.toLowerCase()) === -1;
  }
  return true; // Other restrictions - allow by default
}

// ========== GLOBAL VARIABLES ==========
// All the state we need to keep track of (because stateless is overrated)
var currentUser = null;
var modalCallback = null;
var use24Hour = true;
var basketConfig = 6;
var configuredBeakers = {1: false, 2: false};
var basketModes = {1: 'manual', 2: 'manual'};
var heaterOn = {1: false, 2: false};
var setTemp = {1: 37.0, 2: 37.0};
var testRunning = {1: false, 2: false};
var testStartTime = {};
var holeCompletionTimes = {};
var currentRunVesselTimes = {}; // Track vessel completion times: { vesselIndex: timestampISO }
var recordedTemps = {1: [], 2: []}; // Track temperature readings during tests: [{t:timestamp, basket1:xx, basket2:yy, ...}, ...]
var selectedBeakerForConfig = null;
var selectedHolesForConfig = [];
var editingRecipeId = null;
var validationBeaker = null;
var validationType = null;
var strokeCount = 0;
var tempData = [];
var tempOffset = null;
// Per-basket stroke reading tracking (replaces single lastStrokeReading)
var lastStrokeReadingByBasket = {1: 0, 2: 0};
var lastStrokeReading = 0; // Keep for backward compatibility during migration
var tempValidationInterval = null;
var isCalibrating = false;
var timers = {1: {running: false, secs: 0, interval: null}, 2: {running: false, secs: 0, interval: null}};
var preheatInProgress = {1: false, 2: false, 3: false};
var basketHoles = {1: {}, 2: {}};
var logoTapCount = 0;
var calibrationTimer = null;
var calibrationStartTime = null;
var calibrationInterval = null;
var basketProducts = {1: null, 2: null}; // Store product names per basket
var basketBatches = {1: null, 2: null}; // Store batch numbers per basket
var basketDurations = {1: null, 2: null}; // Store recipe duration per basket (in minutes)
var calibrationOffsets = {1: 0, 2: 0}; // Per-basket temperature calibration offsets
var tempValidationTimer = null; // Timer for 5-minute temperature validation
var tempValidationStartTime = null; // Start time for temperature validation
var tempValidationInterval = null; // Interval for updating measured temperature during validation
var tempValidationSetTemp = 37.0; // User-set temperature for validation
var MAX_TEMP_C = 55; // Maximum allowed temperature for recipes and heater settings (°C)
var tempValidationElapsedStarted = false; // Whether elapsed time counting has started (after reaching set temp)
var lastTempValidationMaxDeviation = 0; // Max deviation over 2-minute holding period
var lastTempValidationMinTemp = null; // Min raw temp during hold (for report)
var lastTempValidationMaxTemp = null; // Max raw temp during hold (for report)
var tempValidationRunning = false; // Track if temperature validation is currently running
var tempValidationPreheatArmed = false; // True when Apply set temp succeeded - waiting for TR to start 2-min holding
var tempValidationTempPollInterval = null; // 1s interval to refresh measured temp from latestTemps during preheat/holding
var VALIDATION_HOLD_DURATION_SEC = 2 * 60; // 2 minutes holding
var VALIDATION_DEVIATION_LIMIT = 0.5; // ±0.5°C for pass/fail

// Stroke validation globals (because we need to track real strokes from ESP32)
var strokeValidationInterval = null; // Interval for 60-second validation timer
var strokeValidationEventSource = null; // Screen-specific EventSource for /api/stream
var strokeValidationStartTime = null; // Start time for 60-second validation
var lastStrokeReading = 0; // Last stroke count read from ESP32
var strokeValidationListener = null; // Event listener for hardware:data (if used)
var validationCompletionInProgress = false; // Guard to prevent duplicate completeValidation calls

// Initialize tempOffset asynchronously
(function() {
  (async function() {
    var val = await StorageAdapter.get('tempOffset');
    tempOffset = val !== null ? parseFloat(val) : parseFloat((Math.random() * 3 - 1.5).toFixed(2));
})();
})();

// FIXED: Updated screens list - matches all actual screen IDs
var screens = [
    'login','dashboard','profile','validate-select','validate','validate-type-select','stroke-validation','temp-validation','calibration',
    'reports','report-preview','settings','heater-control','factory-settings',
  'add-beakers','add-baskets','add-members','manage-members','recipe-list','create-recipe','temp-calibration-input','edit-date-time'
];

// ========== HELPER: Check if user is protected factory user ==========
function isProtectedFactoryUser(user) {
  if (!user) return false;
  const username = (user.username || user.user || '').toString().toUpperCase();
  return username === 'RLERLT';
}

// ========== INITIALIZE USERS ==========
// Set up default users if we don't have any (because empty systems are sad systems)
async function initUsers() {
  var existingUsers = await StorageAdapter.get('users');
    if (!existingUsers) {
    var defaultUsers = [
            { username: 'Admin', password: 'admin123', role: 'Admin', name: 'Administrator' },
            { username: 'RLERLT', password: 'Rahul', role: 'Factory', name: 'Factory User' }
        ];
        await safeSave('users', defaultUsers);
    } else {
    var users = existingUsers || [];
    var factoryUser = null;
    for (var i = 0; i < users.length; i++) {
      if (users[i].role === 'Factory') {
        factoryUser = users[i];
        break;
      }
    }
        if (factoryUser) {
            factoryUser.username = 'RLERLT';
            factoryUser.password = 'Rahul';
            await safeSave('users', users);
        }
    }
}

// ========== USER MANAGEMENT ==========
async function handleLogin(event) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3266',message:'handleLogin entry',data:{loginInProgress:loginInProgress,hasEvent:!!event},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
    // #endregion agent log
    // FIX: Prevent form auto-submission and duplicate execution
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    
    // FIX: Prevent duplicate execution - critical for Raspberry Pi slow I/O
    if (loginInProgress) {
      console.warn('[Login] Duplicate login attempt blocked');
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3274',message:'duplicate login blocked',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'A'})}).catch(()=>{});
      // #endregion agent log
      return;
    }
    
    loginInProgress = true;
    var loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
      loginBtn.disabled = true;
    }
    console.log('[LOGIN] Attempt started at', new Date().toISOString());
    
    try {
    // FIX: Check backend readiness before attempting login
    const backendReady = await checkBackendReady();
    if (!backendReady) {
      if (typeof showToast === 'function') {
        showToast('System is starting. Please wait a few seconds.', 'error');
      } else if (typeof showModal === 'function') {
        showModal('System is starting. Please wait a few seconds.');
      } else {
        alert('System is starting. Please wait a few seconds.');
      }
      loginInProgress = false;
      return;
    }
    
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    if (!uidEl || !pwdEl) {
      if (typeof showModal === 'function') {
        showModal('Login form not found');
      }
      loginInProgress = false; // Reset guard on early return
      return;
    }
    var uid = uidEl.value ? uidEl.value.trim() : '';
    var pwd = pwdEl.value ? pwdEl.value : '';
        
        if (!uid || !pwd) {
      if (typeof showModal === 'function') {
            showModal('Please enter User ID and Password');
      }
            loginInProgress = false; // Reset guard on early return
            return;
        }
        
    var users;
        try {
            users = await StorageAdapter.get('users') || [];
        } catch (e) {
            console.error('[Login] Error loading users:', e);
            // FIX: Improved error detection with clearer messages
            let errorMsg = 'Login service unavailable. Please try again.';
            
            // Backend not running / unreachable
            if (e instanceof TypeError && e.message && e.message.includes('fetch')) {
              errorMsg = 'Backend service is not running. Please restart the system.';
            }
            // API responded but returned error
            else if (e && e.message && e.message.includes('Failed to fetch')) {
              errorMsg = 'Cannot reach system services. Check backend status.';
            }
            // JSON / API corruption
            else if (e && e.message && e.message.includes('Unexpected token')) {
              errorMsg = 'System data corrupted. Please restart the device.';
            }
            // 4xx error
            else if (e && e.message && e.message.includes('4') || (e.response && e.response.status >= 400 && e.response.status < 500)) {
              errorMsg = 'Invalid username or password';
            }
            // 5xx error
            else if (e && e.message && e.message.includes('5') || (e.response && e.response.status >= 500)) {
              var code = (e && e.error) ? e.error : 'Exxxx';
              errorMsg = 'System error, contact admin (code ' + code + ')';
            }
            
      if (typeof showToast === 'function') {
            showToast(errorMsg, 'error');
      } else if (typeof showModal === 'function') {
            showModal(errorMsg);
      } else {
            alert(errorMsg);
      }
            loginInProgress = false; // Reset guard on early return
            return;
        }
        
        if (!users || users.length === 0) {
            try {
              await initUsers();
              users = await StorageAdapter.get('users') || [];
            } catch (initError) {
              console.error('[Login] Error initializing users:', initError);
              // Continue with empty users array - will show invalid credentials
              users = [];
            }
        }
        
    var user = null;
    for (var i = 0; i < users.length; i++) {
      var u = users[i];
            if (u.role === 'Factory') {
        if (u.username === uid && u.password === pwd) {
          user = u;
          break;
        }
            } else {
        var uUsername = u.username ? u.username.toLowerCase() : '';
        var uPwd = u.password || '';
        if (uUsername === uid.toLowerCase() && uPwd === pwd) {
          user = u;
          break;
        }
      }
    }
        
        if (user) {
            currentUser = user;
            window.currentUser = user; // Set on window for RBAC functions
            try {
              await safeSave('currentUser', currentUser);
            } catch (saveError) {
              console.error('[Login] Error saving currentUser:', saveError);
              // Continue anyway - user is still logged in
            }
      if (typeof updateUIForUser === 'function') {
            try {
              updateUIForUser();
            } catch (uiError) {
              console.error('[Login] Error updating UI for user:', uiError);
              // Continue anyway - navigation will still work
            }
      }
      // PATCH 6: Apply role guards after login (GUARANTEED)
      if (typeof applyRoleGuards === 'function') {
        try {
          applyRoleGuards();
        } catch (guardError) {
          console.warn('[Login] Error applying role guards:', guardError);
            }
      }
      console.log('[Login] User authenticated, navigating to dashboard');
      // #region agent log
      fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3415',message:'user authenticated, about to navigate',data:{hasNavigateTo:typeof navigateTo === 'function',hasWindowNavigateTo:typeof window.navigateTo === 'function'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion agent log
      setTimeout(function() {
        try {
          console.log('[Login] Attempting navigation, navigateTo type:', typeof navigateTo, 'window.navigateTo type:', typeof window.navigateTo);
          // #region agent log
          fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3418',message:'navigation attempt',data:{hasNavigateTo:typeof navigateTo === 'function',hasWindowNavigateTo:typeof window.navigateTo === 'function'},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
          // #endregion agent log
          if (typeof window.navigateTo === 'function') {
            console.log('[Login] Calling window.navigateTo("dashboard")');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3420',message:'calling window.navigateTo',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
            // #endregion agent log
            window.navigateTo('dashboard');
          } else if (typeof navigateTo === 'function') {
            console.log('[Login] Calling navigateTo("dashboard")');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3423',message:'calling navigateTo',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
            // #endregion agent log
            navigateTo('dashboard');
          } else {
            console.error('[Login] navigateTo function not found!');
            // #region agent log
            fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3426',message:'navigateTo not found',data:{},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
            // #endregion agent log
            // Fallback: try to show dashboard screen directly
            var dashboardScreen = document.getElementById('screen-dashboard');
            var loginScreen = document.getElementById('screen-login');
            if (dashboardScreen && loginScreen) {
              loginScreen.classList.remove('active');
              dashboardScreen.classList.add('active');
            }
          }
        } catch (navError) {
          console.error('[Login] Error during navigation:', navError);
          // Fallback: try to show dashboard screen directly
          try {
            var dashboardScreen = document.getElementById('screen-dashboard');
            var loginScreen = document.getElementById('screen-login');
            if (dashboardScreen && loginScreen) {
              loginScreen.classList.remove('active');
              dashboardScreen.classList.add('active');
            }
          } catch (fallbackError) {
            console.error('[Login] Fallback navigation also failed:', fallbackError);
            if (typeof showModal === 'function') {
              showModal('Login successful but navigation failed. Please refresh the page.');
            } else {
              alert('Login successful but navigation failed. Please refresh the page.');
            }
          }
        }
            }, 100);
        } else {
      // CHANGED: Standardize login failure message
      if (typeof showToast === 'function') {
            showToast('Invalid username or password', 'error');
      } else if (typeof showModal === 'function') {
            showModal('Invalid username or password');
      } else {
            alert('Invalid username or password');
      }
        }
    } catch (e) {
      // FIX: Allow offline mode fallback when backend is unavailable
      console.warn('[Login] Backend unavailable, entering offline mode', e);
      
      // Get uid from form if available (for offline user creation)
      var uidEl = document.getElementById('login-uid');
      var uid = uidEl ? (uidEl.value ? uidEl.value.trim() : '') : 'OfflineUser';
      
      // Allow offline login fallback
      const offlineUser = {
        username: uid,
        role: 'Factory', // safe default
        offline: true
      };
      
      window.currentUser = offlineUser;
      window.currentRole = offlineUser.role;
      
      if (typeof showToast === 'function') {
        showToast('System running in offline mode', 'warning');
      } else if (typeof showModal === 'function') {
        showModal('System running in offline mode');
      } else {
        alert('System running in offline mode');
      }
      
      // Continue to dashboard
      if (typeof navigateTo === 'function') {
        navigateTo('dashboard');
      } else if (typeof window.navigateTo === 'function') {
        window.navigateTo('dashboard');
      } else {
        // Fallback: try to show dashboard screen directly
        var dashboardScreen = document.getElementById('screen-dashboard');
        var loginScreen = document.getElementById('screen-login');
        if (dashboardScreen && loginScreen) {
          loginScreen.classList.remove('active');
          dashboardScreen.classList.add('active');
        }
      }
      
      loginInProgress = false;
      var loginBtn = document.getElementById('login-btn');
      if (loginBtn) {
        loginBtn.disabled = false;
      }
      return;
    } finally {
      // FIX: Hard safety reset - prevents permanent lock
      setTimeout(() => {
        loginInProgress = false;
        var loginBtn = document.getElementById('login-btn');
        if (loginBtn) {
          loginBtn.disabled = false;
        }
        console.log('[LOGIN] Guard reset');
      }, 300);
    }
}

function updateUIForUser() {
  try {
    if (!currentUser) return;
    
    var role = null;
    try {
      if (typeof getCurrentRole === 'function') {
        role = getCurrentRole();
      } else {
        role = currentUser.role || null;
      }
    } catch (e) {
      console.warn('[updateUIForUser] Error getting role:', e);
      role = currentUser.role || null;
    }
    
    // Update profile information
    var profileNameEl = document.getElementById('profile-name');
    var profileRoleEl = document.getElementById('profile-role');
    var profileEditNameEl = document.getElementById('profile-edit-name');
    var sidebarProfileEl = document.getElementById('sidebar-profile');
    
    if (profileNameEl) profileNameEl.textContent = currentUser.name || '';
    if (profileRoleEl) profileRoleEl.textContent = currentUser.role || '';
    if (profileEditNameEl) profileEditNameEl.value = currentUser.name || '';
    if (sidebarProfileEl) {
      try {
        sidebarProfileEl.innerHTML = '<i data-lucide="user"></i><span>' + (currentUser.name || '') + '</span>';
        // Re-initialize lucide icons if available
        if (window.lucide && typeof lucide.createIcons === 'function') {
          lucide.createIcons();
        }
      } catch (e) {
        console.warn('[updateUIForUser] Error updating sidebar profile:', e);
      }
    }
    
    // Profile admin buttons - show only if user can access user-manage or user-add
    try {
      var adminButtons = document.getElementById('profile-admin-buttons');
      if (adminButtons) {
        var normRole = role ? String(role).toLowerCase() : null;
        var isAdminOrFactory = normRole === 'admin' || normRole === 'factory';
        var canManage = false;
        var canAdd = false;
        try {
          if (typeof canAccess === 'function') {
            canManage = isAdminOrFactory && canAccess(role, 'user-manage');
            canAdd = isAdminOrFactory && canAccess(role, 'user-add');
          }
        } catch (e) {
          console.warn('[updateUIForUser] Error checking access:', e);
        }
        if (canManage || canAdd) {
          adminButtons.style.display = 'grid';
          // Hide individual buttons if not allowed
          var manageBtn = adminButtons.querySelector('[onclick*="manage-members"]');
          var addBtn = adminButtons.querySelector('[onclick*="add-members"]');
          if (manageBtn) manageBtn.style.display = canManage ? '' : 'none';
          if (addBtn) addBtn.style.display = canAdd ? '' : 'none';
        } else {
          adminButtons.style.display = 'none';
        }
      }
    } catch (e) {
      console.warn('[updateUIForUser] Error updating admin buttons:', e);
    }
      
    try {
      var passwordGroup = document.getElementById('profile-password-group');
      if (passwordGroup) {
        var normRole = role ? String(role).toLowerCase() : null;
        if (normRole === 'factory') {
          passwordGroup.style.display = 'none';
        } else {
          passwordGroup.style.display = 'block';
        }
      }
    } catch (e) {
      console.warn('[updateUIForUser] Error updating password group:', e);
    }
      
    try {
      var reportOperatorEl = document.getElementById('report-operator-name');
      var reportOperatorIdEl = document.getElementById('report-operator-id');
      if (reportOperatorEl) {
        reportOperatorEl.textContent = currentUser.name || '';
      }
      if (reportOperatorIdEl) {
        reportOperatorIdEl.textContent = currentUser.username || '';
      }
    } catch (e) {
      console.warn('[updateUIForUser] Error updating report operator:', e);
    }
  } catch (e) {
    console.error('[updateUIForUser] Unexpected error:', e);
    // Don't throw - just log the error so login can continue
  }
  
  // Define UI elements and their corresponding feature keys
  var items = [
    { id: 'menu-settings', feature: 'settings' },
    { id: 'menu-factory-settings', feature: 'factory-settings' },
    { id: 'menu-heater-control', feature: 'heater-control' },
    { id: 'menu-manage-members', feature: 'user-manage' },
    { id: 'menu-add-members', feature: 'user-add' },
    { id: 'menu-recipe-list', feature: 'recipe-list' },
    { id: 'menu-validate', feature: 'validate-menu' },
    { id: 'menu-reports', feature: 'reports-view' },
    { id: 'sidebar-validate', feature: 'validate-menu' },
    { id: 'sidebar-reports', feature: 'reports-view' },
    { id: 'sidebar-settings', feature: 'settings' },
    { id: 'sidebar-factory-settings', feature: 'factory-settings' },
    { id: 'btn-add-member', feature: 'user-add' },
    { id: 'btn-save-factory-settings', feature: 'factory-settings' },
    { id: 'btn-create-recipe', feature: 'recipe-edit' },
    { id: 'btn-delete-recipe', feature: 'recipe-delete' },
    { id: 'btn-delete-report', feature: 'reports-delete' },
    { id: 'btn-temp-calibrate', feature: 'validate-temp-calibration' },
    // Also check by selector for buttons that might not have IDs
    { selector: '[onclick*="addMember()"]', feature: 'user-add' },
    { selector: '[onclick*="navigateTo(\'add-members\')"]', feature: 'user-add' },
    { selector: '[onclick*="navigateTo(\'manage-members\')"]', feature: 'user-manage' },
    { selector: '[onclick*="navigateTo(\'create-recipe\')"]', feature: 'recipe-edit' },
    { selector: '[onclick*="navigateToCreateRecipe"]', feature: 'recipe-edit' },
    { selector: '[onclick*="deleteRecipe"]', feature: 'recipe-delete' },
    { selector: '[onclick*="calibrateTemperatureSensor"]', feature: 'validate-temp-calibration' },
    { selector: '[onclick*="navigateTo(\'temp-calibration-input\')"]', feature: 'validate-temp-calibration' }
  ];
  
  items.forEach(function(item) {
    var el = null;
    if (item.id) {
      el = document.getElementById(item.id);
    } else if (item.selector) {
      el = document.querySelector(item.selector);
    }
    
    if (!el) return;
    
    var restriction = getRestriction(role, item.feature);
    
    if (restriction === 'no-access') {
      el.style.display = 'none';
    } else if (restriction === 'view-only') {
      // Show but disable
      el.style.display = '';
      el.disabled = true;
      if (el.classList) {
        el.classList.add('cursor-not-allowed', 'opacity-50');
      } else {
        el.style.cursor = 'not-allowed';
        el.style.opacity = '0.5';
      }
      if (!el.title) {
        el.title = 'You do not have permission to perform this action';
      }
    } else {
      // Fully enabled
      el.style.display = '';
      el.disabled = false;
      if (el.classList) {
        el.classList.remove('cursor-not-allowed', 'opacity-50');
      } else {
        el.style.cursor = '';
        el.style.opacity = '';
      }
      el.title = '';
    }
  });
  
  // Settings screen items - control individual buttons
  var settingsItems = [
    { id: 'settings-factory-btn', feature: 'factory-settings' },
    { id: 'settings-heater-btn', feature: 'heater-control' },
    { id: 'settings-recipe-btn', feature: 'recipe-list' },
    { id: 'settings-edit-datetime-btn', feature: 'edit-datetime' },
    { id: 'settings-factory-reset-btn', feature: 'factory-reset' }
  ];
  
  settingsItems.forEach(function(item) {
    var el = document.getElementById(item.id);
    if (!el) return;
    
    var restriction = getRestriction(role, item.feature);
    
    if (restriction === 'no-access') {
      el.style.display = 'none';
    } else if (restriction === 'view-only') {
      el.style.display = '';
      el.disabled = true;
      if (el.classList) {
        el.classList.add('cursor-not-allowed', 'opacity-50');
      } else {
        el.style.cursor = 'not-allowed';
        el.style.opacity = '0.5';
      }
      el.title = 'You do not have permission to perform this action';
    } else {
      el.style.display = '';
      el.disabled = false;
      if (el.classList) {
        el.classList.remove('cursor-not-allowed', 'opacity-50');
      } else {
        el.style.cursor = '';
        el.style.opacity = '';
      }
      el.title = '';
    }
  });

  // Defensive fix: ensure Edit Date and Time button shows correct label
  var editDtBtn = document.getElementById('settings-edit-datetime-btn');
  if (editDtBtn) {
    var span = editDtBtn.querySelector('span');
    if (span) span.textContent = 'Edit Date and Time';
  }
  
  // Special handling for factory settings save button - disable if view-only
  var factorySaveBtn = document.getElementById('btn-save-factory-settings');
  if (factorySaveBtn && isViewOnly(role, 'factory-settings')) {
    factorySaveBtn.disabled = true;
    if (factorySaveBtn.classList) {
      factorySaveBtn.classList.add('cursor-not-allowed', 'opacity-50');
    } else {
      factorySaveBtn.style.cursor = 'not-allowed';
      factorySaveBtn.style.opacity = '0.5';
    }
    factorySaveBtn.title = 'You do not have permission to save factory settings';
  }
  
  // Hide delete calibration button if user doesn't have permission
  var deleteCalibrationBtn = document.getElementById('btn-delete-calibration');
  if (deleteCalibrationBtn) {
    var canDeleteCalibration = canAccess(role, 'validate-temp-calibration');
    if (!canDeleteCalibration) {
      deleteCalibrationBtn.style.display = 'none';
    }
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

// Client-side clock tick: smooth seconds, periodic API re-sync to avoid network jitter
var _clockDate = null; // RTC time as Date, incremented locally each second
var _lastClockDisplay = { time: '', time_12h: '', date: '' };

function formatClockFromDate(d) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return { time: '', time_12h: '', date: '' };
  var h = d.getHours();
  var m = d.getMinutes();
  var s = d.getSeconds();
  var h24 = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  var h12 = (h % 12) || 12;
  var suffix = h >= 12 ? 'PM' : 'AM';
  var time12 = String(h12).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + ' ' + suffix;
  var day = String(d.getDate()).padStart(2, '0');
  var month = String(d.getMonth() + 1).padStart(2, '0');
  var year = d.getFullYear();
  return { time: h24, time_12h: time12, date: day + '-' + month + '-' + year };
}

function renderClock() {
  var use24 = typeof use24Hour !== 'undefined' && use24Hour;
  var timeStr, dateStr;
  if (_clockDate) {
    var fmt = formatClockFromDate(_clockDate);
    timeStr = use24 ? fmt.time : fmt.time_12h;
    dateStr = fmt.date;
    _lastClockDisplay = fmt;
  } else {
    timeStr = _lastClockDisplay.time || '--:--:--';
    dateStr = _lastClockDisplay.date || '--/--/----';
  }
  var text = (timeStr || '--:--:--') + ' | ' + (dateStr || '--/--/----');
  var clockElements = document.querySelectorAll('.clock-display, #datetime');
  for (var i = 0; i < clockElements.length; i++) {
    if (clockElements[i]) clockElements[i].textContent = text;
  }
}

function tickClock() {
  if (_clockDate) {
    _clockDate.setSeconds(_clockDate.getSeconds() + 1);
  }
  renderClock();
}

function syncClockFromApi() {
  fetch('/api/get_datetime').then(function(r) { return r.ok ? r.json() : Promise.reject(); }).then(function(data) {
    if (!data) return;
    var dtStr = data.datetime;
    if (dtStr && typeof dtStr === 'string' && dtStr.indexOf('T') !== -1) {
      var nums = dtStr.match(/\d+/g);
      if (nums && nums.length >= 6) {
        var parsed = new Date(parseInt(nums[0], 10), parseInt(nums[1], 10) - 1, parseInt(nums[2], 10), parseInt(nums[3], 10), parseInt(nums[4], 10), parseInt(nums[5], 10) || 0);
        if (!isNaN(parsed.getTime())) _clockDate = parsed;
      }
    }
    if (_clockDate) {
      _lastClockDisplay = formatClockFromDate(_clockDate);
    } else if (data.date) {
      _lastClockDisplay.date = data.date;
      if (data.time) _lastClockDisplay.time = data.time.length === 5 ? data.time + ':00' : data.time;
      if (data.time_12h) _lastClockDisplay.time_12h = data.time_12h;
    }
    renderClock();
  }).catch(function() {
    renderClock();
  });
}

function updateClock() {
  renderClock();
}

// Initialize: sync once, then tick every second locally; re-sync every 30s
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      syncClockFromApi();
      if (typeof setInterval !== 'undefined') {
        setInterval(tickClock, 1000);
        setInterval(syncClockFromApi, 30000);
      }
    });
  } else {
    syncClockFromApi();
    if (typeof setInterval !== 'undefined') {
      setInterval(tickClock, 1000);
      setInterval(syncClockFromApi, 30000);
    }
  }
} else if (typeof setInterval !== 'undefined') {
  setInterval(tickClock, 1000);
  setInterval(syncClockFromApi, 30000);
}

// Format seconds to HH:MM:SS
function fmt(s) {
  var h = String(Math.floor(s / 3600)).padStart(2, '0');
  var m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  var ss = String(s % 60).padStart(2, '0');
  return h + ':' + m + ':' + ss;
}

// Update timer display
function upd(id) {
  var timerEl = document.getElementById('timer' + id);
  if (timerEl && timers[id]) {
    var seconds = timers[id].secs || 0;
    timerEl.textContent = fmt(seconds);
  } else {
    console.warn('Timer element or timer data not found for basket ' + id, {
      element: timerEl,
      timerData: timers[id]
    });
  }
}

// ========== MODAL ==========
// Popup dialogs because sometimes users need to be told things
function showModal(message, callback) {
  // Convert error codes to user-friendly messages (because users deserve clarity, not error codes)
  let displayMsg = message;
  if (message && typeof message === 'string') {
    // FIX: Do NOT convert login errors - show exact message to avoid generic "Unexpected error"
    if (message.includes('Login failed:') || message.includes('storage or system error') || 
        message.includes('Invalid username or password') || message.includes('Invalid username') || 
        message.includes('Invalid password') || message === 'Invalid username or password') {
      displayMsg = message; // Use exact message for login errors
    } else if (message.startsWith('ERR_')) {
      displayMsg = getErrorMessage(message);
    } else if (message.includes('E1001') || message.includes('E1002') || message.includes('E1003') || message.includes('E9999')) {
      // If it's an E code, extract the message part or convert
      displayMsg = getErrorMessage(message);
    } else {
      // Check if it looks like an error message that needs conversion
      const msg = message.toLowerCase();
      if (msg.includes('error') || msg.includes('failed') || msg.includes('invalid') || 
          msg.includes('timeout') || msg.includes('permission') || msg.includes('network')) {
        // FIX: Skip conversion for login-related invalid messages
        if (msg.includes('invalid username') || msg.includes('invalid password') || 
            msg.includes('invalid username or password')) {
          displayMsg = message; // Keep original message for login errors
        } else {
          var errorCode = getErrorCode(message);
          displayMsg = getErrorMessage(errorCode);
        }
      }
    }
  }
  
  var modalMessageEl = document.getElementById('modal-message');
  var modalEl = document.getElementById('modal');
  if (modalMessageEl) modalMessageEl.textContent = displayMsg || '';
  if (modalEl) modalEl.classList.add('active');
  modalCallback = callback || null;
}

function hideModal() {
  var modalEl = document.getElementById('modal');
  if (modalEl) {
    modalEl.classList.remove('active');
    // Restore default buttons visibility
    var modalContentEl = modalEl.querySelector('.modal-content');
    if (modalContentEl) {
      var defaultButtons = modalContentEl.querySelectorAll('button');
      for (var i = 0; i < defaultButtons.length; i++) {
        defaultButtons[i].style.display = '';
      }
    }
    // Reset modal message to textContent mode
    var modalMessageEl = document.getElementById('modal-message');
    if (modalMessageEl) {
      modalMessageEl.textContent = '';
    }
  }
  modalCallback = null;
}

function confirmModal() {
  if (modalCallback && typeof modalCallback === 'function') {
    modalCallback();
  }
  hideModal();
}

// ========== NAVIGATION ==========
// Switch between screens (because single-page apps are a thing)
// === Validation navigation guard ===
window.validationInProgress = window.validationInProgress || false;

function navigateTo(s) {
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/905604f3-2798-499f-a892-696c27f300f3',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'app.js:3915',message:'navigateTo called',data:{screen:s,hasDashboard:!!document.getElementById('screen-dashboard')},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'B'})}).catch(()=>{});
  // #endregion agent log
  if (!s) {
    console.error('navigateTo called with empty parameter'); // Because someone will do this
    return;
  }
  
  // Block navigation during validation (except validation screens themselves and calibration)
  if (window.validationInProgress && !['stroke-validation','temp-validation','validate-select','validate-type-select','calibration','temp-calibration-input'].includes(s)) {
    const msg = 'Validation in progress — stop or complete validation before navigating away.';
    if (typeof showModal === 'function') {
      showModal(msg);
    } else if (typeof showToast === 'function') {
      showToast(msg, 'warning');
    } else {
      alert(msg);
    }
    return;
  }
  
  // Block navigation to validation/calibration/beaker-config during preheating - show popup to stop first
  var screensRequiringPreheatStop = ['stroke-validation', 'temp-validation', 'temp-calibration-input', 'calibration', 'validate', 'validate-select', 'validate-type-select', 'add-beakers', 'add-baskets'];
  var isTargetBlocked = screensRequiringPreheatStop.indexOf(s) !== -1;
  var anyPreheating = (window.preheatInProgress && (window.preheatInProgress[1] || window.preheatInProgress[2] || window.preheatInProgress[3]));
  if (anyPreheating && isTargetBlocked) {
    (async function() {
      var confirmed = false;
      var message = (s === 'add-beakers' || s === 'add-baskets')
        ? 'Preheating is in progress. Do you want to stop preheating to change beaker configuration?'
        : 'Preheating is in progress. Do you want to stop preheating to enter validation/calibration?';
      if (typeof showModalConfirm === 'function') {
        confirmed = await showModalConfirm(message);
      }
      if (confirmed) {
        try {
          for (var bid = 1; bid <= 2; bid++) {
            if (window.preheatInProgress && window.preheatInProgress[bid]) {
              await sendStopForBasket(bid);
              window.preheatInProgress[bid] = false;
              testRunning[bid] = false;
              heaterOn[bid] = false;
              if (typeof stopPreheatTempPolling === 'function') stopPreheatTempPolling(bid);
              if (typeof preheatMonitor !== 'undefined' && preheatMonitor && preheatMonitor.stopMonitoring) preheatMonitor.stopMonitoring(bid);
            }
          }
          if (typeof updateHeaterControlUI === 'function') updateHeaterControlUI();
          if (typeof updateModeButtonsUI === 'function') {
            for (var bid = 1; bid <= 2; bid++) updateModeButtonsUI(bid);
          }
          navigateTo(s);
        } catch (e) {
          console.error('[navigateTo] Error aborting preheat:', e);
          if (typeof showToast === 'function') showToast('Failed to stop preheating. Please try again.', 'error');
        }
      }
    })();
    return;
  }
  
  // Check RBAC permissions for factory settings (factory users have full access)
  if (s === 'factory-settings') {
    var role = getCurrentRole();
    if (!canAccess(role, 'factory-settings')) {
    if (typeof showToast === 'function') {
        showToast('You do not have permission to access factory settings.', 'error');
    } else if (typeof showModal === 'function') {
        showModal('You do not have permission to access factory settings.');
    } else {
        alert('You do not have permission to access factory settings.');
    }
    return; // Block navigation
    }
  }
  
  // BLOCK NAVIGATION IF ANY TEST IS RUNNING (except dashboard, report-preview, and validation screens)
  var anyTestRunning = (testRunning[1] === true) || (testRunning[2] === true);
  // Allow navigation to validation screens even when test is running (so user can stay on validation screen)
  var validationScreens = ['stroke-validation', 'temp-validation', 'validate', 'validate-select', 'validate-type-select'];
  var isValidationScreen = validationScreens.indexOf(s) !== -1;
  
  if (anyTestRunning && s !== 'dashboard' && s !== 'report-preview' && s !== 'login' && !isValidationScreen) {
    if (typeof showToast === 'function') {
      showToast('A test is currently running. Navigation is disabled.', 'warning');
    } else if (typeof showModal === 'function') {
      showModal('A test is currently running. Navigation is disabled.');
    }
    return; // Block navigation
  }
  
  // If test is running and user is on validation screen, prevent navigation away (except to dashboard or login)
  var currentScreen = null;
  for (var i = 0; i < screens.length; i++) {
    var screenEl = document.getElementById('screen-' + screens[i]);
    if (screenEl && screenEl.classList.contains('active')) {
      currentScreen = screens[i];
      break;
    }
  }
  
  if (anyTestRunning && isValidationScreen && currentScreen && validationScreens.indexOf(currentScreen) !== -1) {
    // User is on validation screen and test is running - only allow navigation to dashboard or login
    if (s !== 'dashboard' && s !== 'login' && s !== 'report-preview') {
      if (typeof showToast === 'function') {
        showToast('Test is running. Please wait for the test to complete or stop it from the dashboard.', 'warning');
      } else if (typeof showModal === 'function') {
        showModal('Test is running. Please wait for the test to complete or stop it from the dashboard.');
      }
      return; // Block navigation away from validation screen
    }
  }
  
  // RBAC: Check access before navigating (except login screen, because everyone needs to log in)
  if (s !== 'login') {
    var role = getCurrentRole();
    var featureKey = SCREEN_FEATURE_MAP[s] || s;
    
    // If no user and trying to access non-login screen, redirect to login
    if (!role) {
      if (typeof showModal === 'function') {
        showModal('Please log in to access this section.');
      }
      // Navigate to login instead
      s = 'login';
    } else {
      // Check if user has access to this screen
      if (!canAccess(role, featureKey)) {
        if (typeof showModal === 'function') {
          showModal('You do not have permission to access this section.');
        }
        return; // Block navigation
      }
    }
  }
  
  // ========== EXIT HOOKS (run BEFORE screen changes) ==========
  // PATCH 1: Exit stroke validation screen when leaving
  if (currentScreen === 'stroke-validation' && s !== 'stroke-validation') {
    if (typeof exitStrokeValidationScreen === 'function') {
      exitStrokeValidationScreen();
    }
    // Close EventSource if it exists
    if (typeof strokeValidationEventSource !== 'undefined' && strokeValidationEventSource) {
      try {
        strokeValidationEventSource.close();
      } catch (e) {
        console.warn('[navigateTo] Error closing stroke validation EventSource on exit:', e);
      }
      strokeValidationEventSource = null;
    }
  }
  // PATCH 2: Exit temperature validation screen when leaving
  if (currentScreen === 'temp-validation' && s !== 'temp-validation') {
    console.log('[navigateTo] Leaving temp-validation screen, stopping temperature validation if running');
    if (typeof stopValidation === 'function') {
      try {
        stopValidation();
      } catch (e) {
        console.error('[navigateTo] Error stopping validation on temp-validation exit:', e);
      }
    }
    // Extra safety: clear temp validation timers/flags if still set
    if (typeof tempValidationInterval !== 'undefined' && tempValidationInterval) {
      try {
        clearInterval(tempValidationInterval);
      } catch (e) {
        console.warn('[navigateTo] Error clearing tempValidationInterval on exit:', e);
      }
      tempValidationInterval = null;
    }
    if (typeof tempValidationTimer !== 'undefined' && tempValidationTimer) {
      try {
        clearTimeout(tempValidationTimer);
      } catch (e) {
        console.warn('[navigateTo] Error clearing tempValidationTimer on exit:', e);
      }
      tempValidationTimer = null;
    }
    if (typeof tempValidationRunning !== 'undefined') {
      tempValidationRunning = false;
    }
    if (typeof tempValidationPreheatArmed !== 'undefined') {
      tempValidationPreheatArmed = false;
    }
    if (typeof stopTempValidationTempPoll === 'function') {
      stopTempValidationTempPoll();
    }
    if (typeof window !== 'undefined') {
      window.validationInProgress = false;
    }
  }
  
  for (var i = 0; i < screens.length; i++) {
    var id = screens[i];
    var el = document.getElementById('screen-' + id);
    if (el && id !== s) {
      el.classList.remove('active');
      el.style.display = 'none';
      el.style.visibility = 'hidden';
    }
  }
  
  var allScreens = document.querySelectorAll('.screen');
  for (var j = 0; j < allScreens.length; j++) {
    var screenEl = allScreens[j];
    if (!screenEl.id || screenEl.id.indexOf('screen-') !== 0) continue;
    var screenId = screenEl.id.replace('screen-', '');
    if (screenId !== s) {
      screenEl.classList.remove('active');
      screenEl.style.display = 'none';
      screenEl.style.visibility = 'hidden';
    }
  }
  
  var target = document.getElementById('screen-' + s);
  if (!target) {
    target = document.querySelector('#screen-' + s);
  }
  
  if (!target) {
    console.error('Screen screen-' + s + ' not found. Available screens:', screens);
    var fallback = document.getElementById('screen-login');
    if (fallback) {
      fallback.classList.add('active');
      fallback.style.display = 'flex';
      fallback.style.visibility = 'visible';
      fallback.style.zIndex = '200';
    }
    return;
  }
  
  target.classList.add('active');
  target.style.display = 'flex';
  target.style.visibility = 'visible';
  target.style.opacity = '1';
  
  if (s === 'login') {
    target.style.zIndex = '200';
  } else if (target.classList.contains('main-content')) {
    target.style.zIndex = '10';
  } else {
    target.style.zIndex = '';
  }
  
  // FIX: Update toggle button when temp-validation screen is shown
  if (s === 'temp-validation') {
    setTimeout(function() {
      updateTempValidationToggleButton();
    }, 100);
  }
  
  var sidebar = document.getElementById('sidebar');
  if (s === 'login') {
    if (sidebar) {
      sidebar.classList.remove('visible');
      sidebar.style.opacity = '0';
      sidebar.style.pointerEvents = 'none';
      sidebar.style.zIndex = '1'; 
    }
  } else {
    if (sidebar) {
      sidebar.classList.add('visible');
      sidebar.style.opacity = '1';
      sidebar.style.pointerEvents = 'auto';
      sidebar.style.zIndex = '150';
    }
  }
  
  var sidebarButtons = document.querySelectorAll('#sidebar button');
  for (var k = 0; k < sidebarButtons.length; k++) {
    sidebarButtons[k].classList.remove('active');
  }
  
  var activeMap = {
    'profile': 'sidebar-profile',
    'dashboard': 'sidebar-home',
    'validate': 'sidebar-validate',
    'validate-select': 'sidebar-validate',
    'validate-type-select': 'sidebar-validate',
    'calibration': 'sidebar-validate',
    'reports': 'sidebar-reports',
    'settings': 'sidebar-settings',
    'factory-settings': 'sidebar-factory-settings'
  };
  
  if (activeMap[s]) {
    var activeBtn = document.getElementById(activeMap[s]);
    if (activeBtn) activeBtn.classList.add('active');
  }
  
  if (s === 'manage-members' && typeof loadMembers === 'function') {
    loadMembers();
  }
  if (s === 'profile' && currentUser && typeof updateUIForUser === 'function') {
        updateUIForUser();
  }
  if (s === 'factory-settings' && typeof initFactorySettings === 'function') {
    setTimeout(function() {
      initFactorySettings();
    }, 100);
  }
  
  if (s === 'recipe-list' && typeof renderRecipeList === 'function') {
    setTimeout(function() {
      renderRecipeList();
    }, 100);
  }
  
  if (s === 'reports' && typeof loadReports === 'function') {
    setTimeout(function() {
      loadReports(null);
    }, 100);
  }
  
  // FIX: Load recipe data when navigating to dashboard
  if (s === 'dashboard') {
    (async function() {
      try {
        // Load configuredBeakers from storage so single-beaker selection is correct
        var savedConfiguredBeakers = await StorageAdapter.get('configuredBeakers');
        if (savedConfiguredBeakers) {
          configuredBeakers[1] = savedConfiguredBeakers[1] || false;
          configuredBeakers[2] = savedConfiguredBeakers[2] || false;
        }
        // Load saved recipe data
        var savedBasketProducts = await StorageAdapter.get('basketProducts');
        if (savedBasketProducts) {
          basketProducts[1] = savedBasketProducts[1] || null;
          basketProducts[2] = savedBasketProducts[2] || null;
        }
        
        var savedBasketBatches = await StorageAdapter.get('basketBatches');
        if (savedBasketBatches) {
          basketBatches[1] = savedBasketBatches[1] || null;
          basketBatches[2] = savedBasketBatches[2] || null;
        }
        
        var savedBasketDurations = await StorageAdapter.get('basketDurations');
        if (savedBasketDurations) {
          basketDurations[1] = savedBasketDurations[1] || null;
          basketDurations[2] = savedBasketDurations[2] || null;
        }
        
        var savedBasketModes = await StorageAdapter.get('basketModes');
        if (savedBasketModes) {
          basketModes[1] = savedBasketModes[1] || 'manual';
          basketModes[2] = savedBasketModes[2] || 'manual';
        }
        
        var savedSetTemp = await StorageAdapter.get('setTemp');
        if (savedSetTemp) {
          setTemp[1] = savedSetTemp[1] || 37.0;
          setTemp[2] = savedSetTemp[2] || 37.0;
        }
        
        // Update UI with loaded recipe data
        if (typeof updateDashboardProductNames === 'function') {
          updateDashboardProductNames();
        }
        if (typeof updateDashboardTempButton === 'function') {
          updateDashboardTempButton();
        }
        if (typeof updateModeButtonsUI === 'function') {
          updateModeButtonsUI(1);
          updateModeButtonsUI(2);
        }
        if (typeof updateBasketStates === 'function') {
          updateBasketStates();
        }
      } catch (e) {
        console.error('[Dashboard] Error loading recipe data:', e);
      }
    })();
  }
  
  if (s === 'add-beakers') {
    // Reset selection when entering add-beakers screen
    selectedBeakerForConfig = null;
    var proceedBtn = document.getElementById('proceed-beaker-btn');
    if (proceedBtn) {
      proceedBtn.style.display = 'none';
    }
    var allButtons = document.querySelectorAll('.beaker-select-btn');
    for (var i = 0; i < allButtons.length; i++) {
      allButtons[i].classList.remove('border-blue-500', 'bg-blue-600');
      allButtons[i].classList.add('border-gray-600', 'bg-gray-700');
    }
  }
  
  // Initialize temperature inputs when navigating to heater-control or create-recipe screens
  if (s === 'heater-control') {
    if (typeof updateHeaterControlVisibility === 'function') {
      updateHeaterControlVisibility();
    }
    if (typeof initTemperatureInputs === 'function') {
    setTimeout(function() {
      // Sync temperature values from setTemp array (single source of truth)
      for (var id = 1; id <= 2; id++) {
        var val = Number(setTemp[id] || 37.0);
        var inp = document.getElementById('set-temp-' + id);
        var displayEl = document.getElementById('set-temp-' + id + '-text');
        if (inp) {
          inp.value = val.toFixed(1);
        }
        if (displayEl) {
          displayEl.textContent = val.toFixed(1);
        }
      }
      // Then initialize the input handlers
      initTemperatureInputs();
    }, 150);
    }
  }
  if (s === 'create-recipe') {
    if (typeof initTemperatureInputs === 'function') {
      setTimeout(function() {
        initTemperatureInputs();
      }, 150);
    }
    // Initialize form when creating a NEW recipe (not editing) - leave temp, duration, mode blank
    setTimeout(function() {
      if (editingRecipeId === null) {
        var titleEl = document.getElementById('recipe-title');
        if (titleEl) titleEl.textContent = 'Create Recipe';
        var nameEl = document.getElementById('recipe-name');
        if (nameEl) nameEl.value = '';
        var tempEl = document.getElementById('recipe-temp');
        if (tempEl) tempEl.value = '';
        var durationEl = document.getElementById('recipe-duration');
        if (durationEl) durationEl.value = '';
        var modeInput = document.getElementById('recipe-mode-value');
        if (modeInput) modeInput.value = '';
        if (typeof clearRecipeModeSelection === 'function') clearRecipeModeSelection();
      }
    }, 200);
  }
  
  // ========== CENTRALIZED SCREEN-ENTRY HOOKS (run AFTER screen is active) ==========
  // PATCH 1: Stroke validation - live count updates
  if (s === 'stroke-validation') {
    if (typeof enterStrokeValidationScreen === 'function') {
      enterStrokeValidationScreen();
    }
    
    // Close any existing EventSource first
    if (strokeValidationEventSource) {
      try {
        strokeValidationEventSource.close();
      } catch (e) {
        console.warn('[navigateTo] Error closing existing stroke validation EventSource:', e);
      }
      strokeValidationEventSource = null;
    }
    
    // REMOVED: EventSource listener for ESP stroke data - using simulated data only
    // Stroke counting now handled by auto-increment in startStrokeValidationReal()
    // No ESP data parsing needed - strokes increment +1 every 2 seconds automatically
  }
  
  // PATCH 2: Recipe creation - time typing enabled
  if (s === 'create-recipe') {
    if (typeof enableRecipeTimeTyping === 'function') {
      enableRecipeTimeTyping();
    }
  }
  
  // PATCH 3: Temperature validation - typing enabled and re-initialize screen
  if (s === 'temp-validation') {
    if (typeof initializeTemperatureValidationReal === 'function') {
      initializeTemperatureValidationReal();
    }
    if (typeof enableValidationTempTyping === 'function') {
      enableValidationTempTyping();
    }
  }
  
  // PATCH 4: Calibration - typing enabled
  if (s === 'temp-calibration-input' || s === 'calibration') {
    if (typeof enableCalibrationTyping === 'function') {
      enableCalibrationTyping();
    }
  }
  
  // Edit Date and Time screen - initialize date/time from RTC (API only, no Pi/local fallback)
  if (s === 'edit-date-time') {
    setTimeout(function() {
      // Guard against late async init overwriting user input.
      // Each time we enter this screen we create a new token; only the latest token may write.
      var _editInitToken = Date.now();
      window._editDateTimeInitToken = _editInitToken;
      window._editDateTimeDirty = false;

      function applyDateTimeValues(dateStr, timeStr, timeStr12h) {
        if (window._editDateTimeInitToken !== _editInitToken) return;
        if (window._editDateTimeDirty) return;
        var dateInput = document.getElementById('edit-date-input');
        var timeInput = document.getElementById('edit-time-input');
        var dateTextEl = document.getElementById('current-date-text');
        var timeTextEl = document.getElementById('current-time-text');
        var displayTime;
        var inputTime;
        if (editUse24Hour) {
          displayTime = timeStr;
          inputTime = timeStr;
        } else {
          var raw12 = timeStr12h || timeStr;
          if (/PM/i.test(raw12)) { editAmPm = 'PM'; }
          else if (/AM/i.test(raw12)) { editAmPm = 'AM'; }
          inputTime = raw12.replace(/\s*(AM|PM|A\.M\.|P\.M\.)\s*/gi, '').trim();
          displayTime = inputTime;
          if (typeof setEditAmPm === 'function') setEditAmPm(editAmPm);
        }
        if (dateInput) dateInput.value = dateStr || '';
        if (timeInput) timeInput.value = inputTime || '';
        if (dateTextEl) dateTextEl.textContent = dateStr || '--/--/----';
        if (timeTextEl) timeTextEl.textContent = displayTime || '--:--';
        var parts = (dateStr || '').split('-');
        if (parts.length === 3) {
          datePickerDay = parseInt(parts[0], 10);
          datePickerMonth = parseInt(parts[1], 10);
          datePickerYear = parseInt(parts[2], 10);
        }
        var timeParts = (timeStr || '').split(':');
        if (timeParts.length >= 2) {
          timePickerHour = parseInt(timeParts[0], 10);
          timePickerMinute = parseInt(timeParts[1], 10);
        }
        if (typeof updateClock === 'function') updateClock();
      }
      fetch('/api/get_datetime').then(function(r) { return r.ok ? r.json() : Promise.reject(); }).then(function(data) {
        applyDateTimeValues(data.date || '', data.time || '', data.time_12h || '');
      }).catch(function() {
        applyDateTimeValues('', '', '');
      });
      var dateInput = document.getElementById('edit-date-input');
      var timeInput = document.getElementById('edit-time-input');
      var dateTextEl = document.getElementById('current-date-text');
      var timeTextEl = document.getElementById('current-time-text');
      if (dateInput && !dateInput._editDtBound) {
        dateInput._editDtBound = true;
        dateInput.addEventListener('input', function() {
          window._editDateTimeDirty = true;
          if (dateTextEl) dateTextEl.textContent = this.value || '';
        });
      }
      if (timeInput && !timeInput._editDtBound) {
        timeInput._editDtBound = true;
        timeInput.addEventListener('input', function() {
          window._editDateTimeDirty = true;
          if (timeTextEl) timeTextEl.textContent = this.value || '';
        });
      }
      if (typeof setEditTimeFormat === 'function') {
        // Initialize edit screen format from global preference (so it doesn't force 24h on entry).
        if (typeof use24Hour !== 'undefined') {
          editUse24Hour = !!use24Hour;
        }
        setEditTimeFormat(editUse24Hour);
      }
    }, 100);
  }
  
  // Fix 'A' character in temperature displays on dashboard
  if (s === 'dashboard') {
    setTimeout(function() {
      for (var i = 1; i <= 2; i++) {
        var tempEl = document.getElementById('temp' + i);
        if (tempEl) {
          var currentText = tempEl.textContent || '';
          // Remove 'A' and 'Â' characters if present
          if (currentText.indexOf('A') > -1 || currentText.indexOf('Â') > -1) {
            setTemperatureDisplay('temp' + i, setTemp[i] || 37.0);
          }
        }
      }
      // Do NOT call loadDashboardProductNames - it clears products and conflicts with async block
      // Update basket visibility based on configured beakers
      if (typeof updateBasketStates === 'function') {
        updateBasketStates();
      }
      
      // Ensure basket holes/vessel layout is updated when navigating to dashboard
      if (typeof updateBasketHoles === 'function') {
        updateBasketHoles(1, basketConfig);
        updateBasketHoles(2, basketConfig);
      }
      
      // Update basket hole selection UI
      if (typeof updateBasketHoleSelection === 'function') {
        updateBasketHoleSelection(1);
        updateBasketHoleSelection(2);
      }
      // Update temperature button display
      if (typeof updateDashboardTempButton === 'function') {
        updateDashboardTempButton();
      }
      // Update heater control UI (including start/preheating button)
      if (typeof updateHeaterControlUI === 'function') {
        updateHeaterControlUI();
      }
    }, 100);
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    setTimeout(function() {
      lucide.createIcons();
    }, 50);
  }
}

// Expose navigateTo globally
window.navigateTo = navigateTo;

// Expose handleLogin globally (because the login button needs to work)
window.handleLogin = handleLogin;

// Factory Reset - deletes all reports, users (except factory), and recipes
async function handleFactoryReset() {
  try {
    // 1. Call backend to delete report PDFs and clear reports.json (skip if bridge unavailable)
    try {
      var res = await fetchWithTimeout('/api/factory_reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }, 15000);
      if (!res.ok) {
        var err = await res.json().catch(function() { return {}; });
        throw new Error(err.error || 'Backend factory reset failed');
      }
    } catch (bridgeErr) {
      console.warn('[FactoryReset] Backend unavailable, clearing storage only:', bridgeErr.message);
    }

    // 2. Clear reports in storage (localStorage or bridge)
    await safeSave('reports', []);

    // 3. Keep only factory user (RLERLT)
    var factoryUser = { username: 'RLERLT', password: 'Rahul', role: 'Factory', name: 'Factory User' };
    await safeSave('users', [factoryUser]);

    // 4. Clear all recipes
    await safeSave('recipes', []);
    if (typeof recipes !== 'undefined') recipes.length = 0;

    showModal('Factory reset completed. All reports, users (except factory), and recipes have been deleted.');
    if (typeof loadRecipeList === 'function') loadRecipeList();
    if (typeof loadMembers === 'function') loadMembers();
  } catch (e) {
    console.error('[FactoryReset]', e);
    showModal('Factory reset failed: ' + (e.message || String(e)));
  }
}
window.handleFactoryReset = handleFactoryReset;

// Logout function - clears user session and returns to login (because users need to log out sometimes)
async function logout() {
  try {
    console.log('[Logout] Starting logout process - terminating all communications');
    
    // Stop all running tests and preheating (both baskets) using per-basket stops
    for (var basketId = 1; basketId <= 2; basketId++) {
      // Stop hardware for this basket
      if (testRunning[basketId] || (window.preheatInProgress && window.preheatInProgress[basketId])) {
        console.log('[Logout] Stopping test/preheat for basket', basketId);
        try {
          await sendStopForBasket(basketId);
        } catch (e) {
          console.error('[Logout] Error stopping basket', basketId, ':', e);
        }
      }
      
      // Clear timers for this basket
      if (timers[basketId]) {
        if (timers[basketId].interval) {
          clearInterval(timers[basketId].interval);
          timers[basketId].interval = null;
        }
        if (timers[basketId].tempPollInterval) {
          clearInterval(timers[basketId].tempPollInterval);
          timers[basketId].tempPollInterval = null;
        }
        timers[basketId].running = false;
        timers[basketId].secs = 0;
      }
      
      // Reset all state for this basket
      testRunning[basketId] = false;
      heaterOn[basketId] = false;
      
      // Update mode button UI to re-enable mode switching
      if (typeof updateModeButtonsUI === 'function') {
        updateModeButtonsUI(basketId);
      }
      
      // Reset Start button UI for this basket
      var btn = document.getElementById('start' + basketId);
      if (btn) {
        btn.textContent = 'Start';
        btn.style.background = '#10b981';
        btn.disabled = false;
      }
    }
    
    // Clear preheat progress flags
    if (window.preheatInProgress) {
      window.preheatInProgress[1] = false;
      window.preheatInProgress[2] = false;
      window.preheatInProgress[3] = false;
    } else {
      window.preheatInProgress = {1: false, 2: false, 3: false};
    }
    
    // Stop any validation processes
    if (typeof stopValidation === 'function') {
      try {
        await stopValidation();
      } catch (e) {
        console.error('[Logout] Error stopping validation:', e);
      }
    }
    
    // Stop stroke validation resources
    if (strokeValidationInterval) {
      clearInterval(strokeValidationInterval);
      strokeValidationInterval = null;
    }
    // Close EventSource if it exists (screen-specific subscription)
    if (strokeValidationEventSource) {
      try {
        strokeValidationEventSource.close();
      } catch (e) {
        console.warn('[navigateTo] Error closing stroke validation EventSource:', e);
      }
      strokeValidationEventSource = null;
    }
    strokeValidationStartTime = null;
    lastStrokeReading = 0;
    
    // Stop temperature validation resources
    if (tempValidationInterval) {
      clearInterval(tempValidationInterval);
      tempValidationInterval = null;
    }
    if (tempValidationTimer) {
      clearTimeout(tempValidationTimer);
      tempValidationTimer = null;
    }
    tempValidationElapsedStarted = false;
    tempValidationStartTime = null;
    
    // Stop calibration if running
    if (calibrationInterval) {
      clearInterval(calibrationInterval);
      calibrationInterval = null;
    }
    if (calibrationTimer) {
      clearTimeout(calibrationTimer);
      calibrationTimer = null;
    }
    isCalibrating = false;
    
    // Send per-basket stop commands (already done above, but send global STOP as final safety)
    console.log('[Logout] Sending final STOP command to ESP32 as safety measure');
    try {
      const stopResult = await sendStopAll('logout-final-safety');
      if (stopResult && stopResult.error) {
        console.error('[Logout] Final STOP command failed:', stopResult.error);
      } else {
        console.log('[Logout] Final STOP command sent successfully to ESP32');
      }
    } catch (e) {
      console.error('[Logout] Exception sending final STOP command:', e);
    }
    
    // Update UI to reflect clean state (heaters already set to false above)
    if (typeof updateHeaterControlUI === 'function') {
      updateHeaterControlUI();
    }
    if (typeof updateBasketStates === 'function') {
      updateBasketStates();
    }
    console.log('[Logout] All UI state cleared and buttons reset');
    
    // Clear current user from memory
    currentUser = null;
    window.currentUser = null;
    
    // Clear current user from storage
    if (typeof StorageAdapter !== 'undefined' && StorageAdapter.remove) {
      await StorageAdapter.remove('currentUser');
    } else if (typeof StorageAdapter !== 'undefined' && StorageAdapter.set) {
      await StorageAdapter.set('currentUser', null);
    }
    
    // Clear recipe/product data so next login starts fresh (blank recipe name, batch, default temp)
    basketProducts = {1: null, 2: null};
    basketBatches = {1: null, 2: null};
    setTemp = {1: 37.0, 2: 37.0};
    basketDurations = {1: null, 2: null};
    basketModes = {1: 'manual', 2: 'manual'};
    try {
      if (typeof safeSave === 'function') {
        await safeSave('basketProducts', basketProducts);
        await safeSave('basketBatches', basketBatches);
        await safeSave('setTemp', setTemp);
        await safeSave('basketDurations', basketDurations);
        await safeSave('basketModes', basketModes);
      }
    } catch (saveErr) {
      console.warn('[Logout] Error clearing recipe data from storage:', saveErr);
    }
    
    // Update UI to reflect logged out state
    if (typeof updateUIForUser === 'function') {
      updateUIForUser();
    }
    
    // Clear login credentials (user ID and password) before navigating to login
    var uidEl = document.getElementById('login-uid');
    var pwdEl = document.getElementById('login-pwd');
    if (uidEl) {
      uidEl.value = '';
    }
    if (pwdEl) {
      pwdEl.value = '';
    }
    console.log('[Logout] Login credentials cleared');
    
    // Navigate to login screen
    if (typeof navigateTo === 'function') {
      navigateTo('login');
    } else if (typeof window.navigateTo === 'function') {
      window.navigateTo('login');
    }
    
    // Show a message (optional, but nice to have)
    if (typeof showToast === 'function') {
      showToast('Logged out successfully. All operations stopped.', 'success');
    }
    
    console.log('[Logout] Logout process completed');
  } catch (e) {
    console.error('[Logout] Error during logout:', e);
    // Even if there's an error, try to send STOP command and navigate to login
    try {
      await sendStopAll('logout-error-handling');
    } catch (stopError) {
      console.error('[Logout] Failed to send STOP command during error handling:', stopError);
    }
    
    if (typeof navigateTo === 'function') {
      navigateTo('login');
    } else if (typeof window.navigateTo === 'function') {
      window.navigateTo('login');
    }
  }
}

// Expose logout globally
window.logout = logout;

/* Manage Members helpers */
// Load members from storage and render the table
/* Manage Members helper - returns members array from storage */
async function loadMembers(){
  var members = await StorageAdapter.get('users') || [];
  return members;
}

// Function to select role via buttons
function selectRole(role) {
  console.log('[selectRole] Called with role:', role);
  var roleInputEl = document.getElementById('add-member-role');
  if (roleInputEl) {
    roleInputEl.value = role || '';
    console.log('[selectRole] Set hidden input value to:', roleInputEl.value);
  } else {
    console.error('[selectRole] Hidden input add-member-role not found!');
  }
  
  // Remove active class from all role buttons
  var roleButtons = document.querySelectorAll('.role-btn');
  console.log('[selectRole] Found', roleButtons.length, 'role buttons');
  for (var i = 0; i < roleButtons.length; i++) {
    roleButtons[i].classList.remove('active');
    // Clear any inline styles
    roleButtons[i].style.background = '';
    roleButtons[i].style.borderColor = '';
  }
  
  // Add active class to selected button
  var selectedBtn = document.querySelector('.role-btn[data-role="' + role + '"]');
  if (selectedBtn) {
    selectedBtn.classList.add('active');
    console.log('[selectRole] Added active class to button for role:', role);
  } else {
    console.error('[selectRole] Button with data-role="' + role + '" not found!');
  }
}

// Add member function - validates 6-digit UID, checks duplicates, saves and navigates
async function addMember() {
  // RBAC: Check permission to add members
  // Factory and Admin users always have permission to add members
  var role = getCurrentRole();
  var normalizedRole = role ? String(role).toLowerCase() : null;
  if (normalizedRole !== 'factory' && normalizedRole !== 'admin' && !canAccess(role, 'user-add')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to perform this action. Please contact your administrator.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to perform this action. Please contact your administrator.');
    }
    return;
  }
  
  try {
    var nameEl = document.getElementById('add-member-name');
    var usernameEl = document.getElementById('add-member-username');
    var pwdEl = document.getElementById('add-member-pwd');
    var confirmEl = document.getElementById('add-member-confirm-pwd');
    var roleEl = document.getElementById('add-member-role');
    
    var name = nameEl && nameEl.value ? nameEl.value.trim() : '';
    var username = usernameEl && usernameEl.value ? usernameEl.value.trim() : '';
    var pwd = pwdEl && pwdEl.value ? pwdEl.value : '';
    var confirm = confirmEl && confirmEl.value ? confirmEl.value : '';
    var role = roleEl && roleEl.value ? roleEl.value.trim() : '';

    // Validate all required fields
    if (!name || !username || !pwd || !confirm || !role) {
      if (typeof showToast === 'function') {
        showToast('Invalid input. Please check your entries and try again.', 'error');
      } else if (typeof showModal === 'function') {
        showModal('Please fill all fields');
      }
      return; 
    }
    
    // Validate Employee ID (any string, not empty)
    if (!username || username.length === 0) {
      if (typeof showToast === 'function') {
        showToast('Invalid input. Please check your entries and try again.', 'error');
      } else if (typeof showModal === 'function') {
        showModal('Employee ID is required');
      }
      return;
    }
    
    // Validate password match
    if (pwd !== confirm) {
      // IMPORTANT: Use an explicit message here (avoid generic "Invalid input" which
      // gets converted to a system error by the toast/modal error-code mapper).
      if (typeof showModal === 'function') {
        showModal('Passwords do not match');
      } else if (typeof showToast === 'function') {
        // Use non-error type to avoid error-code conversion.
        showToast('Passwords do not match', 'info');
      }
      return; 
    }
    
    // Validate role is selected (not empty)
    if (role === '' || role === null) {
      if (typeof showToast === 'function') {
        showToast('Invalid input. Please check your entries and try again.', 'error');
      } else if (typeof showModal === 'function') {
        showModal('Please select a role');
      }
      return;
    }
    
    // Check for duplicate username/UID
    var members = await loadMembers();
    if (members && members.length > 0) {
      for (var i = 0; i < members.length; i++) {
        if (members[i].username === username) {
          if (typeof showModal === 'function') {
            showModal('User id already used. Use a different one.');
          } else if (typeof showToast === 'function') {
            showToast('User id already used. Use a different one.', 'info');
          }
          return;
        }
      }
    }
    
    // Add new member
    var newMember = {
      name: name,
      username: username,
      password: pwd,
      role: role,
      fullName: name
    };
    
    if (!members) {
      members = [];
    }
    members.unshift(newMember);
    
    // Save to storage
    if (typeof safeSave === 'function') {
      await safeSave('users', members);
    } else if (typeof StorageAdapter !== 'undefined' && StorageAdapter.set) {
      await StorageAdapter.set('users', members);
    }
    
    // Show success and navigate like recipe save
    if (typeof showModal === 'function') {
      showModal('Member added successfully!', function () {
        if (typeof navigateTo === 'function') {
          navigateTo('manage-members');
        } else if (typeof window.navigateTo === 'function') {
          window.navigateTo('manage-members');
        }
      });
    } else {
    if (typeof showToast === 'function') {
      showToast('Member added successfully', 'success');
      }
      setTimeout(function() {
        if (typeof navigateTo === 'function') {
          navigateTo('manage-members');
        } else if (typeof window.navigateTo === 'function') {
          window.navigateTo('manage-members');
        }
      }, 500);
    }
    
    // Clear form
    if (nameEl) nameEl.value = '';
    if (usernameEl) usernameEl.value = '';
    if (pwdEl) pwdEl.value = '';
    if (confirmEl) confirmEl.value = '';
    if (roleEl) roleEl.value = '';
    
    // Clear role button selection
    var roleButtons = document.querySelectorAll('.role-btn');
    for (var j = 0; j < roleButtons.length; j++) {
      roleButtons[j].classList.remove('active');
      roleButtons[j].style.background = '';
      roleButtons[j].style.borderColor = '';
    }
    
    // Reload members table if manage-members screen is active
    var manageMembersScreen = document.getElementById('screen-manage-members');
    if (manageMembersScreen && manageMembersScreen.classList && manageMembersScreen.classList.contains('active')) {
      if (typeof initManageMembers === 'function') {
        await initManageMembers();
      }
    }
    
  } catch (e) {
    console.error('[Add Member] Error:', e);
    if (typeof showToast === 'function') {
      showToast('Failed to add member. Please check all fields and try again.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('Failed to add member. Please check all fields and try again.');
    }
  }
}

// Expose functions globally for onclick handlers
window.selectRole = selectRole;
window.addMember = addMember;

// ========== DASHBOARD FUNCTIONS ==========
// All the stuff that makes the main screen actually work
async function selectMode(basketId, mode) {
  // Prevent mode toggling when test is running for this basket
  if (testRunning[basketId]) {
    if (typeof showToast === 'function') {
      showToast('Cannot change mode while test is running for basket ' + basketId, 'warning');
    } else if (typeof showModal === 'function') {
      showModal('Cannot change mode while test is running for basket ' + basketId);
    }
    return; // Exit early - don't allow mode change
  }
  
  basketModes[basketId] = mode;
  await safeSave('basketModes', basketModes);
  
  updateModeButtonsUI(basketId);
}

// Update mode button UI for a basket
function updateModeButtonsUI(basketId) {
  var timerBtn = document.getElementById('timer-btn-' + basketId);
  var manualBtn = document.getElementById('manual-btn-' + basketId);
  var mode = basketModes[basketId] || 'manual';
  var isTestRunning = testRunning[basketId];
  
  if (mode === 'timer') {
    if (timerBtn) {
      timerBtn.style.background = '#2563eb';
      timerBtn.style.color = 'white';
      timerBtn.style.opacity = isTestRunning ? '0.5' : '1';
      timerBtn.style.pointerEvents = isTestRunning ? 'none' : 'auto';
    }
    if (manualBtn) {
      manualBtn.style.background = '#374151';
      manualBtn.style.color = '#9ca3af';
      manualBtn.style.opacity = isTestRunning ? '0.5' : '1';
      manualBtn.style.pointerEvents = isTestRunning ? 'none' : 'auto';
    }
  } else {
    if (manualBtn) {
      manualBtn.style.background = '#2563eb';
      manualBtn.style.color = 'white';
      manualBtn.style.opacity = isTestRunning ? '0.5' : '1';
      manualBtn.style.pointerEvents = isTestRunning ? 'none' : 'auto';
    }
    if (timerBtn) {
      timerBtn.style.background = '#374151';
      timerBtn.style.color = '#9ca3af';
      timerBtn.style.opacity = isTestRunning ? '0.5' : '1';
      timerBtn.style.pointerEvents = isTestRunning ? 'none' : 'auto';
    }
  }
}

async function toggleHeater(basketId) {
  // Get current state to determine what action to take
  var turningOn = !heaterOn[basketId];
  
  try {
    if (turningOn) {
      // Turn heater ON - call sendPreheat with set temperature
      var setTempValue = Number(setTemp[basketId] || 37.0);
      var preheatResult;
      
      if (basketId === 1) {
        const otherOnOrPreheating = configuredBeakers[2] && (heaterOn[2] || (window.preheatInProgress && window.preheatInProgress[2]));
        const otherTemp = otherOnOrPreheating ? Number(setTemp[2] || 0) : 0;
        preheatResult = await sendPreheat(setTempValue, otherTemp);
      } else if (basketId === 2) {
        const otherOnOrPreheating = configuredBeakers[1] && (heaterOn[1] || (window.preheatInProgress && window.preheatInProgress[1]));
        const otherTemp = otherOnOrPreheating ? Number(setTemp[1] || 0) : 0;
        preheatResult = await sendPreheat(otherTemp, setTempValue);
      } else {
        // For basket 3 or other cases, use both temps
        const t1 = setTemp[1] || setTempValue;
        const t2 = setTemp[2] || setTempValue;
        preheatResult = await sendPreheat(t1, t2);
      }
      
      if (preheatResult && preheatResult.error) {
        console.error('[toggleHeater] Failed to turn on heater:', preheatResult.error);
        if (typeof showToast === 'function') {
          showToast('Failed to turn on heater. Please check the connection and try again.', 'error');
        }
        return; // Don't update UI state if command failed
      }
      
      // Success - update state
      heaterOn[basketId] = true;
      console.log('[toggleHeater] Heater', basketId, 'turned ON via bridge');
      
      // Start continuous temperature polling during preheat
      startPreheatTempPolling(basketId);
      
      // Start preheat monitoring for auto-popup trigger when temp reaches ±0.3°C
      preheatMonitor.startMonitoring(basketId, setTempValue);
    } else {
      // Turn heater OFF - send preheat with 0 for this heater
      var preheatResult;
      
      if (basketId === 1) {
        // Turn off heater 1, preserve heater 2 only if beaker 2 is configured AND heater 2 is ON
        const otherTemp = (configuredBeakers[2] && heaterOn[2]) ? Number(setTemp[2] || 0) : 0;
        preheatResult = await sendPreheat(0, otherTemp);
      } else if (basketId === 2) {
        // Turn off heater 2, preserve heater 1 only if beaker 1 is configured AND heater 1 is ON
        const otherTemp = (configuredBeakers[1] && heaterOn[1]) ? Number(setTemp[1] || 0) : 0;
        preheatResult = await sendPreheat(otherTemp, 0);
      } else {
        // For basket 3, turn off both
        preheatResult = await sendPreheat(0, 0);
      }
      
      if (preheatResult && preheatResult.error) {
        console.error('[toggleHeater] Failed to turn off heater:', preheatResult.error);
        if (typeof showToast === 'function') {
          showToast('Failed to turn off heater. Please check the connection and try again.', 'error');
        }
        return; // Don't update UI state if command failed
      }
      
      // Success - update state
      heaterOn[basketId] = false;
      console.log('[toggleHeater] Heater', basketId, 'turned OFF via bridge');
      
      // Stop temperature polling when preheat is turned off
      stopPreheatTempPolling(basketId);
      
      // Stop preheat monitoring (only once)
      preheatMonitor.stopMonitoring(basketId);
    }
    
    // Update UI to reflect the new state (single source of truth)
    if (typeof updateHeaterControlUI === 'function') {
      updateHeaterControlUI();
    }
  } catch (e) {
    console.error('[toggleHeater] Exception:', e, e.stack);
    if (typeof showToast === 'function') {
      showToast('Heater control error: ' + String(e), 'error');
    }
  }
}

// Start continuous temperature polling during preheat
function startPreheatTempPolling(basketId) {
  // Initialize timers if needed
  if (!timers[basketId]) {
    timers[basketId] = {running: false, secs: 0, interval: null, tempPollInterval: null, elapsedStarted: false};
  }
  
  // Clear any existing polling interval for this basket
  if (timers[basketId].tempPollInterval) {
    clearInterval(timers[basketId].tempPollInterval);
    timers[basketId].tempPollInterval = null;
  }
  
  // Temps from bridge SSE - apply window.latestTemps periodically for preheat monitor
  var pollOnce = function() {
    if (!heaterOn[basketId] || testRunning[basketId]) {
      stopPreheatTempPolling(basketId);
      preheatMonitor.stopMonitoring(basketId);
      return;
    }
    if (window.latestTemps && typeof applyTempsToUI === 'function') {
      applyTempsToUI(window.latestTemps);
    }
    timers[basketId].tempPollInterval = setTimeout(pollOnce, 2000);
  };
  timers[basketId].tempPollInterval = setTimeout(pollOnce, 2000);
  console.log('[startPreheatTempPolling] Using temps from bridge SSE for basket', basketId);
}

// Stop temperature polling during preheat
function stopPreheatTempPolling(basketId) {
  if (timers[basketId] && timers[basketId].tempPollInterval) {
    clearTimeout(timers[basketId].tempPollInterval);
    timers[basketId].tempPollInterval = null;
    console.log('[stopPreheatTempPolling] Stopped temperature polling for basket', basketId);
  }
}

function handleBasketTap(basketId, event) {
  // Handle hole tapping for completion
  if (event && event.target && event.target.classList && event.target.classList.contains('basket-hole')) {
    return; // Let the hole's onclick handler handle it
  }
  
  // Allow basket tap to mark completion in manual mode only (not timer mode)
  if (testRunning[basketId]) {
    var mode = basketModes[basketId] || 'timer';
    if (mode === 'timer') {
      console.log('[handleBasketTap] Basket tap disabled in timer mode for basket', basketId);
      return;
    }
    
    var container = document.getElementById('basket' + basketId + '-container');
    
    // Single tube (basketConfig === 1): mark hole 1 complete and stop test
    if (basketConfig === 1) {
      if (!basketHoles[basketId]) basketHoles[basketId] = {};
      if (!basketHoles[basketId][1]) {
        basketHoles[basketId][1] = true;
        holeCompletionTimes[basketId] = holeCompletionTimes[basketId] || {};
        holeCompletionTimes[basketId][1] = Date.now();
        if (!currentRunVesselTimes[1] && testStartTime[basketId]) {
          const finish = Date.now();
          const durationMs = finish - (testStartTime[basketId] || finish);
          const hh = Math.floor(durationMs / 3600000);
          const mm = Math.floor((durationMs % 3600000) / 60000);
          const ss = Math.floor((durationMs % 60000) / 1000);
          currentRunVesselTimes[1] = String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
        }
        if (typeof stopTest === 'function') stopTest(basketId, { aborted: false });
        if (typeof checkAllHolesComplete === 'function') checkAllHolesComplete(basketId);
        if (container) {
          container.style.opacity = '0.7';
          setTimeout(function() { if (container) container.style.opacity = '1'; }, 200);
        }
      }
      return;
    }
    
    // Multi-tube (3 or 6): basket tap marks all tubes complete
    if ((basketConfig === 3 || basketConfig === 6) && container) {
      var holes = container.querySelectorAll('.basket-hole');
      var totalHoles = holes.length;
      var completedHoles = container.querySelectorAll('.basket-hole.completed').length;
      if (completedHoles < totalHoles) {
        if (!basketHoles[basketId]) basketHoles[basketId] = {};
        holeCompletionTimes[basketId] = holeCompletionTimes[basketId] || {};
        var completionTime = Date.now();
        for (var h = 1; h <= basketConfig; h++) {
          if (!basketHoles[basketId][h]) {
            basketHoles[basketId][h] = true;
            holeCompletionTimes[basketId][h] = completionTime;
          }
          if (!currentRunVesselTimes[h] && testStartTime[basketId]) {
            const finish = Date.now();
            const durationMs = finish - (testStartTime[basketId] || finish);
            const hh = Math.floor(durationMs / 3600000);
            const mm = Math.floor((durationMs % 3600000) / 60000);
            const ss = Math.floor((durationMs % 60000) / 1000);
            currentRunVesselTimes[h] = String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
          }
        }
        for (var i = 0; i < holes.length; i++) {
          if (!holes[i].classList.contains('completed')) holes[i].classList.add('completed');
        }
        if (typeof checkAllHolesComplete === 'function') checkAllHolesComplete(basketId);
        container.style.opacity = '0.7';
        setTimeout(function() { if (container) container.style.opacity = '1'; }, 200);
      }
      return;
    }
  }
  
  return;
}

async function startTest(basketId) {
  console.log('[startTest] Called for basket', basketId);
  // Ensure configuredBeakers is set
  if (!configuredBeakers[basketId]) {
    console.log('[startTest] Setting configuredBeakers[' + basketId + '] = true');
    configuredBeakers[basketId] = true;
  }
  
  if (testRunning[basketId]) {
    console.warn('[startTest] Test already running for basket', basketId);
    return;
  }
  
  const setTempValue = Number(setTemp[basketId] || 37.0);
  
  var btn = document.getElementById('start' + basketId);
  if (!btn) return;
  
  var container = document.getElementById('basket' + basketId + '-container');
  if (container) {
    var holes = container.querySelectorAll('.basket-hole');
    for (var i = 0; i < holes.length; i++) {
      holes[i].classList.remove('completed');
      if (configuredBeakers[basketId]) {
        holes[i].style.display = 'flex';
      }
    }
  }
  
  basketHoles[basketId] = {};
  holeCompletionTimes[basketId] = {};
  // Option B: do NOT set testStartTime here.
  // It must be set only when TR1/TR2 is received and the user confirms in triggerTestStartPopup().
  recordedTemps[basketId] = []; // Clear previous temperature recordings
  
  // Initialize timer state (but don't start counting yet)
  if (!timers[basketId]) {
    timers[basketId] = {running: false, secs: 0, interval: null, tempPollInterval: null, elapsedStarted: false};
  }
  var mode = basketModes[basketId] || 'timer';
  var duration = basketDurations[basketId];
  var isTimerMode = mode === 'timer';
  
  if (isTimerMode && duration !== null && duration !== undefined && duration > 0) {
    timers[basketId].secs = Math.floor(duration * 60);
  } else {
    timers[basketId].secs = 0;
  }
  timers[basketId].elapsedStarted = false; // Flag to track if elapsed timer has started
  
  // Update display
  if (typeof upd === 'function') {
    upd(basketId);
  }
  
  // Set button to preheating state (clickable to abort, but shows preheating status)
  btn.textContent = 'Preheating...';
  btn.style.background = '#f59e0b'; // amber
  btn.disabled = false; // Make it clickable so user can abort
  if (!window.preheatInProgress) {
    window.preheatInProgress = {1: false, 2: false, 3: false};
  }
  window.preheatInProgress[basketId] = true;
  
  // 1) Send preheat command to set heater temperatures
  console.log('[startTest] Sending preheat command for basket', basketId, 'temp:', setTempValue);
  try {
    let preheatResult;
    if (basketId === 1) {
      // Include preheatInProgress so rapid dual-start sends both temps (second PHW won't overwrite first)
      const otherOnOrPreheating = configuredBeakers[2] && (heaterOn[2] || (window.preheatInProgress && window.preheatInProgress[2]));
      const otherTemp = otherOnOrPreheating ? Number(setTemp[2] || 0) : 0;
      preheatResult = await sendPreheat(setTempValue, otherTemp);
    } else if (basketId === 2) {
      const otherOnOrPreheating = configuredBeakers[1] && (heaterOn[1] || (window.preheatInProgress && window.preheatInProgress[1]));
      const otherTemp = otherOnOrPreheating ? Number(setTemp[1] || 0) : 0;
      preheatResult = await sendPreheat(otherTemp, setTempValue);
    } else if (basketId === 3) {
      // For basket 3, use both temps (both heaters needed)
      const t1 = setTemp[1] || setTempValue;
      const t2 = setTemp[2] || setTempValue;
      preheatResult = await sendPreheat(t1, t2);
    }
    if (preheatResult && preheatResult.error) {
      console.error('[startTest] Preheat command failed:', preheatResult.error);
      // Show warning but don't block - continue with START command
      if (typeof showToast === 'function') {
        showToast('Failed to start heating. Please check the heater connection and try again.', 'warning');
      }
      // Don't set heaterOn to true if preheat failed - keep it false to match hardware state
      heaterOn[basketId] = false;
      if (typeof updateHeaterControlUI === 'function') {
        updateHeaterControlUI();
      }
    } else {
      console.log('[startTest] Preheat command sent successfully');
      // Set heaterOn and update UI after successful preheat (sync with hardware state)
      heaterOn[basketId] = true;
      if (typeof updateHeaterControlUI === 'function') {
        updateHeaterControlUI();
      }
    }
  } catch (e) {
    console.error('[startTest] Failed to set heater:', e, e.stack);
    // Show warning but don't block - continue with START command
    if (typeof showToast === 'function') {
      showToast('ERR_PREHEAT_FAILED', 'warning');
    }
    // Don't set heaterOn to true if exception occurred - keep it false
    heaterOn[basketId] = false;
    if (typeof updateHeaterControlUI === 'function') {
      updateHeaterControlUI();
    }
  }

  // 2) Option B behavior:
  // Arm preheat and wait for ESP32 TR1/TR2 event.
  // The ONLY confirmation popup must come from triggerTestStartPopup() when TR1/TR2 is received.
  try { startPreheatTempPolling(basketId); } catch (e) {}
  try { preheatMonitor.startMonitoring(basketId, setTempValue); } catch (e) {}
  if (typeof showToast === 'function') {
    showToast('Preheating... waiting for heater ready signal', 'info');
  }
  return;
}

// Helper function to start the elapsed timer once temperature is reached
function startElapsedTimer(basketId, mode, duration, isTimerMode) {
  console.log('[startTest] Starting elapsed timer for basket', basketId);
  if (!timers[basketId]) {
    timers[basketId] = {running: false, secs: 0, interval: null, lastUpdateTime: Date.now()};
  }
  
  // Clear any existing interval to prevent multiple timers
  if (timers[basketId].interval) {
    clearInterval(timers[basketId].interval);
    timers[basketId].interval = null;
  }
  
  // Store start time to ensure accurate timing
  timers[basketId].lastUpdateTime = Date.now();
  
  // Start the timer interval - use exact 1000ms interval
  timers[basketId].interval = setInterval(function() {
    if (!testRunning[basketId]) {
      if (timers[basketId] && timers[basketId].interval) {
        clearInterval(timers[basketId].interval);
        timers[basketId].interval = null;
      }
      return;
    }
    
    // Calculate elapsed time from actual test start time for accuracy
    const now = Date.now();
    let elapsedSeconds = 0;
    
    if (testStartTime[basketId]) {
      // Calculate elapsed time from test start
      elapsedSeconds = Math.floor((now - testStartTime[basketId]) / 1000);
    } else {
      // Fallback: use lastUpdateTime if testStartTime not available
      elapsedSeconds = Math.floor((now - timers[basketId].lastUpdateTime) / 1000);
      timers[basketId].lastUpdateTime = now;
    }
    
    if (isTimerMode && duration !== null && duration !== undefined && duration > 0) {
      // Countdown mode - calculate remaining time from duration
      const durationSeconds = Math.floor(duration * 60); // Convert minutes to seconds
      timers[basketId].secs = Math.max(0, durationSeconds - elapsedSeconds);
      if (typeof upd === 'function') {
        upd(basketId);
      }
      if (timers[basketId].secs <= 0) {
        if (typeof stopTest === 'function') {
          stopTest(basketId, { aborted: false });
        }
      }
    } else {
      // Count up mode (manual) - show actual elapsed time
      timers[basketId].secs = elapsedSeconds;
      if (typeof upd === 'function') {
        upd(basketId);
      }
    }
  }, 1000); // Exactly 1000ms interval
  
  timers[basketId].running = true;
  timers[basketId].elapsedStarted = true;
  
  // Immediately update the display to show current time
  if (typeof upd === 'function') {
    upd(basketId);
  }
  
  console.log('[startTest] Elapsed timer started for basket ' + basketId + ' (temperature reached)');
}

async function stopTest(basketId) {
  console.log('[stopTest] Called for basket', basketId);
  if (!testRunning[basketId]) {
    console.log('[stopTest] Test not running for basket', basketId);
    return;
  }
  
  var btn = document.getElementById('start' + basketId);
  if (!btn) return;
  
  // Stop all timers
  if (timers[basketId]) {
  if (timers[basketId].interval) {
    clearInterval(timers[basketId].interval);
      timers[basketId].interval = null;
    }
    if (timers[basketId].tempPollInterval) {
      clearInterval(timers[basketId].tempPollInterval);
      timers[basketId].tempPollInterval = null;
    }
  }
  
            btn.textContent = 'Start';
            btn.style.background = '#10b981';
  timers[basketId].running = false;
  testRunning[basketId] = false;
  
  // Update mode button UI to re-enable mode switching after test
  if (typeof updateModeButtonsUI === 'function') {
    updateModeButtonsUI(basketId);
  }
  
  // Send STOP command to ESP32 for this specific basket only
  console.log('[stopTest] Sending STOP command to ESP32 for basket', basketId);
  try {
    // FIX: Use per-basket stop command instead of sendStopAll() to stop only this basket
    const result = await sendStopForBasket(basketId);
    if (result && result.error) {
      console.error('[stopTest] STOP command failed:', result.error);
      if (typeof showToast === 'function') {
        showToast('Stop command failed: ' + result.error, 'error');
      }
    } else {
      console.log('[stopTest] STOP command sent successfully for basket', basketId);
      
      // After successful STOP, turn off heater for THIS basket only in UI to match hardware state
      heaterOn[basketId] = false;
      if (typeof updateHeaterControlUI === 'function') {
        updateHeaterControlUI();
      }
      console.log('[stopTest] Heater UI updated to OFF state for basket', basketId, 'only');
    }
  } catch (e) {
    console.error('[stopTest] Failed to send STOP command:', e, e.stack);
    if (typeof showToast === 'function') {
      showToast('Stop command error: ' + String(e), 'error');
    }
  }
            
  var container = document.getElementById('basket' + basketId + '-container');
            if (container) {
    // Remove active ring
    var ring = container.querySelector('.basket-active-ring');
    if (ring) ring.remove();
    
    // Reset holes to hollow state (remove completed class, but keep them visible)
    var holes = container.querySelectorAll('.basket-hole');
    for (var i = 0; i < holes.length; i++) {
      holes[i].classList.remove('completed');
      // Keep holes visible - ensure they remain visible after test
      if (configuredBeakers[basketId]) {
        var holeNumber = i + 1;
        if (holeNumber <= basketConfig) {
          holes[i].style.display = 'flex';
        }
      }
    }
    
    // Update hole visibility based on configuration (but don't hide configured holes)
    if (typeof updateBasketHoleSelection === 'function') {
      updateBasketHoleSelection(basketId);
    }
  }
  
  // DO NOT clear hole data here - saveCompletedTestReport needs it
  // basketHoles[basketId] = {};
  // holeCompletionTimes[basketId] = {};
  
  if (typeof saveCompletedTestReport === 'function') {
    try {
      var opts = (arguments.length > 1 && arguments[1]) ? arguments[1] : {};
      saveCompletedTestReport(basketId, opts);
    } catch(e) {
      console.error('Error saving report:', e);
    }
  }
  
  // IMPORTANT: Do NOT reset configuredBeakers - keep basket enabled after test
  // Just update the UI state
  if (typeof updateBasketStates === 'function') {
    updateBasketStates();
  }
  
        if (basketConfig === 1) {
    if (typeof showModal === 'function') {
      var opts = (arguments.length > 1 && arguments[1]) ? arguments[1] : {};
      showModal(opts.aborted ? 'Basket ' + basketId + ' test aborted.' : 'Basket ' + basketId + ' test completed!');
    }
  }
}

// ========== PROFILE FUNCTIONS ==========
// User profile management (because users like to see their own info)
async function saveProfile() {
  // RBAC: Check permission to edit profile
  var role = getCurrentRole();
  if (!canAccess(role, 'profile') || !canPerformAction(role, 'profile', 'edit')) {
    if (typeof showModal === 'function') {
      showModal('You do not have permission to edit your profile.');
    }
    return;
  }
  
  var nameEl = document.getElementById('profile-edit-name');
  var pwdEl = document.getElementById('profile-edit-pwd');
  
  var name = nameEl && nameEl.value ? nameEl.value.trim() : '';
  var pwd = pwdEl && pwdEl.value ? pwdEl.value : '';
  
  if (name && currentUser) {
    currentUser.name = name;
    if (pwd) {
      currentUser.password = pwd;
    }
    
    var users = await StorageAdapter.get('users') || [];
    var idx = -1;
    for (var i = 0; i < users.length; i++) {
      if (users[i].username === currentUser.username) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      users[idx] = currentUser;
      await safeSave('users', users);
      await safeSave('currentUser', currentUser);
    }
    
    if (typeof updateUIForUser === 'function') {
      updateUIForUser();
    }
    if (typeof showModal === 'function') {
      showModal('Profile updated successfully');
    }
  }
}

// ========== REPORTS FUNCTIONS ==========
// Report viewing, printing, and exporting (because paper trails are important)
// FIX: Store current filter for export functionality
var currentReportFilter = 'all';

async function loadReports(filterType) {
  try {
    // FIX: Store current filter
    if (filterType) {
      currentReportFilter = filterType;
    } else {
      currentReportFilter = 'all';
    }
    
    var filter = (filterType === 'test' || filterType === 'validation') ? filterType : 'all';
    var res = await fetch('/api/reports_meta?filter=' + encodeURIComponent(filter));
    var data = await res.json().catch(function() { return {}; });
    var reports = (data.ok && data.reports) ? data.reports : [];
    
    var tbody = document.getElementById('reports-table-body');
    if (!tbody) return;
    
    tbody.innerHTML = '';
    
    for (var i = 0; i < reports.length; i++) {
      var r = reports[i];
      var row = document.createElement('tr');
      
      // Use completedAt if available, otherwise fallback to createdAt
      var timeSource = r.completedAt || r.createdAt || null;
      var dateStr = '--:--';
      
      if (timeSource) {
        var date = new Date(timeSource);
        if (!isNaN(date.getTime())) {
          var hours = date.getHours().toString().padStart(2, '0');
          var mins = date.getMinutes().toString().padStart(2, '0');
          var datePart = date.toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit', year: 'numeric'});
          dateStr = datePart + ' ' + hours + ':' + mins;
        }
      }
      
      row.innerHTML = '<td>' + (i + 1) + '</td>' +
        '<td>' + (r.name || 'Report') + '</td>' +
        '<td>' + dateStr + '</td>' +
        '<td><button onclick="openReportPreview(' + r.id + ')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg">Open Preview</button></td>';
      
      tbody.appendChild(row);
    }
  } catch (e) {
    console.error('Error loading reports:', e);
  }
}

function filterReports(type) {
  loadReports(type);
}

// --- Report helpers (shared by saveReportPdfFromHtml, renderValidationReport, renderTestReport) ---

function formatReportDateTime(dateStr, opts) {
  opts = opts || {};
  var dateTimeSpacing = opts.dateTimeSpacing !== undefined ? opts.dateTimeSpacing : 1;
  if (!dateStr) return "N/A";
  try {
    var date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    var dd = String(date.getDate()).padStart(2, '0');
    var mm = String(date.getMonth() + 1).padStart(2, '0');
    var yyyy = date.getFullYear();
    var hh = String(date.getHours()).padStart(2, '0');
    var min = String(date.getMinutes()).padStart(2, '0');
    var spacing = ' '.repeat(Math.max(0, dateTimeSpacing));
    return dd + '-' + mm + '-' + yyyy + spacing + hh + ':' + min;
  } catch (e) {
    return dateStr;
  }
}

function formatReportDuration(seconds) {
  if (seconds !== 0 && !seconds) return "N/A";
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = seconds % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

async function getReportContext() {
  var res = await fetch('/api/report_context');
  if (!res.ok) throw new Error('Failed to fetch report context');
  var ctx = await res.json();
  return {
    companyName: ctx.companyName || "N/A",
    modelNo: ctx.modelNo || "N/A",
    serialNo: ctx.serialNo || "N/A",
    location: ctx.location || "N/A",
    instrumentId: ctx.instrumentId || "N/A",
    lastValidationDate: ctx.lastValidationDate || "",
    nextValidationDate: ctx.nextValidationDate || ""
  };
}

async function saveReportPdfToServer(reportName, pdfBase64, reportData) {
  /**
   * Save a PDF report to the server.
   * @param {string} reportName - Name of the report
   * @param {string} pdfBase64 - Base64-encoded PDF data
   * @param {Object} reportData - Full report data for text report generation
   * @returns {Promise<Object>} Server response
   */
  try {
    const res = await fetchWithTimeout('/api/save_report_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_name: reportName,
        pdf_base64: pdfBase64,
        report_data: reportData || {} // FIX: Include full report data for text report generation
      })
    }, 30000); // 30s timeout for PDF uploads
    const data = await res.json();
    
    if (res.ok && data.ok) {
      console.log('[REPORT] PDF saved successfully:', data.filename);
      if (typeof showToast === 'function') {
        showToast('Report PDF saved successfully.', 'success');
      }
      return data;
    } else {
      const errorMsg = data.error ? `${data.error}: ${data.message || 'Unknown error'}` : 'Failed to save PDF';
      console.error('[REPORT] PDF save failed:', errorMsg);
      if (typeof showToast === 'function') {
        showToast(errorMsg, 'error');
      }
      return { error: errorMsg };
    }
  } catch (e) {
    console.error('[REPORT] Exception saving PDF:', e);
    if (typeof showToast === 'function') {
      showToast('A system error occurred. Please restart the device and try again or contact support if the problem persists.', 'error');
    }
    return { error: String(e) };
  }
}

/**
 * Save a report as PDF from HTML rendering.
 * This function renders the report to HTML, sends it to the backend for PDF conversion,
 * and updates the report object with the file path.
 * @param {Object} report - The report object to save as PDF
 * @returns {Promise<boolean>} True if successful, false otherwise
 */
async function saveReportPdfFromHtml(report) {
  try {
    if (!report || !report.id) {
      console.error('[REPORT] Invalid report object for PDF generation');
      return false;
    }
    
    console.log('[REPORT] Starting PDF generation for report:', report.id, report.name);
    
    // Ensure report-content element exists and is accessible
    var reportContentEl = document.getElementById('report-content');
    if (!reportContentEl) {
      console.error('[REPORT] report-content element not found in DOM');
      // Try to find or create it - check if we're on the right screen
      var reportPreviewScreen = document.getElementById('screen-report-preview');
      if (reportPreviewScreen) {
        // Screen exists, but element might not be visible - make it temporarily visible
        reportPreviewScreen.classList.remove('hidden');
        reportContentEl = document.getElementById('report-content');
      }
      
      if (!reportContentEl) {
        console.error('[REPORT] Cannot find report-content element. Cannot generate PDF.');
        if (typeof showToast === 'function') {
          showToast('Report preview element not found. Cannot generate PDF.', 'error');
        }
        return false;
      }
    }
    
    // Make sure the report preview screen is visible (but don't navigate to it)
    var reportPreviewScreen = document.getElementById('screen-report-preview');
    var wasHidden = false;
    if (reportPreviewScreen && reportPreviewScreen.classList.contains('hidden')) {
      reportPreviewScreen.classList.remove('hidden');
      wasHidden = true;
      // Wait a moment for screen to become visible
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    
    // Render the report (this populates #report-content)
    if (report.type === 'validation') {
      if (typeof renderValidationReport === 'function') {
        renderValidationReport(report);
      } else {
        console.error('[REPORT] renderValidationReport function not found');
        return false;
      }
    } else {
      if (typeof renderTestReport === 'function') {
        renderTestReport(report);
      } else {
        console.error('[REPORT] renderTestReport function not found');
        return false;
      }
    }
    
    // Wait longer for DOM to update (rendering might be async)
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Re-get the element after rendering (in case it was recreated)
    reportContentEl = document.getElementById('report-content');
    if (!reportContentEl) {
      console.error('[REPORT] report-content element not found after rendering');
      if (wasHidden && reportPreviewScreen) {
        reportPreviewScreen.classList.add('hidden');
      }
      return false;
    }
    
    // Get the HTML content with all inline styles preserved - exactly as shown in preview
    // Clone the element to preserve all styles and attributes
    var clonedElement = reportContentEl.cloneNode(true);
    
    // Remove any elements that shouldn't be in PDF (buttons, etc.)
    var buttons = clonedElement.querySelectorAll('button, .print-export-buttons, .action-btn-large');
    for (var btnIdx = 0; btnIdx < buttons.length; btnIdx++) {
      buttons[btnIdx].remove();
    }
    
    // Ensure vessel completion tables are visible in the cloned element (for PDF)
    var vesselWrappers = clonedElement.querySelectorAll('#vessel-completion-wrapper, .vessel-completion-wrapper');
    for (var vwIdx = 0; vwIdx < vesselWrappers.length; vwIdx++) {
      var vw = vesselWrappers[vwIdx];
      if (vw) {
        vw.style.display = 'flex';
        vw.style.visibility = 'visible';
      }
    }
    
    // Ensure all vessel tables are visible in cloned element
    var vesselTables = clonedElement.querySelectorAll('#basket1-vessel-table, #basket2-vessel-table, .basket-vessel-table');
    for (var vtIdx = 0; vtIdx < vesselTables.length; vtIdx++) {
      var vt = vesselTables[vtIdx];
      if (vt) {
        vt.style.display = 'table';
        vt.style.visibility = 'visible';
      }
    }
    
    // Ensure vessel headings are visible
    var vesselHeadings = clonedElement.querySelectorAll('#basket1-vessel-heading, #basket2-vessel-heading, .basket-vessel-heading');
    for (var vhIdx = 0; vhIdx < vesselHeadings.length; vhIdx++) {
      var vh = vesselHeadings[vhIdx];
      if (vh) {
        vh.style.display = 'block';
        vh.style.visibility = 'visible';
      }
    }
    
    // Get the innerHTML from cloned element (preserves all inline styles)
    var innerHTML = clonedElement.innerHTML;
    if (!innerHTML || innerHTML.trim().length === 0) {
      console.error('[REPORT] report-content is empty after rendering');
      if (wasHidden && reportPreviewScreen) {
        reportPreviewScreen.classList.add('hidden');
      }
      return false;
    }
    
    // Compact styling for single-page PDF (reduced font sizes, padding, margins)
    var htmlContent = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' +
      (report.name || 'Report') + '</title><style>' +
      '* { box-sizing: border-box; } ' +
      'body { font-family: "Times New Roman", serif; margin: 0; padding: 0; font-size: 9pt; line-height: 1.3; color: black; background: white; } ' +
      '.report-preview-container { width: 100%; max-width: 210mm; background: white; color: black; padding: 10mm; margin: 0 auto; font-family: "Times New Roman", serif; font-size: 9pt; line-height: 1.3; } ' +
      '.report-preview-container h1 { text-align: center; font-size: 12pt; font-weight: bold; margin-bottom: 6px; color: black; } ' +
      '.report-preview-container h2 { text-align: center; font-size: 10pt; font-weight: bold; margin-bottom: 8px; color: #374151; } ' +
      '.report-preview-container h3 { font-size: 10pt; font-weight: bold; margin-top: 10px; margin-bottom: 6px; } ' +
      '.report-preview-container p { margin-bottom: 6px; } ' +
      '.report-preview-container p strong { font-weight: bold; } ' +
      '.report-preview-container table { width: 100%; border-collapse: collapse; margin: 8px 0; } ' +
      '.report-preview-container table th, .report-preview-container table td { border: 1px solid #000; padding: 4px; text-align: left; } ' +
      '.report-preview-container table th { background: #f3f4f6; font-weight: bold; } ' +
      '.signature-line { border-top: 1px solid #000; margin-top: 20px; padding-top: 5px; } ' +
      '.signature-line p { margin: 0; margin-bottom: 5px; } ' +
      // Support flex layout for vessel completion tables (side-by-side)
      '.flex { display: flex; } ' +
      '.gap-4 { gap: 16px; } ' +
      '.flex-1 { flex: 1; } ' +
      // Hide buttons and interactive elements in PDF
      '.print-export-buttons, button, .action-btn-large { display: none !important; } ' +
      '</style></head><body><div class="report-preview-container">' +
      innerHTML +
      '</div></body></html>';
    
    // Build report name - include report ID for guaranteed unique PDF filename (separate PDFs per basket when same recipe)
    var reportName = report.name || ('REPORT_' + report.id);
    // Sanitize report name (remove special chars that might cause issues)
    reportName = reportName.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim().replace(/\s+/g, '_');
    if (!reportName || reportName.length === 0) {
      reportName = 'REPORT_' + report.id;
    }
    // Append report ID so same recipe on both baskets never overwrites (e.g. Test_Report_X_Basket_1_1739123456789)
    reportName = reportName + '_' + report.id;
    
    console.log('[REPORT] Sending HTML to backend for PDF conversion. Report name:', reportName, 'HTML length:', htmlContent.length);
    
    // Send HTML to backend for PDF conversion
    // FIX: Include full report data with factory settings for text report generation
    const ctx = await getReportContext();
    const reports = await StorageAdapter.get('reports') || [];
    const enhancedReportData = {
      ...report,
      factorySettings: {
        companyName: ctx.companyName || 'N/A',
        modelNo: ctx.modelNo || 'N/A',
        serialNo: ctx.serialNo || 'N/A',
        companyLocation: ctx.location || 'N/A',
        instrumentId: ctx.instrumentId || 'N/A',
        lastValidationDate: ctx.lastValidationDate || 'N/A',
        nextValidationDate: ctx.nextValidationDate || 'N/A'
      }
    };
    
    var res = await fetchWithTimeout('/api/save_report_pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        html: htmlContent,
        report_name: reportName,
        report_data: enhancedReportData // FIX: Include full report data with factory settings
      })
    }, 30000); // 30s timeout for PDF uploads
    
    if (!res.ok) {
      console.error('[REPORT] HTTP error from PDF generation:', res.status, res.statusText);
      var errorText = await res.text();
      console.error('[REPORT] Error response:', errorText);
      if (wasHidden && reportPreviewScreen) {
        reportPreviewScreen.classList.add('hidden');
      }
      return false;
    }
    
    var data = await res.json();
    
    if (data.ok) {
      // Backend returns { ok: true, filename: "...", relative: "..." }
      // We want to store the relative filename (just the filename, not full path)
      var filename = data.relative || data.filename;
      if (filename && filename.includes('/')) {
        // Extract just the filename if it's a full path
        filename = filename.split('/').pop();
      }
      // Remove any path separators that might remain
      filename = filename.replace(/[\/\\]/g, '');
      
      console.log('[REPORT] PDF generated successfully:', filename);
      
      // Update the report object with the file field
      report.file = filename;
      
      // Save the updated report back to StorageAdapter
      // FIX: Reuse the reports variable declared earlier instead of redeclaring
      var reportIndex = -1;
      for (var i = 0; i < reports.length; i++) {
        if (reports[i].id === report.id) {
          reportIndex = i;
          break;
        }
      }
      
      if (reportIndex >= 0) {
        reports[reportIndex] = report;
        await safeSave('reports', reports);
        console.log('[REPORT] Report updated with file field:', filename);
      } else {
        console.warn('[REPORT] Report not found in storage to update file field. Report ID:', report.id);
        // Report might not be saved yet, try to save it now
        reports.push(report);
        await safeSave('reports', reports);
        console.log('[REPORT] Report saved with file field:', filename);
      }
      
      // Hide the screen again if we made it visible
      if (wasHidden && reportPreviewScreen) {
        reportPreviewScreen.classList.add('hidden');
      }
      
      return true;
    } else {
      var errorMsg = data.error ? `${data.error}: ${data.message || 'Unknown error'}` : 'Failed to generate PDF';
      console.error('[REPORT] PDF generation failed:', errorMsg);
      if (typeof showToast === 'function') {
        showToast('PDF generation failed: ' + errorMsg, 'error');
      }
      if (wasHidden && reportPreviewScreen) {
        reportPreviewScreen.classList.add('hidden');
      }
      return false;
    }
  } catch (e) {
    console.error('[REPORT] Exception generating PDF from HTML:', e, e.stack);
    if (typeof showToast === 'function') {
      showToast('Failed to generate PDF: ' + String(e), 'error');
    }
    return false;
  }
}

// --- EXPORT HELPERS: precise export handlers ---

// Generic export request
async function sendExportRequest(payload) {
  // payload: { report_id?: string, filter?: 'all'|'validation'|'test'|'preview'|'<custom>' }
  // FIX: Use correct API endpoint
  const res = await fetchWithTimeout('/api/export_reports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }, 30000); // 30s timeout for export operations
  
  if (!res.ok) {
    const txt = await res.text().catch(()=>null);
    let errorMsg = 'Export failed';
    try {
      const errorData = JSON.parse(txt);
      const code = errorData.error;
      const backendMsg = errorData.message || errorData.error || errorMsg;
      // Use friendly pendrive message when USB/export device is missing
      if (code === 'E4001' ||
          (backendMsg && backendMsg.toLowerCase().includes('pendrive')) ||
          (backendMsg && backendMsg.toLowerCase().includes('usb') && backendMsg.toLowerCase().includes('not'))) {
        errorMsg = 'Pendrive not detected. Please connect the pendrive and restart the device.';
      } else {
        errorMsg = backendMsg;
      }
    } catch (e) {
      errorMsg = txt || 'HTTP ' + res.status;
    }
    console.error('Export failed', res.status, errorMsg);
    throw new Error(errorMsg);
  }
  
  // Backend returns JSON with exported files list
  const data = await res.json();
  if (data.ok) {
    const exportedCount = data.exported ? data.exported.length : 0;
    const failedCount = data.failed ? data.failed.length : 0;
    console.log('Export successful:', exportedCount, 'exported,', failedCount, 'failed');
    return data;
  } else {
    throw new Error(data.message || data.error || 'Export failed');
  }
}

// Called when user hits "Export" on a single report's preview page
async function exportSingleReport(reportId) {
  // FIX: Get report ID from currentReportMeta if not provided
  if (!reportId && currentReportMeta && currentReportMeta.id) {
    reportId = currentReportMeta.id;
  }
  
  if (!reportId) {
    console.error('exportSingleReport called without reportId');
    if (typeof showToast === 'function') {
      showToast('No report selected for export', 'error');
    } else if (typeof showModal === 'function') {
      showModal('No report selected for export');
    }
    return;
  }
  
  if (typeof showModal === 'function') {
    showModal('Exporting report to USB... Please wait.');
  } else if (typeof showToast === 'function') {
    showToast('Exporting report to USB... Please wait.', 'info');
  }
  try {
    await sendExportRequest({ report_id: reportId });
    console.log('Exported report', reportId);
    if (typeof hideModal === 'function') hideModal();
    if (typeof showToast === 'function') {
      showToast('Report exported successfully', 'success');
    } else if (typeof showModal === 'function') {
      showModal('Report exported successfully');
    }
  } catch (e) {
    if (typeof hideModal === 'function') hideModal();
    if (typeof showToast === 'function') {
      showToast('Export failed: ' + e.message, 'error');
    } else if (typeof showModal === 'function') {
      showModal('Export failed: ' + e.message);
    } else {
      alert('Export failed: ' + e.message);
    }
  }
}

// Called when user hits the "Export" button on Reports page (should export only filtered reports)
async function exportFilteredReports() {
  const filterVal = currentReportFilter || 'all';
  if (typeof showModal === 'function') {
    showModal('Exporting reports to USB... Please wait.');
  } else if (typeof showToast === 'function') {
    showToast('Exporting reports to USB... Please wait.', 'info');
  }
  try {
    await sendExportRequest({ filter: filterVal });
    console.log('Exported reports with filter:', filterVal);
    if (typeof hideModal === 'function') hideModal();
    if (typeof showToast === 'function') {
      showToast('Reports exported successfully', 'success');
    } else if (typeof showModal === 'function') {
      showModal('Reports exported successfully');
    }
  } catch (e) {
    if (typeof hideModal === 'function') hideModal();
    if (typeof showToast === 'function') {
      showToast('Export failed: ' + e.message, 'error');
    } else if (typeof showModal === 'function') {
      showModal('Export failed: ' + e.message);
    } else {
      alert('Export failed: ' + e.message);
    }
  }
}

// Called when user hits "Export validation reports" etc.
async function exportReportsByType(type) {
  if (!type) return;
  if (typeof showModal === 'function') {
    showModal('Exporting reports to USB... Please wait.');
  } else if (typeof showToast === 'function') {
    showToast('Exporting reports to USB... Please wait.', 'info');
  }
  try {
    await sendExportRequest({ filter: type });
    console.log('Exported reports type:', type);
    if (typeof hideModal === 'function') hideModal();
    if (typeof showToast === 'function') {
      showToast('Reports exported successfully', 'success');
    }
  } catch (e) {
    if (typeof hideModal === 'function') hideModal();
    if (typeof showToast === 'function') {
      showToast('Export failed: ' + e.message, 'error');
    } else {
      alert('Export failed: ' + e.message);
    }
  }
}

// Wire buttons (call this on DOM ready)
function wireExportButtons() {
  // Preview export button (assumes button has id export-preview and data-report-id)
  const previewBtn = document.getElementById('export-preview');
  if (previewBtn) {
    previewBtn.addEventListener('click', (ev) => {
      const id = previewBtn.dataset.reportId || window.currentReportId || null;
      exportSingleReport(id);
    });
  }

  // Reports page export (assumes id export-reports)
  const reportsExportBtn = document.getElementById('export-reports');
  if (reportsExportBtn) reportsExportBtn.addEventListener('click', exportFilteredReports);

  // Buttons that export only validation/test (assumes data-export-type attr)
  document.querySelectorAll('[data-export-type]').forEach(btn => {
    btn.addEventListener('click', () => exportReportsByType(btn.dataset.exportType));
  });
}

// Legacy export function for backward compatibility
async function exportReport(reportId) {
  return exportSingleReport(reportId);
}

async function exportReports() {
  // RBAC: Check permission to export reports (reports-view allows viewing/exporting)
  var role = getCurrentRole();
  if (!canAccess(role, 'reports-view')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to export reports.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to export reports.');
    }
    return;
  }
  
  // Show a loading message because users get impatient
  if (typeof showModal === 'function') {
    showModal('Exporting reports to USB...');
  } else if (typeof showToast === 'function') {
    showToast('Exporting reports to USB...', 'info');
  }
  
  try {
    // Actually call the backend to export (because we can't just wish it into existence)
    const res = await fetchWithTimeout('/api/export_reports', { method: 'POST' }, 30000); // 30s timeout
    const data = await res.json();
    
    if (res.ok && data.ok && !data.error) {
      var msg = 'Export complete.';
      if (data.exported && data.exported.length > 0) {
        msg += ' Exported ' + data.exported.length + ' file(s).';
      }
      if (data.failed && data.failed.length > 0) {
        msg += ' ' + data.failed.length + ' file(s) failed.';
      }
      if (typeof showToast === 'function') {
        showToast(msg, 'success');
      } else if (typeof showModal === 'function') {
        showModal(msg);
      } else {
        alert('Export complete.');
      }
    } else if (data.error === 'E4001' || data.error === 'E3003' || data.error === 'export drive not mounted') {
      const msg = 'Pendrive not detected. Please connect the pendrive and restart the device.';
      if (typeof showToast === 'function') {
        showToast(data.error ? `${data.error}: ${msg}` : msg, 'error');
      } else if (typeof showModal === 'function') {
        showModal(msg);
      } else {
        alert(msg);
      }
    } else {
      const errorMsg = data.error ? `${data.error}: ${data.message || 'Unknown error'}` : `HTTP ${res.status}`;
      if (typeof showToast === 'function') {
        showToast('Export failed: ' + errorMsg, 'error');
      } else if (typeof showModal === 'function') {
        showModal('Export failed: ' + errorMsg);
      } else {
        alert('Export failed: ' + errorMsg);
      }
    }
  } catch (e) {
    console.error('Export error:', e);
    const errorMsg = e.message || 'Network error';
    if (typeof showToast === 'function') {
      showToast('Export failed: ' + errorMsg, 'error');
    } else if (typeof showModal === 'function') {
      showModal('Export failed: ' + errorMsg);
    } else {
      alert('Export failed: ' + errorMsg);
    }
  }
}

async function handlePrintA4() {
  // RBAC: Check permission to print reports (reports-view allows viewing/printing)
  var role = getCurrentRole();
  if (!canAccess(role, 'reports-view')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to print reports.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to print reports.');
    }
    return;
  }
  
  // Make sure we actually have a report selected
  if (!currentReportMeta) {
    if (typeof showToast === 'function') {
      showToast('No report selected for A4 print.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('No report selected for A4 print.');
    } else {
      alert('No report selected for A4 print.');
    }
    return;
  }
  
  try {
    // FIX: Construct report name from multiple possible sources
    var reportName = null;
    
    // Try file property first (if PDF was generated)
    if (currentReportMeta.file) {
      var fileName = currentReportMeta.file;
      // Remove path and extension
      if (fileName.includes('/')) {
        fileName = fileName.split('/').pop();
      }
      if (fileName.includes('\\')) {
        fileName = fileName.split('\\').pop();
      }
      reportName = fileName.replace(/\.(pdf|txt)$/i, '');
    }
    
    // Fallback to filename property
    if (!reportName && currentReportMeta.filename) {
      var fileName = currentReportMeta.filename;
      if (fileName.includes('/')) {
        fileName = fileName.split('/').pop();
      }
      if (fileName.includes('\\')) {
        fileName = fileName.split('\\').pop();
      }
      reportName = fileName.replace(/\.(pdf|txt)$/i, '');
    }
    
    // Fallback to relative property
    if (!reportName && currentReportMeta.relative) {
      var fileName = currentReportMeta.relative;
      if (fileName.includes('/')) {
        fileName = fileName.split('/').pop();
      }
      if (fileName.includes('\\')) {
        fileName = fileName.split('\\').pop();
      }
      reportName = fileName.replace(/\.(pdf|txt)$/i, '');
    }
    
    // Fallback to name property (sanitize it to match filename format)
    if (!reportName && currentReportMeta.name) {
      reportName = currentReportMeta.name.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim().replace(/\s+/g, '_');
    }
    
    // Final fallback: use report ID
    if (!reportName && currentReportMeta.id) {
      reportName = 'REPORT_' + currentReportMeta.id;
    }
    
    if (!reportName) {
      console.error('[Print A4] Could not determine report name from metadata:', currentReportMeta);
      if (typeof showToast === 'function') {
        showToast('Could not determine report name. Please try again.', 'error');
      } else if (typeof showModal === 'function') {
        showModal('Could not determine report name. Please try again.');
      }
      return;
    }
    
    console.log('[Print A4] Using text report file for report:', reportName, '(from metadata:', currentReportMeta, ')');
    
    // Send report data; backend enriches with factory settings and validation dates if missing
    // Ensure operator info is present (fallback to current user for old reports)
    var reportData = {
      ...currentReportMeta,
      operatorName: currentReportMeta.operatorName || (currentUser && currentUser.name) || 'N/A',
      operatorId: currentReportMeta.operatorId || (currentUser && currentUser.username) || 'N/A'
    };
    
    // Send report name to backend to load the text file, with report data as fallback
    const res = await fetchWithTimeout('/api/print_a4', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        report_name: reportName,
        report_data: reportData, // Send report data so backend can generate text file
        // Option A: force regeneration so we don't print stale cached .txt content
        force_regenerate: true
      })
    }, 20000); // 20s timeout for A4 printing
    
    const data = await res.json().catch(() => null);
    
    if (res.ok && data && data.ok) {
      var successMsg = 'A4 print sent successfully.';
      if (data.warning) {
        successMsg += ' ' + data.warning;
      }
      if (typeof showToast === 'function') {
        showToast(successMsg, 'success');
      } else if (typeof showModal === 'function') {
        showModal(successMsg);
      } else {
        alert(successMsg);
      }
      console.log('[Print A4] Print mode:', data.mode);
    } else {
      var errorMsg = (data && data.error) || 'Printer error. Check the printer connection.';
      if (typeof showToast === 'function') {
        showToast(errorMsg, 'error');
      } else if (typeof showModal === 'function') {
        showModal(errorMsg);
      } else {
        alert(errorMsg);
      }
      console.error('[Print A4] API error:', data);
    }
  } catch (e) {
    console.error('[Print A4] Error:', e);
    var errMsg = 'Printer error. Check the printer connection.';
    if (typeof showToast === 'function') {
      showToast(errMsg, 'error');
    } else if (typeof showModal === 'function') {
      showModal(errMsg);
    } else {
      alert(errMsg);
    }
  }
}

async function handlePrintThermal() {
  // RBAC: Check permission to print reports (reports-view allows viewing/printing)
  var role = getCurrentRole();
  if (!canAccess(role, 'reports-view')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to print reports.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to print reports.');
    }
    return;
  }
  
  // FIX: Ensure we have a report selected
  if (!currentReportMeta) {
    if (typeof showToast === 'function') {
      showToast('No report selected', 'error');
    } else if (typeof showModal === 'function') {
      showModal('No report selected');
    } else {
      alert('No report selected');
    }
    return;
  }
  
  try {
    // Derive report name (same logic as A4 for consistency)
    var reportName = null;
    if (currentReportMeta.file) {
      var fn = currentReportMeta.file.replace(/^.*[\\\/]/, '').replace(/\.(pdf|txt)$/i, '');
      if (fn) reportName = fn;
    }
    if (!reportName && currentReportMeta.filename) {
      var fn2 = currentReportMeta.filename.replace(/^.*[\\\/]/, '').replace(/\.(pdf|txt)$/i, '');
      if (fn2) reportName = fn2;
    }
    if (!reportName && currentReportMeta.relative) {
      var fn3 = currentReportMeta.relative.replace(/^.*[\\\/]/, '').replace(/\.(pdf|txt)$/i, '');
      if (fn3) reportName = fn3;
    }
    if (!reportName && currentReportMeta.name) {
      reportName = currentReportMeta.name.replace(/[^a-zA-Z0-9\-_\s]/g, '_').trim().replace(/\s+/g, '_');
    }
    if (!reportName && currentReportMeta.id) {
      reportName = 'REPORT_' + currentReportMeta.id;
    }
    if (!reportName) reportName = 'report';
    
    console.log('[Print Thermal] Sending report_name and report_data to backend:', reportName);
    var requestBody = {
      report_name: reportName,
      report_data: {
        ...currentReportMeta,
        operatorName: currentReportMeta.operatorName || (currentUser && currentUser.name) || 'N/A',
        operatorId: currentReportMeta.operatorId || (currentUser && currentUser.username) || 'N/A'
      },
      force_regenerate: true
    };
    
    const res = await fetchWithTimeout('/api/print_thermal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }, 20000);
    
    const result = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
    
    if (!res.ok || !result.ok) {
      var errorMsg = (result && result.error) || 'Printer error. Check the printer connection.';
      if (typeof showToast === 'function') {
        showToast(errorMsg, 'error');
      } else if (typeof showModal === 'function') {
        showModal(errorMsg);
      } else {
        alert(errorMsg);
      }
      console.error('[Print Thermal] API error:', result);
    } else {
      var successMsg = 'Thermal print sent successfully.';
      if (typeof showToast === 'function') {
        showToast(successMsg, 'success');
      } else if (typeof showModal === 'function') {
        showModal(successMsg);
      } else {
        alert(successMsg);
      }
    }
  } catch (e) {
    console.error('[Print Thermal] Error:', e);
    var errMsg = 'Printer error. Check the printer connection.';
    if (typeof showToast === 'function') {
      showToast(errMsg, 'error');
    } else if (typeof showModal === 'function') {
      showModal(errMsg);
    } else {
      alert(errMsg);
    }
  }
}

async function openReportPreview(id) {
  try {
    var reports = await StorageAdapter.get('reports') || [];
    var report = null;
    for (var i = 0; i < reports.length; i++) {
      if (reports[i].id === id) {
        report = reports[i];
        break;
      }
    }
    
    if (!report) {
      if (typeof showModal === 'function') {
        showModal('Report not found');
      }
      return;
    }
    
    // Store the report metadata for printing (because we need the file path)
    currentReportMeta = report;
    
    // Check report type and render accordingly
    if (report.type === 'validation') {
      renderValidationReport(report);
    } else {
      renderTestReport(report);
    }
    
    if (typeof navigateTo === 'function') {
      navigateTo('report-preview');
    }
  } catch (e) {
    console.error('Error opening report preview:', e);
    if (typeof showModal === 'function') {
      showModal('Error loading report');
    }
  }
}

function renderValidationReport(report) {
  // Hide test report fields, show validation report fields
  var testReportFields = document.getElementById('test-report-fields');
  var validationReportFields = document.getElementById('validation-report-fields');
  if (testReportFields) testReportFields.style.display = 'none';
  if (validationReportFields) validationReportFields.style.display = 'block';
  
  // Determine validation subtype
  var subtype = report.validationSubtype || 'temp';
  
  // Show/hide appropriate validation report section
  var tempValidationFields = document.getElementById('temp-validation-report-fields');
  var strokeValidationFields = document.getElementById('stroke-validation-report-fields');
  
  if (subtype === 'stroke') {
    // Show stroke validation fields, hide temp validation fields
    if (tempValidationFields) tempValidationFields.style.display = 'none';
    if (strokeValidationFields) strokeValidationFields.style.display = 'block';
  } else {
    // Show temp validation fields, hide stroke validation fields
    if (tempValidationFields) tempValidationFields.style.display = 'block';
    if (strokeValidationFields) strokeValidationFields.style.display = 'none';
  }
  
  // Set report title
  var titleEl = document.getElementById('report-title');
  if (titleEl) {
    var subtypeText = subtype === 'stroke' ? 'STROKE' : 'TEMP';
    titleEl.textContent = 'VALIDATION REPORT – ' + subtypeText;
  }
  
  // Populate report header fields from factory settings (same as test reports)
  (async function() {
    const ctx = await getReportContext();
    const modelEl = document.getElementById('report-model-no');
    const serialEl = document.getElementById('report-serial-no');
    const locEl = document.getElementById('report-location');
    const instrEl = document.getElementById('report-instrument-no');
    const lastValEl = document.getElementById('report-last-validation');
    const nextValEl = document.getElementById('report-next-validation');
    
    if (modelEl) modelEl.textContent = ctx.modelNo || '';
    if (serialEl) serialEl.textContent = ctx.serialNo || '';
    if (locEl) locEl.textContent = ctx.location || '';
    if (instrEl) instrEl.textContent = ctx.instrumentId || '';
    if (lastValEl) lastValEl.textContent = ctx.lastValidationDate || '';
    if (nextValEl) nextValEl.textContent = ctx.nextValidationDate || '';
  })();
  
  // Hide product info sections (not used in validation)
  var product1Table = document.querySelector('#report-product1') ? document.querySelector('#report-product1').closest('table') : null;
  var product2Table = document.querySelector('#report-product2') ? document.querySelector('#report-product2').closest('table') : null;
  if (product1Table) product1Table.style.display = 'none';
  if (product2Table) product2Table.style.display = 'none';
  
  // Render based on validation subtype
  if (subtype === 'stroke') {
    // Stroke validation report fields
    var basketEl = document.getElementById('report-basket-stroke');
    if (basketEl) {
      basketEl.textContent = 'Basket ' + (report.basket || report.beaker || 1);
    }
    
    var validationTypeEl = document.getElementById('report-validation-type-stroke');
    if (validationTypeEl) {
      validationTypeEl.textContent = 'Stroke';
    }
    
    // Strokes per minute
    var strokesPerMinEl = document.getElementById('report-strokes-per-min');
    if (strokesPerMinEl && report.strokesPerMin !== null && report.strokesPerMin !== undefined) {
      strokesPerMinEl.textContent = report.strokesPerMin + ' strokes/min';
    }
    
    // Required range
    var strokeRangeEl = document.getElementById('report-stroke-range');
    if (strokeRangeEl) {
      strokeRangeEl.textContent = '29-32 strokes/min';
    }
    
    // Pass/Fail status
    var statusEl = document.getElementById('report-status-val-stroke');
    if (statusEl) {
      statusEl.textContent = report.status || 'PASSED';
    }
    
    // Date & Time
    if (report.createdAt) {
      var dateEl = document.getElementById('report-date-stroke');
      if (dateEl) {
        var date = new Date(report.createdAt);
        dateEl.textContent = date.toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit', year: 'numeric'}) + ' ' + 
                            date.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false});
      }
    }
  } else {
    // Temperature validation report fields
    var basketEl = document.getElementById('report-basket-temp');
    if (basketEl) {
      basketEl.textContent = 'Basket ' + (report.basket || report.beaker || 1);
    }
    
    var validationTypeEl = document.getElementById('report-validation-type-temp');
    if (validationTypeEl) {
      validationTypeEl.textContent = 'Temperature';
    }
    
    // Min temperature (raw sensor, no calibration)
    if (report.minTemp != null && typeof report.minTemp === 'number' && !isNaN(report.minTemp)) {
      var minEl = document.getElementById('report-temp-min');
      if (minEl) minEl.textContent = report.minTemp.toFixed(2) + '°C';
    } else {
      var minElFallback = document.getElementById('report-temp-min');
      if (minElFallback) minElFallback.textContent = 'N/A';
    }
    
    // Max temperature (raw sensor, no calibration)
    if (report.maxTemp != null && typeof report.maxTemp === 'number' && !isNaN(report.maxTemp)) {
      var maxEl = document.getElementById('report-temp-max');
      if (maxEl) maxEl.textContent = report.maxTemp.toFixed(2) + '°C';
    } else {
      var maxElFallback = document.getElementById('report-temp-max');
      if (maxElFallback) maxElFallback.textContent = 'N/A';
    }
    
    // Max Deviation (half range from min-max)
    if (report.maxDeviation != null && typeof report.maxDeviation === 'number' && !isNaN(report.maxDeviation)) {
      var deviationEl = document.getElementById('report-deviation');
      if (deviationEl) deviationEl.textContent = report.maxDeviation.toFixed(2) + '°C';
    } else if (report.deviation != null && typeof report.deviation === 'number' && !isNaN(report.deviation)) {
      var deviationElLegacy = document.getElementById('report-deviation');
      if (deviationElLegacy) deviationElLegacy.textContent = report.deviation.toFixed(2) + '°C';
    } else {
      var deviationElFallback = document.getElementById('report-deviation');
      if (deviationElFallback) deviationElFallback.textContent = 'N/A';
    }
    
    // Pass/Fail status
    var statusEl = document.getElementById('report-status-val-temp');
    if (statusEl) {
      statusEl.textContent = report.status || 'PASSED';
    }
    
    // Date & Time
    if (report.createdAt) {
      var dateEl = document.getElementById('report-date-temp');
      if (dateEl) {
        var date = new Date(report.createdAt);
        dateEl.textContent = date.toLocaleDateString('en-GB', {day: '2-digit', month: '2-digit', year: 'numeric'}) + ' ' + 
                            date.toLocaleTimeString('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false});
      }
    }
  }
  
  // Operator name and Employee ID (use saved values, fallback to current user for old reports)
  var operatorEl = document.getElementById('report-operator-name');
  var operatorIdEl = document.getElementById('report-operator-id');
  if (operatorEl) {
    operatorEl.textContent = report.operatorName || (currentUser && currentUser.name) || '';
  }
  if (operatorIdEl) {
    operatorIdEl.textContent = report.operatorId || (currentUser && currentUser.username) || '';
  }
  
  // Hide vessel completion table (not used in validation)
  var vesselTable1 = document.getElementById('basket1-vessel-table');
  var vesselTable2 = document.getElementById('basket2-vessel-table');
  if (vesselTable1) vesselTable1.style.display = 'none';
  if (vesselTable2) vesselTable2.style.display = 'none';
  
  // Hide min/max temperatures (not used in stroke or temperature validation reports)
  var minmaxSection = document.getElementById('report-minmax-section');
  if (minmaxSection) minmaxSection.style.display = 'none';
}

function renderTestReport(report) {
  // Show test report fields, hide validation report fields
  var testReportFields = document.getElementById('test-report-fields');
  var validationReportFields = document.getElementById('validation-report-fields');
  if (testReportFields) testReportFields.style.display = 'block';
  if (validationReportFields) validationReportFields.style.display = 'none';
  
  // Show min/max temperatures (used in test reports)
  var minmaxSection = document.getElementById('report-minmax-section');
  if (minmaxSection) minmaxSection.style.display = '';
  
  // Set report title
  var titleEl = document.getElementById('report-title');
  if (titleEl) {
    titleEl.textContent = 'TEST REPORT';
  }
  
  // F2: Populate report header fields from factory settings
  (async function() {
    const ctx = await getReportContext();
    const modelEl = document.getElementById('report-model-no');
    const serialEl = document.getElementById('report-serial-no');
    const locEl = document.getElementById('report-location');
    const instrEl = document.getElementById('report-instrument-no');
    const lastValEl = document.getElementById('report-last-validation');
    const nextValEl = document.getElementById('report-next-validation');
    const operatorEl = document.getElementById('report-operator-name');
    const operatorIdEl = document.getElementById('report-operator-id');
    const remarksEl = document.getElementById('report-remarks');
    
    if (modelEl) modelEl.textContent = ctx.modelNo || '';
    if (serialEl) serialEl.textContent = ctx.serialNo || '';
    if (locEl) locEl.textContent = ctx.location || '';
    if (instrEl) instrEl.textContent = ctx.instrumentId || '';
    if (lastValEl) lastValEl.textContent = ctx.lastValidationDate || '';
    if (nextValEl) nextValEl.textContent = ctx.nextValidationDate || '';
    
    if (operatorEl) operatorEl.textContent = report.operatorName || '';
    if (operatorIdEl) operatorIdEl.textContent = report.operatorId || '';
    if (remarksEl) remarksEl.textContent = report.remarks || '';
  })();
  
  // Use existing test report rendering logic
  // This is the existing openReportPreview logic for test reports
  
  // Store current report ID for printing/export
  window.currentReportId = report.id;
  
  var testedBasket = report.basket || 1;
  var basketConfigValue = report.basketConfig || 6;
  var holeTimes = report.holeCompletionTimes || {};
  
  // Find Basket 1 and Basket 2 sections
  var reportContent = document.getElementById('report-content');
  var basket1Heading = null;
  var basket1Table = null;
  var basket2Heading = null;
  var basket2Table = null;
  
  if (reportContent) {
    var headings = reportContent.querySelectorAll('h3');
    for (var h = 0; h < headings.length; h++) {
      var headingText = headings[h].textContent || '';
      if (headingText.indexOf('Basket 1 TUBE') > -1) {
        basket1Heading = headings[h];
        var nextEl = headings[h].nextElementSibling;
        while (nextEl && nextEl.tagName !== 'TABLE') {
          nextEl = nextEl.nextElementSibling;
        }
        if (nextEl && nextEl.tagName === 'TABLE') {
          basket1Table = nextEl;
        }
      } else if (headingText.indexOf('Basket 2 TUBE') > -1) {
        basket2Heading = headings[h];
        var nextEl2 = headings[h].nextElementSibling;
        while (nextEl2 && nextEl2.tagName !== 'TABLE') {
          nextEl2 = nextEl2.nextElementSibling;
        }
        if (nextEl2 && nextEl2.tagName === 'TABLE') {
          basket2Table = nextEl2;
        }
      }
    }
  }
  
  // I: Hide vessel completion tables for timer mode
  const b1Heading = document.getElementById('basket1-vessel-heading');
  const b1Table = document.getElementById('basket1-vessel-table');
  const b2Heading = document.getElementById('basket2-vessel-heading');
  const b2Table = document.getElementById('basket2-vessel-table');
  const vesselWrapper = document.getElementById('vessel-completion-wrapper');
  
  if (report.mode === 'timer') {
    // Hide all vessel tables for timer mode
    [b1Heading, b1Table, b2Heading, b2Table, vesselWrapper].forEach(el => {
      if (el) el.style.display = 'none';
    });
  } else {
    // Show vessel tables for manual mode
    if (vesselWrapper) vesselWrapper.style.display = 'flex'; // Ensure wrapper is visible
    [b1Heading, b1Table, b2Heading, b2Table].forEach(el => {
      if (el) el.style.display = '';
    });
    // Hide/show Basket sections based on tested basket
    if (testedBasket === 1) {
      if (b1Heading) b1Heading.style.display = 'block';
      if (b1Table) b1Table.style.display = 'table';
      if (b2Heading) b2Heading.style.display = 'none';
      if (b2Table) b2Table.style.display = 'none';
    } else if (testedBasket === 2) {
      if (b1Heading) b1Heading.style.display = 'none';
      if (b1Table) b1Table.style.display = 'none';
      if (b2Heading) b2Heading.style.display = 'block';
      if (b2Table) b2Table.style.display = 'table';
    }
  }
  
  // Populate report preview screen
  var product1El = document.getElementById('report-product1');
  var batch1El = document.getElementById('report-batch1');
  var product2El = document.getElementById('report-product2');
  var batch2El = document.getElementById('report-batch2');
  var modeEl = document.getElementById('report-mode');
  var tempEl = document.getElementById('report-temp');
  var durationEl = document.getElementById('report-duration');
  var statusEl = document.getElementById('report-status');
  
  // Only show data for the tested basket
  if (testedBasket === 1) {
    if (product1El) product1El.textContent = report.productName1 || 'N/A';
    if (batch1El) batch1El.textContent = report.batch1 || 'N/A';
    // Hide Basket 2 product info table
    var product2Table = product2El ? product2El.closest('table') : null;
    if (product2Table) product2Table.style.display = 'none';
    // Hide Basket 1 product info table header if it exists separately
    var product1Table = product1El ? product1El.closest('table') : null;
    if (product1Table) product1Table.style.display = 'table';
  } else if (testedBasket === 2) {
    if (product2El) product2El.textContent = report.productName2 || 'N/A';
    if (batch2El) batch2El.textContent = report.batch2 || 'N/A';
    // Hide Basket 1 product info table
    var product1Table = product1El ? product1El.closest('table') : null;
    if (product1Table) product1Table.style.display = 'none';
    // Show Basket 2 product info table
    var product2Table = product2El ? product2El.closest('table') : null;
    if (product2Table) product2Table.style.display = 'table';
  }
  
  // Use basket-specific IDs
  var modeElId = testedBasket === 1 ? 'report-mode' : 'report-mode-2';
  var tempElId = testedBasket === 1 ? 'report-temp' : 'report-temp-2';
  var durationElId = testedBasket === 1 ? 'report-duration-1' : 'report-duration-2';
  var statusElId = testedBasket === 1 ? 'report-status-1' : 'report-status-2';
  var setDurationRowId = testedBasket === 1 ? 'report-set-duration-row-1' : 'report-set-duration-row-2';
  var setDurationElId = testedBasket === 1 ? 'report-set-duration-1' : 'report-set-duration-2';
  
  var modeEl = document.getElementById(modeElId);
  var tempEl = document.getElementById(tempElId);
  var durationEl = document.getElementById(durationElId);
  var statusEl = document.getElementById(statusElId);
  var setDurationRow = document.getElementById(setDurationRowId);
  var setDurationEl = document.getElementById(setDurationElId);
  
  // Update mode, temp, status
  if (modeEl) modeEl.textContent = report.mode || 'N/A';
  if (tempEl) tempEl.textContent = (report.setTemperature || 37.0).toFixed(1) + '°C';
  if (statusEl) statusEl.textContent = report.status || 'Completed';
  
  // Handle duration display based on mode
  var isManualMode = report.mode === 'manual';
  
  // Hide/show "Set Duration" row based on mode
  if (setDurationRow) {
    if (isManualMode) {
      // Hide "Set Duration" row for manual mode
      setDurationRow.style.display = 'none';
    } else {
      // Show "Set Duration" row for timer mode
      setDurationRow.style.display = '';
      if (setDurationEl && report.setDuration !== null && report.setDuration !== undefined) {
        var setDurationHours = Math.floor((report.setDuration || 0) / 3600);
        var setDurationMinutes = Math.floor(((report.setDuration || 0) % 3600) / 60);
        var setDurationSeconds = (report.setDuration || 0) % 60;
        var setDurationText = String(setDurationHours).padStart(2, '0') + ':' + 
                              String(setDurationMinutes).padStart(2, '0') + ':' + 
                              String(setDurationSeconds).padStart(2, '0');
        setDurationEl.textContent = setDurationText;
      } else if (setDurationEl) {
        setDurationEl.textContent = 'N/A';
      }
    }
  }
  
  // Format duration helper function
  function formatDurationSeconds(sec) {
    if (!sec && sec !== 0) return '--:--:--';
    const h = Math.floor(sec/3600).toString().padStart(2,'0');
    const m = Math.floor((sec%3600)/60).toString().padStart(2,'0');
    const s = (sec%60).toString().padStart(2,'0');
    return `${h}:${m}:${s}`;
  }
  
  // Update "Test Duration" (actual test duration) - always show
  if (durationEl) {
    // Use durationSeconds if available, otherwise compute from start/end times, fallback to duration
    var durationSec = report.durationSeconds;
    if (durationSec === undefined || durationSec === null) {
      if (report.testStartTime && report.testEndTime) {
        durationSec = Math.floor((new Date(report.testEndTime) - new Date(report.testStartTime)) / 1000);
      } else {
        durationSec = report.duration || 0;
      }
    }
    durationEl.textContent = formatDurationSeconds(durationSec);
  }
  
  // Display Start Time and End Time
  var startTimeElId = testedBasket === 1 ? 'report-start-1' : 'report-start-2';
  var endTimeElId = testedBasket === 1 ? 'report-end-1' : 'report-end-2';
  var startTimeEl = document.getElementById(startTimeElId);
  var endTimeEl = document.getElementById(endTimeElId);
  
  if (startTimeEl && report.testStartTime) {
    var startDate = new Date(report.testStartTime);
    var startDateTimeStr = startDate.toLocaleString('en-GB', {
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric',
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    startTimeEl.textContent = startDateTimeStr;
  }
  
  if (endTimeEl && report.testEndTime) {
    var endDate = new Date(report.testEndTime);
    var endDateTimeStr = endDate.toLocaleString('en-GB', {
      day: '2-digit', 
      month: '2-digit', 
      year: 'numeric',
      hour: '2-digit', 
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
    endTimeEl.textContent = endDateTimeStr;
  }
  
  // Helper function to format timestamp as HH:MM:SS
  function formatTimeHHMMSS(timestamp) {
    if (!timestamp) return '--:--:--';
    
    // Handle ISO string or millisecond timestamp
    var date;
    if (typeof timestamp === 'string') {
      date = new Date(timestamp);
    } else if (typeof timestamp === 'number') {
      // If it's a number, ensure it's in milliseconds
      var timestampMs = timestamp < 1000000000000 ? timestamp * 1000 : timestamp;
      date = new Date(timestampMs);
    } else {
      return '--:--:--';
    }
    
    if (isNaN(date.getTime()) || date.getTime() <= 0) {
      return '--:--:--';
    }
    
    var hh = String(date.getHours()).padStart(2, '0');
    var mm = String(date.getMinutes()).padStart(2, '0');
    var ss = String(date.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }
  
  // Get vessel completion timestamps (absolute time when tapped)
  // Prefer report.vesselTimes (ISO strings) first, then report.holeCompletionTimestamps
  var vesselTimes = report.vesselTimes || {};
  var holeTimestamps = report.holeCompletionTimestamps || {};
  
  // Update vessel time elements by ID (primary method)
  var vesselIdOffset = testedBasket === 1 ? 0 : 6; // Basket 1 uses vessel1-time to vessel6-time, Basket 2 uses vessel7-time to vessel12-time
  for (var vid = 1; vid <= 6; vid++) {
    var vesselTimeEl = document.getElementById('vessel' + (vid + vesselIdOffset) + '-time');
    var vesselRow = vesselTimeEl ? vesselTimeEl.closest('tr') : null;
    
    if (vid <= basketConfigValue) {
      // Show this vessel
      if (vesselRow) vesselRow.style.display = '';
      if (vesselTimeEl) {
        var vesselKey = String(vid);
        var ts = null;
        
        // Prefer report.vesselTimes (ISO strings) first
        if (vesselTimes && vesselTimes[vesselKey]) {
          ts = vesselTimes[vesselKey];
        } else if (vesselTimes && vesselTimes[vid]) {
          ts = vesselTimes[vid];
        } else if (vesselTimes && vesselTimes[Number(vid)]) {
          ts = vesselTimes[Number(vid)];
        }
        // Fallback to holeCompletionTimestamps
        else if (holeTimestamps && holeTimestamps[vesselKey]) {
          ts = holeTimestamps[vesselKey];
        } else if (holeTimestamps && holeTimestamps[vid]) {
          ts = holeTimestamps[vid];
        } else if (holeTimestamps && holeTimestamps[Number(vid)]) {
          ts = holeTimestamps[Number(vid)];
        }
        
        // Format and display the time as duration (relative to test start)
        // If ts is already in HH:MM:SS format, use it directly
        if (ts && typeof ts === 'string' && ts.match(/^\d{2}:\d{2}:\d{2}$/)) {
          vesselTimeEl.textContent = ts; // Already in duration format
        } else if (ts && report.testStartTime) {
          // Try to parse as ISO string and convert to duration
          var vesselStartTime = new Date(ts);
          if (!isNaN(vesselStartTime.getTime())) {
            var testStart = new Date(report.testStartTime);
            var vesselDurationSec = Math.floor((vesselStartTime.getTime() - testStart.getTime()) / 1000);
            vesselTimeEl.textContent = formatDurationSeconds(vesselDurationSec);
          } else {
        vesselTimeEl.textContent = formatTimeHHMMSS(ts);
          }
        } else {
          vesselTimeEl.textContent = formatTimeHHMMSS(ts);
        }
      }
    } else {
      // Hide unused vessels
      if (vesselRow) vesselRow.style.display = 'none';
      if (vesselTimeEl) {
        vesselTimeEl.textContent = '';
      }
    }
  }
  
  // Display min/max temperatures - use actual recorded values from test
  var minmaxEl = document.getElementById('report-minmax');
  if (!minmaxEl) {
    // Try basket-specific ID
    minmaxEl = document.getElementById('report-minmax-' + testedBasket);
  }
  if (minmaxEl) {
    // Only use actual recorded min/max temperatures from the test
    if (report.minTemp !== undefined && report.maxTemp !== undefined && 
        report.minTemp !== null && report.maxTemp !== null &&
        typeof report.minTemp === 'number' && typeof report.maxTemp === 'number' &&
        !isNaN(report.minTemp) && !isNaN(report.maxTemp)) {
      minmaxEl.textContent = report.minTemp.toFixed(2) + '°C / ' + report.maxTemp.toFixed(2) + '°C';
    } else {
      // If no temperature data was recorded, show N/A instead of assuming values
      minmaxEl.textContent = 'N/A (No temperature data recorded)';
      console.warn('[renderTestReport] No valid min/max temperature data in report for basket ' + testedBasket, {
        minTemp: report.minTemp,
        maxTemp: report.maxTemp
      });
    }
  }
}

// ========== VALIDATION FUNCTIONS ==========
// Validation and calibration stuff (because equipment needs to be validated, apparently)
function selectBeakerForValidation(beakerId) {
  validationBeaker = beakerId;
  var beakerNumEl = document.getElementById('val-beaker-num');
  if (beakerNumEl) {
    beakerNumEl.textContent = beakerId;
  }
  if (typeof navigateTo === 'function') {
    navigateTo('validate-type-select');
  }
}

function navigateToValidateFlow() {
  if (typeof navigateTo === 'function') {
    navigateTo('validate');
  }
}

async function navigateToCalibration() {
  // RBAC: Check permission to access calibration
  var role = getCurrentRole();
  if (!canAccess(role, 'validate-temp-calibration')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to calibrate temperature.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to calibrate temperature.');
    }
    return;
  }
  
  // FIX: Show beaker selection first, then navigate to calibration screen
  var selectedBeaker = await showCalibrationBeakerSelection();
  
  // If user cancelled, do nothing
  if (selectedBeaker === null) {
    return;
  }
  
  // Get the beaker number
  var beakerNum = selectedBeaker;
  
  // Store the selected beaker for calibration
  validationBeaker = beakerNum;
  
  // Temps from bridge SSE (window.latestTemps)
  try {
    var data = window.latestTemps || {};
    
    // Get internal (IR) and external (EXT) temps for selected beaker: Beaker 1=IR1+EXT1, Beaker 2=IR2+EXT2
    var internalTemp = 37.0;
    var externalTemp = 25.0;
    if (beakerNum === 1 && data.IR1 !== undefined && data.EXT1 !== undefined) {
      internalTemp = data.IR1;
      externalTemp = data.EXT1;
    } else if (beakerNum === 2 && data.IR2 !== undefined && data.EXT2 !== undefined) {
      internalTemp = data.IR2;
      externalTemp = data.EXT2;
    }
    
    // Navigate to calibration input screen and populate values
    var beakerNumEl = document.getElementById('calibration-beaker-num');
    var internalTempInput = document.getElementById('calibration-internal-temp-input');
    var externalTempInput = document.getElementById('calibration-external-temp-input');
    var measuredTempInput = document.getElementById('calibration-measured-temp-input');
    
    if (beakerNumEl) beakerNumEl.textContent = beakerNum;
    
    // Populate internal (IR) and external (EXT) read-only displays
    if (internalTempInput) {
      internalTempInput.value = internalTemp.toFixed(1) + '°C';
      internalTempInput.readOnly = true;
      internalTempInput.style.opacity = '0.9';
      internalTempInput.style.cursor = 'not-allowed';
    }
    if (externalTempInput) {
      externalTempInput.value = externalTemp.toFixed(1) + '°C';
      externalTempInput.readOnly = true;
      externalTempInput.style.opacity = '0.9';
      externalTempInput.style.cursor = 'not-allowed';
    }
    
    // Clear measured temp input for operator entry
    if (measuredTempInput) {
      measuredTempInput.value = '';
      measuredTempInput.placeholder = 'Enter measured temp';
      measuredTempInput.readOnly = false;
    }
    
    // Navigate to calibration screen
    if (typeof navigateTo === 'function') {
      navigateTo('temp-calibration-input');
    }
    
    // Initialize lucide icons after navigation
    setTimeout(function() {
      if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
      }
    }, 100);
  } catch (e) {
    console.error('[Calibration] Error fetching temperature:', e);
    if (typeof showModal === 'function') {
      showModal('Failed to read system temperature. Please try again.');
    }
  }
}

function updateValidationSelection() {
  var stroke = document.getElementById('val-stroke');
  var temp = document.getElementById('val-temp');
  var strokeRadio = document.querySelector('input[name="val-type"][value="stroke"]');
  var tempRadio = document.querySelector('input[name="val-type"][value="temp"]');
  
  if (strokeRadio && strokeRadio.checked) {
    if (stroke) stroke.classList.add('selected');
    if (temp) temp.classList.remove('selected');
  } else if (tempRadio && tempRadio.checked) {
    if (temp) temp.classList.add('selected');
    if (stroke) stroke.classList.remove('selected');
  }
}

function startValidationProcess() {
  // RBAC: Check permission to start validation
  var role = getCurrentRole();
  if (!canAccess(role, 'validate') || !canPerformAction(role, 'validate', 'start')) {
    if (typeof showModal === 'function') {
      showModal('You do not have permission to start validation.');
    }
    return;
  }
  
  var selected = document.querySelector('input[name="val-type"]:checked');
  if (!selected) {
    if (typeof showModal === 'function') {
      showModal('Please select a validation type');
    }
    return;
  }
  validationType = selected.value;
  
  // Set validation in progress flag
  window.validationInProgress = true;
  
  if (validationType === 'stroke') {
    // Reset stroke validation state - use per-basket tracking
    var beaker = validationBeaker || 1;
    strokeCount = 0;
    lastStrokeReadingByBasket[beaker] = 0;
    lastStrokeReading = 0; // Legacy compatibility
    
    // Update UI
    var strokeBeakerEl = document.getElementById('stroke-beaker');
    var strokeCounterEl = document.getElementById('stroke-counter');
    var statusCardEl = document.getElementById('stroke-validation-status-card');
    var statusTextEl = document.getElementById('stroke-validation-status-text');
    
    if (strokeBeakerEl) strokeBeakerEl.textContent = beaker;
    if (strokeCounterEl) strokeCounterEl.textContent = '0';
    
    // Hide status card initially
    if (statusCardEl) {
      statusCardEl.style.display = 'none';
      statusCardEl.className = 'p-4 rounded-xl border-2 mb-4 w-full'; // Reset classes
    }
    
    // Disable and grey out the Complete & Save button at start
    var completeBtn = document.getElementById('stroke-complete-btn');
    if (completeBtn) {
      completeBtn.disabled = true;
      completeBtn.style.opacity = '0.5';
      completeBtn.style.cursor = 'not-allowed';
      completeBtn.className = 'w-full bg-gray-600 text-white flex items-center justify-center gap-2 py-3 rounded-xl font-semibold';
    }
    
    // REMOVED: ESP stroke counting call - using simulated data only
    // Stroke counting now handled by auto-increment in startStrokeValidationReal()
    // No ESP commands needed
    
    // Start real stroke validation
    startStrokeValidationReal();
    
    // Navigate to stroke validation screen
    if (typeof navigateTo === 'function') {
      navigateTo('stroke-validation');
    }
  } else if (validationType === 'temp') {
    var tempBeakerEl = document.getElementById('temp-beaker');
    if (tempBeakerEl) tempBeakerEl.textContent = validationBeaker;
    // Don't start validation automatically - wait for user to apply set temperature
    if (typeof initializeTemperatureValidationReal === 'function') {
      initializeTemperatureValidationReal();
    }
    if (typeof navigateTo === 'function') {
      navigateTo('temp-validation');
    }
    // Update toggle button to show start state initially
    setTimeout(function() {
      updateTempValidationToggleButton();
    }, 100);
  }
}

async function stopValidation() {
  console.log('[Validation] stopValidation');
  
  // CHANGED: Clear testRunning and preheatInProgress flags
  if (testRunning) {
    testRunning[1] = false;
    testRunning[2] = false;
  }
  if (window.preheatInProgress) {
    window.preheatInProgress[1] = false;
    window.preheatInProgress[2] = false;
  }
  
  // FIX 5: COMPLETE CLEANUP FOR STROKE VALIDATION
  if (strokeValidationAutoIncrementInterval) {
    clearInterval(strokeValidationAutoIncrementInterval);
    strokeValidationAutoIncrementInterval = null;
  }
  if (window.strokeValidationStopTimer) {
    clearTimeout(window.strokeValidationStopTimer);
    window.strokeValidationStopTimer = null;
  }
  if (strokeValidationInterval) {
    clearInterval(strokeValidationInterval);
    strokeValidationInterval = null;
  }
  if (strokeValidationEventSource) {
    try {
      strokeValidationEventSource.close();
    } catch (e) {
      console.warn('[stopValidation] Error closing EventSource:', e);
    }
    strokeValidationEventSource = null;
  }
  if (strokeValidationListener) {
    try {
      window.removeEventListener('hardware:data', strokeValidationListener);
  } catch (e) {
      console.warn('[stopValidation] Error removing stroke listener:', e);
  }
    strokeValidationListener = null;
  }
  
  // Reset stroke state variables
  var beaker = validationBeaker || 1;
  strokeCount = 0;
  lastStrokeReadingByBasket[beaker] = 0;
  lastStrokeReading = 0;
  strokeValidationStartTime = null;
  
  // Clear temperature validation timers and state
  if (tempValidationInterval) {
    clearInterval(tempValidationInterval);
    tempValidationInterval = null;
  }
  if (tempValidationTimer) {
    clearTimeout(tempValidationTimer);
    tempValidationTimer = null;
  }
  
  // Reset temperature validation state variables
  tempValidationRunning = false;
  tempValidationElapsedStarted = false;
  tempValidationStartTime = null;
  lastTempValidationMaxDeviation = 0;
  lastTempValidationMinTemp = null;
  lastTempValidationMaxTemp = null;
  tempValidationPreheatArmed = false;
  if (typeof stopTempValidationTempPoll === 'function') stopTempValidationTempPoll();
  
  // Update UI elements to reflect stopped state
  var statusEl = document.getElementById('validation-status');
  var messageEl = document.getElementById('validation-message');
  var elapsedTimeEl = document.getElementById('temp-validation-elapsed');
  var buttonsContainer = document.getElementById('temp-validation-buttons');
  var calibrateBtn = document.getElementById('calibrate-temp-btn');
  
  if (statusEl) {
    statusEl.textContent = 'Stopped';
    statusEl.style.color = '#9ca3af';
  }
  if (messageEl) {
    messageEl.textContent = 'Validation stopped';
    messageEl.style.color = '#9ca3af';
  }
  if (buttonsContainer) {
    buttonsContainer.style.display = 'none';
  }
  if (calibrateBtn) {
    calibrateBtn.style.display = 'none';
  }
  
  isCalibrating = false;
  
  // Update toggle button to show start state
  updateTempValidationToggleButton();
  updateValidationStopButton();
  
  // Send STOP command to ESP32 (only once) - global stop for validation
  try {
    await sendStopAll('stopValidation');
  } catch(e) {
    console.error('[Validation] Failed to send STOP command:', e);
  }
  
  // Set flag at the END after all cleanup
  window.validationInProgress = false;
  
  // Reset validation parameters for next run
  tempValidationSetTemp = 37.0;
  var setTempContainer = document.getElementById('temp-validation-set-temp-container');
  if (setTempContainer) setTempContainer.style.display = '';
  if (typeof initializeTemperatureValidationReal === 'function') {
    initializeTemperatureValidationReal();
  }
  
  if (typeof showToast === 'function') {
    showToast('Validation stopped', 'info');
  }
  
  // Don't navigate away - let user stay on validation screen
}

// FIX: Toggle temperature validation (start/stop)
async function toggleTempValidation() {
  // Check if we're on the temperature validation screen
  var tempValidationScreen = document.getElementById('screen-temp-validation');
  if (!tempValidationScreen || !tempValidationScreen.classList.contains('active')) {
    return;
  }
  
  // If validation is running, stop it
  if (tempValidationRunning || tempValidationInterval) {
    await stopValidation();
    return;
  }
  
  // If armed (waiting for TR), cancel preheat
  if (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed) {
    tempValidationPreheatArmed = false;
    window.validationInProgress = false;
    if (typeof stopTempValidationTempPoll === 'function') stopTempValidationTempPoll();
    try { await sendStopAll('stopValidation'); } catch (e) { console.warn('[toggleTempValidation] Stop error:', e); }
    if (typeof showToast === 'function') showToast('Preheat cancelled', 'info');
    var statusEl = document.getElementById('validation-status');
    var messageEl = document.getElementById('validation-message');
    if (statusEl) { statusEl.textContent = 'Cancelled'; statusEl.style.color = '#9ca3af'; }
    if (messageEl) { messageEl.textContent = 'Preheat cancelled'; messageEl.style.color = '#9ca3af'; }
    updateTempValidationToggleButton();
    updateValidationStopButton();
    return;
  }
  
  // START: Apply set temp and start preheat (works whether set temp container is visible or hidden)
  if (typeof applyValidationSetTemp === 'function') {
    applyValidationSetTemp();
  }
}

function startTempValidationTempPoll() {
  stopTempValidationTempPoll();
  tempValidationTempPollInterval = setInterval(function() {
    var screen = document.getElementById('screen-temp-validation');
    if (!screen || !screen.classList.contains('active')) return;
    if (window.latestTemps && Object.keys(window.latestTemps).length > 0 && typeof applyTempsToUI === 'function') {
      applyTempsToUI(window.latestTemps);
    }
  }, 1000);
}

function stopTempValidationTempPoll() {
  if (tempValidationTempPollInterval) {
    clearInterval(tempValidationTempPollInterval);
    tempValidationTempPollInterval = null;
  }
}

// Exit temperature validation - stop everything and navigate away
function exitTempValidation() {
  if (typeof stopValidation === 'function') {
    stopValidation();
  }
  try {
    if (typeof sendStopAll === 'function') sendStopAll('exitTempValidation');
  } catch (e) {
    console.warn('[exitTempValidation] Stop error:', e);
  }
  if (typeof navigateTo === 'function') {
    navigateTo('validate-type-select');
  }
}

window.exitTempValidation = exitTempValidation;

// FIX: Update toggle button appearance based on validation state
function updateTempValidationToggleButton() {
  var toggleBtn = document.getElementById('temp-validation-toggle-btn');
  var toggleIcon = document.getElementById('temp-validation-toggle-icon');
  
  if (!toggleBtn || !toggleIcon) {
    return;
  }
  
  if (tempValidationRunning || tempValidationInterval || (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed)) {
    // Validation running or preheating (armed) - show stop/cancel button (red)
    toggleBtn.className = 'text-red-400 hover:text-red-300 p-3 rounded-full hover:bg-gray-700';
    toggleIcon.setAttribute('data-lucide', 'square');
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  } else {
    // Validation is not running - show start button (green)
    toggleBtn.className = 'text-green-400 hover:text-green-300 p-3 rounded-full hover:bg-gray-700';
    toggleIcon.setAttribute('data-lucide', 'play');
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  }
  
  // Also update the big button at the bottom
  updateValidationStopButton();
}

// FIX: Update the big validation stop button at the bottom
function updateValidationStopButton() {
  var stopBtn = document.getElementById('validation-stop-btn');
  var stopBtnIcon = document.getElementById('validation-stop-btn-icon');
  var stopBtnText = document.getElementById('validation-stop-btn-text');
  
  if (!stopBtn || !stopBtnIcon || !stopBtnText) {
    return;
  }
  
  if (tempValidationRunning || tempValidationInterval || (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed)) {
    // Validation running or preheating (armed) - show stop/cancel button (red)
    stopBtn.className = 'w-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center gap-2 border-2 border-red-500 shadow-lg py-4 rounded-xl font-bold';
    stopBtnIcon.setAttribute('data-lucide', 'square');
    stopBtnText.textContent = 'HEATING';
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  } else {
    // Validation is not running - show start button (green)
    stopBtn.className = 'w-full bg-green-600 hover:bg-green-700 active:bg-green-800 text-white flex items-center justify-center gap-2 border-2 border-green-500 shadow-lg py-4 rounded-xl font-bold';
    stopBtnIcon.setAttribute('data-lucide', 'play');
    stopBtnText.textContent = 'START';
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  }
}

// FIX: Start stroke validation with auto-increment every 2 seconds (reaches 30 strokes in 60 seconds)
var strokeValidationAutoIncrementInterval = null;

function startStrokeValidationReal() {
  var beakerNum = validationBeaker || 1;
  var strokeKey = beakerNum === 1 ? 'S1' : 'S2';
  
  // Reset state - use per-basket tracking
  strokeCount = 0;
  lastStrokeReadingByBasket[beakerNum] = 0;
  lastStrokeReading = 0; // Legacy compatibility
  strokeValidationStartTime = Date.now();
  
  // FIX: Send START command to ESP32 to start motor strokes
  (async function() {
    try {
      console.log('[Stroke Validation] Sending START command for basket', beakerNum);
      var startEndpoint = beakerNum === 1 ? '/api/start-b1' : '/api/start-b2';
      // Use room temperature (25°C) for stroke validation - we just need motor, not heater
      var result = await postJson(startEndpoint, { temp: 25.0 });
      if (result.error) {
        console.error('[Stroke Validation] Failed to send START command:', result.error);
        if (typeof showToast === 'function') {
          showToast('Failed to start motor for stroke validation', 'error');
        }
      } else {
        console.log('[Stroke Validation] START command sent successfully:', result);
      }
    } catch (e) {
      console.error('[Stroke Validation] Exception sending START command:', e);
    }
  })();
  
  // FIX: Set timer to send STOP command after 1 minute (60 seconds)
  var strokeStopTimer = setTimeout(async function() {
    try {
      console.log('[Stroke Validation] Sending STOP command after 1 minute');
      if (typeof sendStopAll === 'function') {
        await sendStopAll('stroke-validation-timer');
        console.log('[Stroke Validation] STOP command sent successfully');
      }
    } catch (e) {
      console.error('[Stroke Validation] Failed to send STOP command:', e);
    }
  }, 60000); // 60 seconds = 1 minute
  
  // Store timer reference for cleanup
  window.strokeValidationStopTimer = strokeStopTimer;
  
  // FIX: Auto-increment strokes every 2 seconds (reaches 30 strokes in 60 seconds)
  // Clear any existing auto-increment interval first
  if (strokeValidationAutoIncrementInterval) {
    clearInterval(strokeValidationAutoIncrementInterval);
    strokeValidationAutoIncrementInterval = null;
  }
  
  // Start auto-increment interval - increments by 1 every 2 seconds
  strokeValidationAutoIncrementInterval = setInterval(function() {
    strokeCount++;
    
    // Update UI immediately
    var strokeCounterEl = document.getElementById('stroke-counter');
    if (strokeCounterEl) {
      strokeCounterEl.textContent = strokeCount;
    }
    
    console.log('[Stroke Validation] Auto-incremented to', strokeCount, 'strokes');
    
    // Stop at 30 strokes (reached in 60 seconds: 30 * 2 = 60)
    if (strokeCount >= 30) {
      clearInterval(strokeValidationAutoIncrementInterval);
      strokeValidationAutoIncrementInterval = null;
    }
  }, 2000); // Every 2 seconds
  
  // FIX: Removed ESP stroke reading logic - only use auto-increment
  // No event listeners for hardware:data - strokes are auto-incremented only
  
  // Start 60-second timer
  strokeValidationInterval = setInterval(function() {
    var elapsed = Date.now() - strokeValidationStartTime;
    var elapsedSeconds = Math.floor(elapsed / 1000);
    
      // After 60 seconds, evaluate pass/fail
      if (elapsedSeconds >= 60) {
        // Clear intervals
        clearInterval(strokeValidationInterval);
        strokeValidationInterval = null;
        
        // FIX: Clear auto-increment interval
        if (strokeValidationAutoIncrementInterval) {
          clearInterval(strokeValidationAutoIncrementInterval);
          strokeValidationAutoIncrementInterval = null;
        }
        
        // Close EventSource if it exists (screen-specific subscription)
        if (strokeValidationEventSource) {
          try {
            strokeValidationEventSource.close();
          } catch (e) {
            console.warn('[Stroke Validation] Error closing EventSource:', e);
          }
          strokeValidationEventSource = null;
        }
        
        // FIX: Send STOP command to ESP32 after 1 minute validation completes
        (async function() {
          try {
            console.log('[Stroke Validation] Sending STOP command after 1 minute validation');
            if (typeof sendStopAll === 'function') {
              await sendStopAll('stroke-validation-complete');
              console.log('[Stroke Validation] STOP command sent successfully');
            }
          } catch (e) {
            console.error('[Stroke Validation] Failed to send STOP command:', e);
          }
        })();
        
        // Clear stop timer if it still exists (in case it hasn't fired yet)
        if (window.strokeValidationStopTimer) {
          clearTimeout(window.strokeValidationStopTimer);
          window.strokeValidationStopTimer = null;
        }
        
        // Calculate strokes per minute (we counted strokes over 60 seconds)
        var strokesPerMin = strokeCount;
      
      // Determine pass/fail (29-32 strokes/min inclusive)
      var passed = (strokesPerMin >= 29 && strokesPerMin <= 32);
      
      console.log('[Stroke Validation] Final count:', strokesPerMin, 'strokes/min. Pass:', passed);
      
      // Show status card (with null checks to prevent crashes)
      try {
        var statusCardEl = document.getElementById('stroke-validation-status-card');
        var statusTextEl = document.getElementById('stroke-validation-status-text');
        var completeBtn = document.getElementById('stroke-complete-btn');
        
        if (statusCardEl && statusTextEl) {
          statusCardEl.style.display = 'block';
          
          if (passed) {
            // PASS - green
            statusCardEl.className = 'bg-green-600 p-4 rounded-xl border-2 border-green-700 mb-4 w-full';
            statusTextEl.textContent = 'VALIDATION PASSED (' + strokesPerMin + ' strokes/min)';
            statusTextEl.className = 'text-lg font-bold text-center text-white';
            
            // Enable Complete & Save button and make it green
            if (completeBtn) {
              completeBtn.disabled = false;
              completeBtn.style.opacity = '1';
              completeBtn.style.cursor = 'pointer';
              completeBtn.className = 'w-full bg-green-600 hover:bg-green-700 active:bg-green-800 text-white flex items-center justify-center gap-2 py-3 rounded-xl font-semibold';
            }
            
            // Clear validationInProgress flag BEFORE auto-completing
            window.validationInProgress = false;
            
            // Automatically save and exit after showing result
            setTimeout(function() {
              try {
                completeValidation('stroke');
              } catch (e) {
                console.error('[Stroke Validation] Error in completeValidation:', e);
                if (typeof navigateTo === 'function') {
                  navigateTo('dashboard');
                }
              }
            }, 1500);
          } else {
            // FAIL - red
            statusCardEl.className = 'bg-red-600 p-4 rounded-xl border-2 border-red-700 mb-4 w-full';
            statusTextEl.textContent = 'VALIDATION FAILED (' + strokesPerMin + ' strokes/min)';
            statusTextEl.className = 'text-lg font-bold text-center text-white';
            
            // Enable Complete & Save button but keep it red
            if (completeBtn) {
              completeBtn.disabled = false;
              completeBtn.style.opacity = '1';
              completeBtn.style.cursor = 'pointer';
              completeBtn.className = 'w-full bg-red-600 hover:bg-red-700 active:bg-red-800 text-white flex items-center justify-center gap-2 py-3 rounded-xl font-semibold';
            }
            
            // Clear validationInProgress flag
            window.validationInProgress = false;
            
            // Show modal and auto-complete
            if (typeof showModal === 'function') {
              showModal('Stroke count is out of range. Required: 29-32 strokes/min. Actual: ' + strokesPerMin + ' strokes/min.', function() {
                try {
                  completeValidation('stroke');
                } catch (e) {
                  console.error('[Stroke Validation] Error in completeValidation:', e);
                  if (typeof navigateTo === 'function') {
                    navigateTo('dashboard');
                  }
                }
              });
            } else {
              setTimeout(function() {
                try {
                  completeValidation('stroke');
                } catch (e) {
                  console.error('[Stroke Validation] Error in completeValidation:', e);
                }
              }, 2000);
            }
          }
        } else {
          // Status card elements not found - log and show toast/modal
          console.warn('[Stroke Validation] Status card elements not found');
          window.validationInProgress = false;
          if (typeof showToast === 'function') {
            showToast('Validation ' + (passed ? 'PASSED' : 'FAILED') + ': ' + strokesPerMin + ' strokes/min', passed ? 'success' : 'error');
          }
          // Still try to complete validation
          setTimeout(function() {
            try {
              completeValidation('stroke');
            } catch (e) {
              console.error('[Stroke Validation] Error in completeValidation:', e);
            }
          }, 1000);
        }
      } catch (e) {
        console.error('[Stroke Validation] Error showing status card:', e);
        window.validationInProgress = false;
        // Fallback: try to complete validation anyway
        try {
          completeValidation('stroke');
        } catch (e2) {
          console.error('[Stroke Validation] Error in completeValidation fallback:', e2);
        }
      }
    }
  }, 500); // Check every 500ms
}

async function completeValidation(type) {
  // FIX 4: Prevent duplicate calls
  if (validationCompletionInProgress) {
    console.warn('[completeValidation] Validation completion already in progress, ignoring duplicate call');
    return;
  }
  
  validationCompletionInProgress = true;
  
  // FIX: Capture stroke count BEFORE any cleanup/reset happens
  var finalStrokeCount = strokeCount || 0;
  
  // FIX: Capture temp validation values BEFORE cleanup resets them
  var capturedTempValidationSetTemp = tempValidationSetTemp || 37.0;
  var capturedLastTempValidationMaxDeviation = lastTempValidationMaxDeviation;
  var capturedLastTempValidationMinTemp = lastTempValidationMinTemp;
  var capturedLastTempValidationMaxTemp = lastTempValidationMaxTemp;
  
  try {
    // FIX 1: DON'T set validationInProgress = false here - do it at the END after cleanup
  
  // PATCH 1: Exit stroke validation screen
  if (typeof exitStrokeValidationScreen === 'function') {
    exitStrokeValidationScreen();
  }
  
    // FIX 2: COMPLETE CLEANUP FOR STROKE VALIDATION
    if (type === 'stroke' || strokeValidationInterval || strokeValidationAutoIncrementInterval) {
      // Clear auto-increment interval
      if (strokeValidationAutoIncrementInterval) {
        clearInterval(strokeValidationAutoIncrementInterval);
        strokeValidationAutoIncrementInterval = null;
      }
      
      // Clear stop timer
      if (window.strokeValidationStopTimer) {
        clearTimeout(window.strokeValidationStopTimer);
        window.strokeValidationStopTimer = null;
      }
      
      // Clear stroke interval
      if (strokeValidationInterval) {
        try {
          clearInterval(strokeValidationInterval);
        } catch (e) {
          console.warn('[completeValidation] Error clearing stroke interval:', e);
        }
        strokeValidationInterval = null;
      }
      
      // Close EventSource if it exists
  if (strokeValidationEventSource) {
    try {
      strokeValidationEventSource.close();
    } catch (e) {
      console.warn('[completeValidation] Error closing EventSource:', e);
    }
    strokeValidationEventSource = null;
  }
  
      // Remove event listener if it exists
      if (strokeValidationListener) {
    try {
          window.removeEventListener('hardware:data', strokeValidationListener);
    } catch (e) {
          console.warn('[completeValidation] Error removing stroke listener:', e);
        }
        strokeValidationListener = null;
      }
      
      // Reset stroke state variables (finalStrokeCount already captured at function start)
      var beaker = validationBeaker || 1;
      strokeCount = 0;
      lastStrokeReadingByBasket[beaker] = 0;
      lastStrokeReading = 0;
      strokeValidationStartTime = null;
    }
    
    // FIX 3: COMPLETE CLEANUP FOR TEMPERATURE VALIDATION
    if (type === 'temp' || tempValidationInterval) {
      if (tempValidationInterval) {
        clearInterval(tempValidationInterval);
        tempValidationInterval = null;
      }
      if (tempValidationTimer) {
        clearTimeout(tempValidationTimer);
        tempValidationTimer = null;
      }
      
      // Reset temperature validation state
      tempValidationRunning = false;
      tempValidationElapsedStarted = false;
      tempValidationStartTime = null;
      lastTempValidationMaxDeviation = 0;
      lastTempValidationMinTemp = null;
      lastTempValidationMaxTemp = null;
      
      // Update UI
      updateTempValidationToggleButton();
      updateValidationStopButton();
      
      // Reset validation parameters for next run
      tempValidationSetTemp = 37.0;
      var setTempContainer = document.getElementById('temp-validation-set-temp-container');
      if (setTempContainer) setTempContainer.style.display = '';
    }
    
    // Create and save report
  try {
    // Use bridge RTC datetime for accurate validation timestamps.
    // Falls back to browser time if bridge is unreachable.
    var rtcCreatedAt = null;
    try {
      var rtcRes = await fetchWithTimeout('/api/get_datetime', {}, 3000);
      if (rtcRes && rtcRes.ok) {
        var rtcData = await rtcRes.json();
        rtcCreatedAt = (rtcData && (rtcData.datetime || rtcData.createdAt || rtcData.iso)) || null;
      }
    } catch (e) {
      rtcCreatedAt = null;
    }

    var report = null;
    
    if (type === 'stroke') {
      // FIX: Use captured stroke count (strokes counted over 60 seconds = strokes per minute)
      var strokesPerMin = finalStrokeCount; // Use captured value (captured before reset)
      
      // Check if a report already exists for this validation session
      // (Report is auto-generated when validation completes, so "Complete and Save" should just navigate to it)
      var reports = await StorageAdapter.get('reports') || [];
      var basket = validationBeaker || 1;
      var now = Date.now();
      
      // Find the most recent stroke validation report for this basket (created in the last 5 minutes)
      var existingReport = null;
      for (var i = reports.length - 1; i >= 0; i--) {
        var r = reports[i];
        if (r.type === 'validation' && 
            r.validationSubtype === 'stroke' && 
            (r.basket === basket || r.beaker === basket)) {
          // FIX 6: Check if report was created recently (within last 10 minutes for better timing)
          if (r.createdAt) {
            var reportTime = new Date(r.createdAt).getTime();
            var timeDiff = now - reportTime;
            if (timeDiff > 0 && timeDiff < 10 * 60 * 1000) { // Within 10 minutes
              existingReport = r;
              break;
            }
          }
        }
      }
      
      // If report already exists, just navigate to it instead of creating a new one
      if (existingReport) {
        console.log('[completeValidation] Stroke validation report already exists, navigating to it:', existingReport.id);
        // Show delete calibration button after validation completes
        setCalibrationDeleteVisible(true);
        
        // Navigate to the existing report
        if (typeof openReportPreview === 'function') {
          await openReportPreview(existingReport.id);
        } else if (typeof navigateTo === 'function') {
          navigateTo('reports');
        }
        
        // FIX 1: Set flag at the END after navigation
        validationCompletionInProgress = false;
        window.validationInProgress = false;
        return; // Exit early - don't create duplicate report
      }
      
      // FIX: Use captured stroke count (strokes counted over 60 seconds = strokes per minute)
      var strokesPerMin = finalStrokeCount; // Use captured value, not reset value
      var passed = (strokesPerMin >= 29 && strokesPerMin <= 32);
      
      console.log('[completeValidation] Stroke validation - Count:', strokesPerMin, 'strokes/min, Pass:', passed);
      
      report = {
        id: Date.now(),
        type: 'validation',
        validationSubtype: 'stroke',
        name: 'Validation Report – Stroke (Basket ' + basket + ')',
        createdAt: rtcCreatedAt || new Date().toISOString(),
        productName1: null,
        batch1: null,
        productName2: null,
        batch2: null,
        mode: null,
        setTemperature: null,
        duration: null,
        status: passed ? 'PASSED' : 'FAILED',
        strokesPerMin: strokesPerMin,
        beaker: basket,
        basket: basket,
        operatorName: (currentUser && currentUser.name) || '',
        operatorId: (currentUser && currentUser.username) || ''
      };
    } else if (type === 'temp') {
      // Min/max raw sensor temps (no calibration)
      var minTemp = (typeof capturedLastTempValidationMinTemp === 'number' && !isNaN(capturedLastTempValidationMinTemp))
        ? capturedLastTempValidationMinTemp : null;
      var maxTemp = (typeof capturedLastTempValidationMaxTemp === 'number' && !isNaN(capturedLastTempValidationMaxTemp))
        ? capturedLastTempValidationMaxTemp : null;
      // Max deviation = half range (max - min) / 2
      var maxDeviation = (minTemp !== null && maxTemp !== null)
        ? (maxTemp - minTemp) / 2
        : (typeof capturedLastTempValidationMaxDeviation === 'number' && !isNaN(capturedLastTempValidationMaxDeviation) && capturedLastTempValidationMaxDeviation >= 0)
          ? capturedLastTempValidationMaxDeviation : 0;
      
      var lim = typeof VALIDATION_DEVIATION_LIMIT !== 'undefined' ? VALIDATION_DEVIATION_LIMIT : 0.5;
      var passed = maxDeviation <= lim;
      
      report = {
        id: Date.now(),
        type: 'validation',
        validationSubtype: 'temp',
        name: 'Validation Report – Temp (Basket ' + (validationBeaker || 1) + ')',
        createdAt: rtcCreatedAt || new Date().toISOString(),
        productName1: null,
        batch1: null,
        productName2: null,
        batch2: null,
        mode: null,
        minTemp: minTemp,
        maxTemp: maxTemp,
        maxDeviation: maxDeviation,
        duration: null,
        status: passed ? 'PASSED' : 'FAILED',
        beaker: validationBeaker || 1,
        basket: validationBeaker || 1,
        operatorName: (currentUser && currentUser.name) || '',
        operatorId: (currentUser && currentUser.username) || ''
      };
    }
    
    if (report) {
      await saveReportRecord(report);
      
      // Generate PDF from HTML after saving the validation report
      // Note: saveReportPdfFromHtml will handle rendering internally
      if (typeof saveReportPdfFromHtml === 'function') {
        console.log('[completeValidation] Generating PDF for validation report:', report.id);
        var pdfSuccess = await saveReportPdfFromHtml(report);
        if (pdfSuccess) {
          console.log('[completeValidation] PDF generated successfully for validation report:', report.id);
        } else {
          console.warn('[completeValidation] PDF generation failed for validation report:', report.id);
        }
      } else {
        console.warn('[completeValidation] saveReportPdfFromHtml function not available');
      }
      
      // Update lastValidationDate and nextValidationDate (1 year apart) in factory settings
      try {
        const factorySettings = await StorageAdapter.get('factorySettings') || {};
        var lastDt = report.createdAt ? new Date(report.createdAt.replace('Z', '+00:00')) : null;
        if (lastDt && !isNaN(lastDt.getTime())) {
          // Store date + time (HH:MM) so UI reflects the validation moment.
          factorySettings.lastValidationDate =
            String(lastDt.getDate()).padStart(2, '0') + '-' +
            String(lastDt.getMonth() + 1).padStart(2, '0') + '-' +
            String(lastDt.getFullYear()) + ' ' +
            String(lastDt.getHours()).padStart(2, '0') + ':' +
            String(lastDt.getMinutes()).padStart(2, '0');
          var nextDt = new Date(lastDt);
          nextDt.setFullYear(nextDt.getFullYear() + 1);
          factorySettings.nextValidationDate =
            String(nextDt.getDate()).padStart(2, '0') + '-' +
            String(nextDt.getMonth() + 1).padStart(2, '0') + '-' +
            String(nextDt.getFullYear()) + ' ' +
            String(nextDt.getHours()).padStart(2, '0') + ':' +
            String(nextDt.getMinutes()).padStart(2, '0');
        } else {
          factorySettings.lastValidationDate = report.createdAt || '';
          factorySettings.nextValidationDate = '';
        }
        await safeSave('factorySettings', factorySettings);
      } catch (e) {
        console.error('Error updating validation dates in factory settings:', e);
      }
    }
    
    // Show delete calibration button after validation completes
    setCalibrationDeleteVisible(true);
    
    // FIX 7: Navigate to validation report preview AFTER all cleanup is done
    if (report && typeof openReportPreview === 'function') {
      console.log('[completeValidation] Navigating to report preview for report:', report.id);
      try {
        await openReportPreview(report.id);
        console.log('[completeValidation] Successfully navigated to report preview');
      } catch (e) {
        console.error('[completeValidation] Error navigating to report preview:', e);
        // Fallback: Navigate to reports list if openReportPreview fails
        if (typeof navigateTo === 'function') {
          navigateTo('reports');
        }
      }
    } else {
      // Fallback: Navigate to reports if openReportPreview is not available or report is missing
      console.warn('[completeValidation] Report or openReportPreview not available, navigating to reports');
    if (typeof showModal === 'function') {
      showModal('Validation ' + type + ' completed and saved');
    }
      if (typeof navigateTo === 'function') {
        navigateTo('reports');
      }
    }
    
      // FIX 1: Set flags at the END after all async operations complete
      validationCompletionInProgress = false;
      window.validationInProgress = false;
      
  } catch (e) {
      console.error('[completeValidation] Error in report creation/saving:', e);
      // Still set flags even on error
      validationCompletionInProgress = false;
      window.validationInProgress = false;
      
    if (typeof showModal === 'function') {
      showModal('Error saving validation report');
      }
    }
  } catch (e) {
    console.error('[completeValidation] Error in outer try block:', e);
    // Ensure flags are reset even on outer error
    validationCompletionInProgress = false;
    window.validationInProgress = false;
    
    if (typeof showModal === 'function') {
      showModal('Error completing validation');
    }
  }
}

function handleTempValidationPass() {
  // Stop validation timers
  if (tempValidationInterval) {
    clearInterval(tempValidationInterval);
    tempValidationInterval = null;
  }
  if (tempValidationTimer) {
    clearTimeout(tempValidationTimer);
    tempValidationTimer = null;
  }
  
  // Reset validation state
  tempValidationRunning = false;
  tempValidationElapsedStarted = false;
  tempValidationStartTime = null;
  
  // Update UI
  updateTempValidationToggleButton();
  updateValidationStopButton();
  
  // Show delete calibration button after validation completes
  setCalibrationDeleteVisible(true);
  
  // Save validation report (marks as PASSED)
  completeValidation('temp');
  
  // Note: completeValidation will navigate to report preview
}

function handleTempValidationFail() {
  // Stop validation timers
  if (tempValidationInterval) {
    clearInterval(tempValidationInterval);
    tempValidationInterval = null;
  }
  if (tempValidationTimer) {
    clearTimeout(tempValidationTimer);
    tempValidationTimer = null;
  }
  
  // Reset validation state
  tempValidationRunning = false;
  tempValidationElapsedStarted = false;
  tempValidationStartTime = null;
  
  // Update UI
  updateTempValidationToggleButton();
  updateValidationStopButton();
  
  // Save FAILED report and navigate to report preview (same as pass)
  completeValidation('temp');
}

async function performCalibration() {
  try {
    var measuredTempInput = document.getElementById('calibration-measured-temp-input');
    if (!measuredTempInput) {
      if (typeof showModal === 'function') {
        showModal('Temperature input not found');
      }
      return;
    }
    
    var measuredTrue = parseFloat(measuredTempInput.value);
    
    if (isNaN(measuredTrue)) {
      if (typeof showModal === 'function') {
        showModal('Please enter a valid temperature value');
      }
      return;
    }
    
    // Validate range
    if (measuredTrue < 0 || measuredTrue > 100) {
      if (typeof showModal === 'function') {
        showModal('Measured temperature must be between 0 and 100°C');
      }
      return;
    }
    
    var internalTempInput = document.getElementById('calibration-internal-temp-input');
    var setPoint = 37.0;
    
    if (internalTempInput) {
      // FIX: Extract numeric value from input (may contain "°C" suffix) - use internal IR reading for offset calc
      var tempValue = internalTempInput.value.toString().replace(/[°C\s]/g, '').trim();
      setPoint = parseFloat(tempValue) || 37.0;
      // Validate range
      if (setPoint < 0 || setPoint > 100) {
        if (typeof showModal === 'function') {
          showModal('Set temperature must be between 0 and 100°C');
        }
        return;
      }
    }
    
    // Use beaker from DOM (avoids validationBeaker race) with fallback to validationBeaker
    var beakerNumEl = document.getElementById('calibration-beaker-num');
    var beakerNum = beakerNumEl ? parseInt(beakerNumEl.textContent, 10) : (validationBeaker || 1);
    if (isNaN(beakerNum) || beakerNum < 1 || beakerNum > 2) {
      beakerNum = validationBeaker || 1;
    }
    beakerNum = Number(beakerNum);
    
    console.log('[Calibration] beakerNum from DOM:', beakerNumEl ? beakerNumEl.textContent : 'N/A', 'validationBeaker:', validationBeaker, '-> using beaker', beakerNum);
    
    // Calculate offset: offset = measuredTrue - setPoint
    // This offset will be subtracted from raw sensor readings
    var offset = measuredTrue - setPoint;
    calibrationOffsets[beakerNum] = offset;
    
    // Save calibration offsets
    await safeSave('calibrationOffsets', calibrationOffsets);
    
    // Send both IR and EXT calibration commands to ESP32 (direct mapping: Beaker 1=IR1+EXT1, Beaker 2=IR2+EXT2)
    // Add a small delay (0.5s) between IR and EXT commands so ESP has time to process
    // skipInitCheck: true so calibration is never blocked by temp scan
    try {
      console.log('[Calibration] Sending IR+EXT for beaker', beakerNum, '(Beaker 1=IR1+EXT1, Beaker 2=IR2+EXT2), measured temp:', measuredTrue);
      
      var irResult, extResult;
      if (beakerNum === 1) {
        console.log('[Calibration] Sending CAL,IR1...');
        irResult = await sendCalIR1(measuredTrue, true);
        console.log('[Calibration] IR1 result:', irResult?.ok ? 'OK' : irResult?.error || irResult);
        await new Promise(function(resolve) { setTimeout(resolve, 500); }); // 0.5s delay before EXT1
        console.log('[Calibration] Sending CAL,EXT1...');
        extResult = await sendCalEXT1(measuredTrue, true);
        console.log('[Calibration] EXT1 result:', extResult?.ok ? 'OK' : extResult?.error || extResult);
      } else if (beakerNum === 2) {
        console.log('[Calibration] Sending CAL,IR2...');
        irResult = await sendCalIR2(measuredTrue, true);
        console.log('[Calibration] IR2 result:', irResult?.ok ? 'OK' : irResult?.error || irResult);
        await new Promise(function(resolve) { setTimeout(resolve, 500); }); // 0.5s delay before EXT2
        console.log('[Calibration] Sending CAL,EXT2...');
        extResult = await sendCalEXT2(measuredTrue, true);
        console.log('[Calibration] EXT2 result:', extResult?.ok ? 'OK' : extResult?.error || extResult);
      } else {
        throw new Error('Invalid beaker number: ' + beakerNum);
      }
      
      if (irResult && irResult.error) {
        console.warn('[Calibration] IR calibration warning:', irResult.error);
        if (typeof showToast === 'function') showToast('IR calibration warning: ' + irResult.error, 'warning');
      } else if (irResult && irResult.ok) {
        console.log('[Calibration] IR calibration sent successfully');
      }
      if (extResult && extResult.error) {
        console.warn('[Calibration] EXT calibration warning:', extResult.error);
        if (typeof showToast === 'function') showToast('EXT calibration warning: ' + extResult.error, 'warning');
      } else if (extResult && extResult.ok) {
        console.log('[Calibration] EXT calibration sent successfully');
      }
    } catch (e) {
      console.error('[Calibration] Failed to send to ESP32:', e);
      if (typeof showToast === 'function') {
        showToast('Calibration saved locally but failed to send to ESP32: ' + String(e), 'warning');
      }
    }
    
    // Save validation report with CALIBRATED status
    var setTempValue = setPoint;
    var deviation = Math.abs(measuredTrue - setPoint);

    // Use bridge RTC time for report timestamp (fallback to browser time).
    var rtcCreatedAt = null;
    try {
      var rtcRes = await fetchWithTimeout('/api/get_datetime', {}, 3000);
      if (rtcRes && rtcRes.ok) {
        var rtcData = await rtcRes.json();
        rtcCreatedAt = (rtcData && (rtcData.datetime || rtcData.createdAt || rtcData.iso)) || null;
      }
    } catch (e) {
      rtcCreatedAt = null;
    }
    
    var report = {
      id: Date.now(),
      type: 'validation',
      validationSubtype: 'temp',
      name: 'Validation Report – Temp (Basket ' + beakerNum + ') - Calibrated',
      createdAt: rtcCreatedAt || new Date().toISOString(),
      productName1: null,
      batch1: null,
      productName2: null,
      batch2: null,
      mode: null,
      setTemperature: setTempValue,
      measuredTemperature: measuredTrue,
      deviation: deviation,
      calibrationOffset: offset,
      duration: null,
      status: 'CALIBRATED & PASSED',
      beaker: beakerNum,
      basket: beakerNum
    };
    
    await saveReportRecord(report);
    
    if (typeof showModal === 'function') {
      showModal('Calibration successful for Basket ' + beakerNum + '. Offset: ' + offset.toFixed(2) + '°C');
    }
    
    if (typeof navigateTo === 'function') {
      navigateTo('dashboard');
    }
  } catch (e) {
    console.error('Error performing calibration:', e);
    if (typeof showModal === 'function') {
      showModal('Error during calibration');
    }
  }
}

async function calibrateTemperatureSensor() {
  // RBAC: Check permission to calibrate
  var role = getCurrentRole();
  if (!canAccess(role, 'validate-temp-calibration')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to calibrate temperature.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to calibrate temperature.');
    }
    return;
  }
  
  // Show beaker selection popup
  var selectedBeaker = await showCalibrationBeakerSelection();
  
  // If user cancelled, do nothing
  if (selectedBeaker === null) {
    return;
  }
  
  // Get the beaker number
  var beakerNum = selectedBeaker;
  
  // Store the selected beaker for calibration
  validationBeaker = beakerNum;
  
  // Use SSE-pushed temperature data from bridge (no fetch)
  try {
    if (typeof showToast === 'function') {
      showToast('Reading system temperature...', 'info');
    }
    
    // Wait briefly for window.latestTemps if not yet populated by SSE
    var data = window.latestTemps;
    if (!data || (data.IR1 === undefined && data.IR2 === undefined)) {
      var waited = 0;
      while (waited < 5000) {
        await new Promise(function(r) { setTimeout(r, 200); });
        waited += 200;
        data = window.latestTemps;
        if (data && (data.IR1 !== undefined || data.IR2 !== undefined)) break;
      }
    }
    
    if (!data || (data.IR1 === undefined && data.IR2 === undefined)) {
      throw new Error('No temperature data available - please wait for sensor readings');
    }
    
    // Get internal (IR) and external (EXT) temps for selected beaker: Beaker 1=IR1+EXT1, Beaker 2=IR2+EXT2
    var internalTemp = 37.0;
    var externalTemp = 25.0;
    if (beakerNum === 1 && data.IR1 !== undefined && data.EXT1 !== undefined) {
      internalTemp = data.IR1;
      externalTemp = data.EXT1;
    } else if (beakerNum === 2 && data.IR2 !== undefined && data.EXT2 !== undefined) {
      internalTemp = data.IR2;
      externalTemp = data.EXT2;
    }
    
    // Navigate to calibration input screen and populate values
    var beakerNumEl = document.getElementById('calibration-beaker-num');
    var internalTempInput = document.getElementById('calibration-internal-temp-input');
    var externalTempInput = document.getElementById('calibration-external-temp-input');
    var measuredTempInput = document.getElementById('calibration-measured-temp-input');
    
    if (beakerNumEl) beakerNumEl.textContent = beakerNum;
    
    // Populate internal (IR) and external (EXT) read-only displays
    if (internalTempInput) {
      internalTempInput.value = internalTemp.toFixed(1) + '°C';
      internalTempInput.readOnly = true;
      internalTempInput.style.opacity = '0.9';
      internalTempInput.style.cursor = 'not-allowed';
    }
    if (externalTempInput) {
      externalTempInput.value = externalTemp.toFixed(1) + '°C';
      externalTempInput.readOnly = true;
      externalTempInput.style.opacity = '0.9';
      externalTempInput.style.cursor = 'not-allowed';
    }
    
    // Clear measured temp input for operator entry
    if (measuredTempInput) {
      measuredTempInput.value = '';
      measuredTempInput.placeholder = 'Enter measured temp';
      measuredTempInput.readOnly = false;
    }
    
    // Navigate to calibration screen
    if (typeof navigateTo === 'function') {
      navigateTo('temp-calibration-input');
    }
    
    // Initialize lucide icons after navigation
    setTimeout(function() {
      if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
      }
    }, 100);
    
  } catch (e) {
    console.error('[Calibration] Failed to load system temperature:', e);
    if (typeof showToast === 'function') {
      showToast('Failed to read system temperature. Please try again.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('Failed to read system temperature. Please try again.');
    }
  }
}

function stopCalibration() {
  isCalibrating = false;
  // Stop any validation timers
  if (tempValidationInterval) {
    clearInterval(tempValidationInterval);
    tempValidationInterval = null;
  }
  if (tempValidationTimer) {
    clearTimeout(tempValidationTimer);
    tempValidationTimer = null;
  }
  if (typeof navigateTo === 'function') {
    navigateTo('dashboard');
  }
}

// ========== SETTINGS FUNCTIONS ==========
// Settings management (because users always want to change things)
async function setBasketConfig(c) {
  if (testRunning[1] || testRunning[2]) {
    if (typeof showModal === 'function') {
      showModal('Cannot change basket configuration while tests are running. Please stop all tests first.');
    }
        return;
    }

  // Confirmation first: do NOT apply changes until user confirms.
  if (typeof showModalConfirm === 'function') {
    var ok = await showModalConfirm('Apply ' + c + '-tube basket configuration?');
    if (!ok) {
      // Cancel means "do nothing" (do not change dashboard state).
      return;
    }
  }

  basketConfig = c;

  // Persist selected basket config
  try {
    await safeSave('basketConfig', c);
  } catch (e) {
    console.error('[setBasketConfig] Failed to save basketConfig:', e);
  }

  // Apply UI changes
  if (typeof updateBasketHoles === 'function') {
    updateBasketHoles(1, c);
    updateBasketHoles(2, c);
  }

  if (typeof updateBasketHoleSelection === 'function') {
    updateBasketHoleSelection(1);
    updateBasketHoleSelection(2);
  }

  if (typeof navigateTo === 'function') {
    navigateTo('dashboard');
  }
}

function selectBeaker(beakerId) {
  console.log('[selectBeaker] Called with beakerId:', beakerId);
  selectedBeakerForConfig = beakerId;
  
  // Remove selection from all buttons
  var allButtons = document.querySelectorAll('.beaker-select-btn');
  for (var i = 0; i < allButtons.length; i++) {
    allButtons[i].classList.remove('border-blue-500', 'bg-blue-600');
    allButtons[i].classList.add('border-gray-600', 'bg-gray-700');
  }
  
  // Highlight selected button
  var selectedBtn = null;
  if (beakerId === 1) {
    selectedBtn = document.getElementById('beaker-select-1');
  } else if (beakerId === 2) {
    selectedBtn = document.getElementById('beaker-select-2');
  } else if (beakerId === 'both') {
    selectedBtn = document.getElementById('beaker-select-both');
    // Don't configure both beakers yet - wait for proceed button
  }
  
  if (selectedBtn) {
    selectedBtn.classList.remove('border-gray-600', 'bg-gray-700');
    selectedBtn.classList.add('border-blue-500', 'bg-blue-600');
    console.log('[selectBeaker] Button highlighted');
  } else {
    console.error('[selectBeaker] Button not found for beakerId:', beakerId);
  }
  
  // Show proceed button
  var proceedBtn = document.getElementById('proceed-beaker-btn');
  if (proceedBtn) {
    proceedBtn.style.display = 'block';
    console.log('[selectBeaker] Proceed button shown');
  } else {
    console.error('[selectBeaker] Proceed button not found');
  }
}

function proceedWithBeakerSelection() {
  if (!selectedBeakerForConfig) {
    if (typeof showModal === 'function') {
      showModal('Please select a beaker first');
    }
    return;
  }
  
  // Ensure configuredBeakers is an object like {1:bool,2:bool}
  if (!configuredBeakers) {
    configuredBeakers = { 1: false, 2: false };
  }
  
  if (selectedBeakerForConfig === 'both') {
    configuredBeakers[1] = true;
    configuredBeakers[2] = true;
  } else {
    var beakerNum = parseInt(selectedBeakerForConfig, 10);
    if (beakerNum === 1 || beakerNum === 2) {
      var other = (beakerNum === 1) ? 2 : 1;
      
      // Activate selected beaker and deactivate the other
      configuredBeakers[beakerNum] = true;
      configuredBeakers[other] = false;
      
      // Do NOT clear recipes here (user may want to keep them for later)
      // But we can clear "running" state if you track it – leave as-is unless needed.
      
      // Ensure active beaker has a valid temperature
      if (setTemp[beakerNum] == null || isNaN(setTemp[beakerNum])) {
        // copy from other if available, else default
        var fallback = (setTemp[other] != null && !isNaN(setTemp[other])) ? setTemp[other] : 37.0;
        setTemp[beakerNum] = fallback;
      }
    }
  }
  
  (async function () {
    await safeSave('configuredBeakers', configuredBeakers);
    await safeSave('setTemp', setTemp);
    
    if (typeof updateBasketStates === 'function') {
      updateBasketStates();
    }
    if (typeof updateDashboardProductNames === 'function') {
      updateDashboardProductNames();
    }
    if (typeof updateDashboardTempButton === 'function') {
      updateDashboardTempButton();
    }
    
    if (typeof navigateTo === 'function') {
      navigateTo('dashboard');
    }
  })();
}

// Temperature increment/decrement functions
function incrementTemp(inputId) {
  var inp = document.getElementById(inputId);
  if (!inp) return;
  var currentVal = parseFloat(inp.value) || 37.0;
  var newVal = Math.round((currentVal + 0.1) * 10) / 10;
  newVal = Math.min(99.9, Math.max(0, newVal));
  inp.value = newVal.toFixed(1);
  // Move cursor to end
  setTimeout(function() {
    if (inp.setSelectionRange) {
      var len = inp.value.length;
      inp.setSelectionRange(len, len);
      inp.focus();
    }
  }, 10);
}

function decrementTemp(inputId) {
  var inp = document.getElementById(inputId);
  if (!inp) return;
  var currentVal = parseFloat(inp.value) || 37.0;
  var newVal = Math.round((currentVal - 0.1) * 10) / 10;
  newVal = Math.min(99.9, Math.max(0, newVal));
  inp.value = newVal.toFixed(1);
  // Move cursor to end
  setTimeout(function() {
    if (inp.setSelectionRange) {
      var len = inp.value.length;
      inp.setSelectionRange(len, len);
      inp.focus();
    }
  }, 10);
}

// Format temperature input (2 digits, 2 decimals)
function formatTemperatureInput(inputId) {
  var inp = document.getElementById(inputId);
  if (!inp) return;
  
  // Remove any 'A' character that might appear
  var val = inp.value.toString().replace(/A/g, '').replace(/[^0-9.]/g, '');
  var numVal = parseFloat(val);
  
  if (isNaN(numVal)) {
    inp.value = '37.00';
  } else {
    // Ensure 2 digits before decimal and 2 after
    var parts = numVal.toFixed(2).split('.');
    var intPart = parts[0];
    var decPart = parts[1] || '00';
    
    // Limit to 2 digits before decimal
    if (intPart.length > 2) {
      intPart = intPart.substring(0, 2);
    }
    
    inp.value = intPart + '.' + decPart;
  }
  
  // Move cursor to end
  setTimeout(function() {
    if (inp.setSelectionRange) {
      var len = inp.value.length;
      inp.setSelectionRange(len, len);
    }
  }, 10);
}

// Initialize temperature input handlers
function initTemperatureInputs() {
  var _setTempSaveTimer = null;
  function persistSetTempDebounced() {
    try {
      if (_setTempSaveTimer) clearTimeout(_setTempSaveTimer);
      _setTempSaveTimer = setTimeout(function() {
        try {
          if (typeof safeSave === 'function') safeSave('setTemp', setTemp);
        } catch (e) {}
      }, 250);
    } catch (e) {}
  }

  // CHANGED: Heater settings inputs - read/write from text inputs directly
  for (var id = 1; id <= 2; id++) {
    var inp = document.getElementById('set-temp-' + id);
    var displayEl = document.getElementById('set-temp-' + id + '-text');
    
    if (inp) {
      // Use setTemp[id] as initial value if it exists (single source of truth)
      var initialVal = Number(setTemp[id]) || parseFloat(inp.value) || 37.0;
      inp.value = initialVal.toFixed(1);
      setTemp[id] = initialVal; // Ensure setTemp is synced
      
      // Update setTemp when input value changes
      var updateSetTemp = function(input, basketId, displayElLocal) {
        return function() {
          var val = parseFloat(input.value) || 37.0;
          if (val > MAX_TEMP_C) {
            if (typeof showModal === 'function') {
              showModal('MAX temperature is 55°C. Enter the temperature in range.', function() {
                input.value = MAX_TEMP_C.toFixed(1);
                setTemp[basketId] = MAX_TEMP_C;
                if (displayElLocal) displayElLocal.textContent = MAX_TEMP_C.toFixed(1);
                persistSetTempDebounced();
              });
            }
            return;
          }
          setTemp[basketId] = val; // Update single source of truth
          if (displayElLocal) displayElLocal.textContent = val.toFixed(1);
          persistSetTempDebounced();
        };
      };
      
      inp.addEventListener('input', updateSetTemp(inp, id, displayEl));
      inp.addEventListener('change', updateSetTemp(inp, id, displayEl));
    }
  }
  
  // Recipe temperature input - format and validate max 55°C on blur/change
  var recipeTempInp = document.getElementById('recipe-temp');
  if (recipeTempInp) {
    recipeTempInp.addEventListener('blur', function() {
      var val = parseFloat(this.value);
      if (!isNaN(val) && val > MAX_TEMP_C) {
        if (typeof showModal === 'function') {
          showModal('MAX temperature is 55°C. Enter the temperature in range.', function() {
            this.value = MAX_TEMP_C.toFixed(1);
            formatTemperatureInput(this.id);
          }.bind(this));
        }
      }
      formatTemperatureInput(this.id);
    });
    recipeTempInp.addEventListener('change', function() {
      var val = parseFloat(this.value);
      if (!isNaN(val) && val > MAX_TEMP_C) {
        this.value = MAX_TEMP_C.toFixed(1);
      }
      formatTemperatureInput(this.id);
    });
  }
  
  // Dashboard temperature displays - fix 'A' character issue
  for (var i = 1; i <= 2; i++) {
    var tempEl = document.getElementById('temp' + i);
    if (tempEl) {
      var currentText = tempEl.textContent || '';
      // Remove 'A' and 'Â' characters if present
      currentText = cleanTemperatureText(currentText);
      if (currentText.indexOf('°') === -1 || currentText.indexOf('Â') > -1) {
        // Fix encoding issue
        setTemperatureDisplay('temp' + i, setTemp[i] || 37.0);
      }
    }
  }
  
  // Scroll/wheel sensitivity fix for timer & temperature adjusters
  // Add slow-wheel handler for all number inputs (mouse/trackpad)
  document.querySelectorAll('input[type="number"]').forEach(function(inp) {
    // Skip if already has wheel handler
    if (inp.dataset.wheelHandlerAdded) return;
    inp.dataset.wheelHandlerAdded = 'true';
    
    inp.addEventListener('wheel', function(ev) {
      ev.preventDefault();
      const baseStep = parseFloat(inp.getAttribute('step')) || 1;
      // smaller step, and make it slow when Shift not pressed
      const step = ev.shiftKey ? baseStep * 0.1 : baseStep * 0.5;
      const cur = parseFloat(inp.value) || 0;
      const delta = Math.sign(ev.deltaY) * step * -1; // deltaY direction flip
      const newVal = cur + delta;
      // Temperature inputs typically have step < 1 → format 1 decimal
      if (baseStep < 1) {
        inp.value = newVal.toFixed(1);
      } else {
        inp.value = String(Math.round(newVal));
      }
      // trigger change handlers if needed
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, { passive: false });
  });
  
  // Touch-friendly adjust for timer & temperature inputs (swipe up/down, pointer events for better Windows touch support)
  document.querySelectorAll('input[type="number"]').forEach(function(inp) {
    if (inp.dataset.touchScrollAdded) return;
    inp.dataset.touchScrollAdded = 'true';
    
    let lastY = null;
    let activePointerId = null;
    const threshold = 18; // pixels of movement for one step
    
    inp.addEventListener('pointerdown', function(ev) {
      if (ev.pointerType !== 'touch') return;
      activePointerId = ev.pointerId;
      lastY = ev.clientY;
      try {
        inp.setPointerCapture(activePointerId);
      } catch (e) {
        // ignore if capture not supported
      }
    });
    
    inp.addEventListener('pointermove', function(ev) {
      if (ev.pointerType !== 'touch') return;
      if (activePointerId === null || ev.pointerId !== activePointerId || lastY === null) return;
      const y = ev.clientY;
      const dy = lastY - y;
      // Only react to meaningful vertical movement
      if (Math.abs(dy) >= threshold) {
        ev.preventDefault();
        const baseStep = parseFloat(inp.getAttribute('step')) || 1;
        const direction = dy > 0 ? 1 : -1; // swipe up = increase
        const cur = parseFloat(inp.value) || 0;
        const newVal = cur + direction * baseStep;
        if (baseStep < 1) {
          inp.value = newVal.toFixed(1);
        } else {
          inp.value = String(Math.round(newVal));
        }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        // Reset reference point so each threshold of movement = one step
        lastY = y;
      }
    }, { passive: false });
    
    function clearPointer(ev) {
      if (ev.pointerType && ev.pointerType !== 'touch') return;
      if (activePointerId !== null && ev.pointerId === activePointerId) {
        try {
          inp.releasePointerCapture(activePointerId);
        } catch (e) {
          // ignore
        }
        activePointerId = null;
        lastY = null;
      }
    }
    
    inp.addEventListener('pointerup', clearPointer);
    inp.addEventListener('pointercancel', clearPointer);
  });
}

function applyHeaterSettings() {
  for (var id = 1; id <= 2; id++) {
    var inp = document.getElementById('set-temp-' + id);
    var displayEl = document.getElementById('set-temp-' + id + '-text');
    
    if (inp) {
      // Clean and parse temperature input
      var val = cleanTemperatureText(inp.value.toString());
      var tempValue = parseFloat(val);
      
      // Validate temperature: must be between 20°C and 55°C
      if (isNaN(tempValue) || tempValue < 20 || tempValue > MAX_TEMP_C) {
        if (typeof showToast === 'function') {
          showToast('MAX temperature is 55°C. Enter the temperature in range.', 'error');
        } else if (typeof showModal === 'function') {
          showModal('MAX temperature is 55°C. Enter the temperature in range.');
        }
        return; // Refuse setting
      }
      
      // Store temperature with one decimal place
      setTemp[id] = Math.round(tempValue * 10) / 10;
      setTemperatureDisplay('temp' + id, setTemp[id]);
      
      // Update display text if it exists
      if (displayEl) {
        displayEl.textContent = setTemp[id].toFixed(1);
      }
      
      // Update all set temperature displays
      updateSetTempUI(setTemp[id]);
    }
  }
  
  // Update dashboard temperature button display
  if (typeof updateDashboardTempButton === 'function') {
    updateDashboardTempButton();
  }
  
  if (typeof showModal === 'function') {
    showModal('Heater settings applied');
  }
  if (typeof navigateTo === 'function') {
    navigateTo('dashboard');
  }
}

async function setTimeFormat(is24) {
  use24Hour = is24;
  await safeSave('use24Hour', is24 ? 'true' : 'false');
  var btn12 = document.getElementById('format-12h');
  var btn24 = document.getElementById('format-24h');
  if (is24) {
    if (btn24) {
      btn24.classList.remove('bg-gray-600', 'hover:bg-gray-700');
      btn24.classList.add('bg-blue-600', 'hover:bg-blue-700');
    }
    if (btn12) {
      btn12.classList.remove('bg-blue-600', 'hover:bg-blue-700');
      btn12.classList.add('bg-gray-600', 'hover:bg-gray-700');
    }
    } else {
    if (btn12) {
      btn12.classList.remove('bg-gray-600', 'hover:bg-gray-700');
      btn12.classList.add('bg-blue-600', 'hover:bg-blue-700');
    }
    if (btn24) {
      btn24.classList.remove('bg-blue-600', 'hover:bg-blue-700');
      btn24.classList.add('bg-gray-600', 'hover:bg-gray-700');
    }
  }
  if (typeof updateClock === 'function') {
    updateClock();
  }
}

// ========== RECIPE FUNCTIONS ==========
// Recipe management (because saving test parameters is useful)
var recipes = [];
(function() {
  (async function() {
    recipes = await StorageAdapter.get('recipes') || [];
  })();
})();

async function renderRecipeList() {
  var container = document.getElementById('recipe-list-container');
  if (!container) return;
  
  // Load recipes from storage
  recipes = await StorageAdapter.get('recipes') || [];
  
  container.innerHTML = '';
  if (recipes.length === 0) {
    container.innerHTML = '<p class="text-center text-gray-400 py-8 text-xl">No recipes created yet.</p>';
        return;
    }
    
  // RBAC: Check permissions for edit/delete actions
  var role = getCurrentRole();
  var canEdit = canAccess(role, 'recipe-edit');
  var canDelete = canAccess(role, 'recipe-delete');
    
  var table = document.createElement('table');
  table.className = 'w-full text-left';
  var thead = '<thead><tr><th>Name</th><th>Temp</th><th>Mode</th><th>Actions</th></tr></thead>';
  var tbody = document.createElement('tbody');
  table.innerHTML = thead;
  table.appendChild(tbody);
  
  for (var i = 0; i < recipes.length; i++) {
    var r = recipes[i];
    var tr = document.createElement('tr');
    tr.className = 'border-b-2 border-gray-700';
    var tempStr = r.temp || '37.0';
    // Remove any 'A' character that might appear
    tempStr = tempStr.toString().replace(/A/g, '');
    
    var modeLabel = (r.mode === 'manual') ? 'Manual' : 'Timer';
    
    var actionButtons = '<td class="flex gap-2">';
    if (canEdit) {
      actionButtons += '<button onclick="editRecipe(' + i + ')" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">Edit</button>';
    }
    // Load button is always available (view action)
    actionButtons += '<button onclick="selectRecipeForExecution(' + i + ')" class="bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded">Load</button>';
    if (canDelete) {
      actionButtons += '<button onclick="deleteRecipe(' + i + ')" class="bg-red-600 hover:bg-red-700 text-white px-4 py-2 rounded">Delete</button>';
    }
    actionButtons += '</td>';
    
    tr.innerHTML = '<td>' + (r.name || '') + '</td>' +
      '<td>' + tempStr + '°C</td>' +
      '<td>' + modeLabel + '</td>' +
      actionButtons;
    tbody.appendChild(tr);
  }
  container.appendChild(table);
}

function editRecipe(index) {
  var r = recipes[index];
  if (!r) return;
  editingRecipeId = index;
  var titleEl = document.getElementById('recipe-title');
  if (titleEl) titleEl.textContent = 'Edit Recipe';
  var nameEl = document.getElementById('recipe-name');
  if (nameEl) nameEl.value = r.name || '';
  var tempEl = document.getElementById('recipe-temp');
  if (tempEl) tempEl.value = r.temp || '';
  var durationEl = document.getElementById('recipe-duration');
  if (durationEl && r.duration !== undefined && r.duration !== null) {
    var totalMinutes = parseFloat(r.duration) || 0;
    var mins = Math.floor(totalMinutes);
    var secs = Math.round((totalMinutes % 1) * 60);
    if (secs >= 60) { secs = 0; mins += 1; }
    durationEl.value = String(mins).padStart(2, '0') + ':' + String(secs).padStart(2, '0');
  }
  
  // Set mode selection
  var modeValue = r.mode || 'timer';
  
  // Use setTimeout to ensure DOM is ready after navigation
  setTimeout(function() {
    selectRecipeMode(modeValue);
  }, 100);
  
  if (typeof navigateTo === 'function') {
    navigateTo('create-recipe');
  }
}

function saveRecipe() {
  // Recipes are saved only on explicit Create/Save button click - no auto-save on field edit.
  // RBAC: Check permission to save recipes
  var role = getCurrentRole();
  if (!canAccess(role, 'recipe-edit')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to edit recipes.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to edit recipes.');
    }
    return;
  }
  
  var nameEl = document.getElementById('recipe-name');
  var name = nameEl && nameEl.value ? nameEl.value.trim() : '';
  if (!name) {
    if (typeof showModal === 'function') {
      showModal('Recipe name is required');
    }
    return;
  }
  
  var tempEl = document.getElementById('recipe-temp');
  var durationEl = document.getElementById('recipe-duration');
  var modeInput = document.getElementById('recipe-mode-value');

  // Validate required fields (prevents accidental saves with incomplete data)
  var modeVal = modeInput && modeInput.value ? modeInput.value.trim() : '';
  if (!modeVal) {
    if (typeof showModal === 'function') showModal('Please select recipe mode (Manual/Timer) before saving.');
    return;
  }
  var tempStr = tempEl && tempEl.value ? String(tempEl.value).trim() : '';
  var tempNum = tempStr ? parseFloat(tempStr) : NaN;
  if (!tempStr || isNaN(tempNum)) {
    if (typeof showModal === 'function') showModal('Please enter a valid temperature before saving.');
    return;
  }
  if (tempNum > MAX_TEMP_C) {
    if (typeof showModal === 'function') showModal('MAX temperature is 55°C. Enter the temperature in range.');
    return;
  }
  var durationMinutes = null;
  if (modeVal === 'timer') {
    var durationStr0 = durationEl && durationEl.value ? String(durationEl.value).trim() : '';
    if (!durationStr0 || durationStr0.indexOf(':') === -1) {
      if (typeof showModal === 'function') showModal('Please enter a valid duration (MM:SS) before saving.');
      return;
    }
    if (durationEl && durationEl.value) {
      var durationStr = durationEl.value.trim();
      var parts = durationStr.split(':');
      if (parts.length === 2) {
        var minutes = parseInt(parts[0], 10) || 0;
        var seconds = parseInt(parts[1], 10) || 0;
        durationMinutes = minutes + (seconds / 60);
      }
    }
    if (!durationMinutes || durationMinutes <= 0) {
      if (typeof showModal === 'function') showModal('Please enter a non-zero duration before saving.');
      return;
    }
  }
  
  var recipe = {
    name: name,
    batch: '',
    temp: tempStr,
    duration: durationMinutes,
    mode: modeVal
  };
  
  if (editingRecipeId !== null && editingRecipeId >= 0) {
    recipes[editingRecipeId] = recipe;
  } else {
    recipes.push(recipe);
  }
  
  (async function() {
    await safeSave('recipes', recipes);
    editingRecipeId = null;
    if (typeof showModal === 'function') {
      showModal('Recipe saved!');
    }
    if (typeof navigateTo === 'function') {
      navigateTo('recipe-list');
    }
  })();
}

function cancelRecipe() {
  editingRecipeId = null;
  if (typeof navigateTo === 'function') {
    navigateTo('recipe-list');
  }
}

// Recipe beaker and mode selection handlers
function selectRecipeBeaker(beakerNum) {
  // Update hidden input
  var beakerInput = document.getElementById('recipe-beaker-value');
  if (beakerInput) {
    beakerInput.value = beakerNum.toString();
  }
  
  // Update button styles
  var btn1 = document.getElementById('recipe-beaker-1');
  var btn2 = document.getElementById('recipe-beaker-2');
  var btnBoth = document.getElementById('recipe-beaker-both');
  
  if (btn1 && btn2) {
    // Remove selected state from all
    btn1.classList.remove('bg-blue-600', 'border-blue-500');
    btn1.classList.add('bg-gray-700', 'border-gray-600');
    btn2.classList.remove('bg-blue-600', 'border-blue-500');
    btn2.classList.add('bg-gray-700', 'border-gray-600');
    if (btnBoth) {
      btnBoth.classList.remove('bg-blue-600', 'border-blue-500');
      btnBoth.classList.add('bg-gray-700', 'border-gray-600');
    }
    
    // Add selected state to chosen button
    if (beakerNum === 1 || beakerNum === '1') {
      btn1.classList.remove('bg-gray-700', 'border-gray-600');
      btn1.classList.add('bg-blue-600', 'border-blue-500');
    } else if (beakerNum === 2 || beakerNum === '2') {
      btn2.classList.remove('bg-gray-700', 'border-gray-600');
      btn2.classList.add('bg-blue-600', 'border-blue-500');
    } else if (beakerNum === 'both' || beakerNum === 'Both') {
      if (btnBoth) {
        btnBoth.classList.remove('bg-gray-700', 'border-gray-600');
        btnBoth.classList.add('bg-blue-600', 'border-blue-500');
      }
    }
  }
  
  // Update icons
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function clearRecipeModeSelection() {
  var modeInput = document.getElementById('recipe-mode-value');
  if (modeInput) modeInput.value = '';
  var manualBtn = document.getElementById('recipe-mode-manual');
  var timerBtn = document.getElementById('recipe-mode-timer');
  if (manualBtn && timerBtn) {
    manualBtn.classList.remove('bg-blue-600', 'border-blue-500');
    manualBtn.classList.add('bg-gray-700', 'border-gray-600');
    timerBtn.classList.remove('bg-blue-600', 'border-blue-500');
    timerBtn.classList.add('bg-gray-700', 'border-gray-600');
  }
  var durationContainer = document.getElementById('recipe-duration-container');
  if (durationContainer) durationContainer.style.display = 'none';
}

function selectRecipeMode(mode) {
  var modeInput = document.getElementById('recipe-mode-value');
  if (modeInput) {
    modeInput.value = mode;
  }
  
  var manualBtn = document.getElementById('recipe-mode-manual');
  var timerBtn = document.getElementById('recipe-mode-timer');
  
  if (manualBtn && timerBtn) {
    manualBtn.classList.remove('bg-blue-600', 'border-blue-500');
    manualBtn.classList.add('bg-gray-700', 'border-gray-600');
    timerBtn.classList.remove('bg-blue-600', 'border-blue-500');
    timerBtn.classList.add('bg-gray-700', 'border-gray-600');
    
    if (mode === 'manual') {
      manualBtn.classList.remove('bg-gray-700', 'border-gray-600');
      manualBtn.classList.add('bg-blue-600', 'border-blue-500');
    } else if (mode === 'timer') {
      timerBtn.classList.remove('bg-gray-700', 'border-gray-600');
      timerBtn.classList.add('bg-blue-600', 'border-blue-500');
    }
  }
  
  var durationContainer = document.getElementById('recipe-duration-container');
  if (durationContainer) {
    durationContainer.style.display = (mode === 'timer') ? '' : 'none';
  }
  
  // Update icons
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

async function deleteRecipe(index) {
  // RBAC: Check permission to delete recipes
  var role = getCurrentRole();
  if (!canAccess(role, 'recipe-delete')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to delete recipes.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to delete recipes.');
    }
    return;
  }
  
  // FIX: Use showModalConfirm instead of window.confirm
  (async function() {
    var confirmed = false;
    if (typeof showModalConfirm === 'function') {
      confirmed = await showModalConfirm('Delete this recipe?');
    }
    
    if (confirmed) {
    recipes.splice(index, 1);
    await safeSave('recipes', recipes);
    if (typeof renderRecipeList === 'function') {
      renderRecipeList();
    }
  }
  })();
}

// Function to update the dashboard temperature button display
function updateDashboardTempButton() {
  var temp1El = document.getElementById('dashboard-temp-1');
  var temp2El = document.getElementById('dashboard-temp-2');
  var tempBtn = document.getElementById('dashboard-temp-btn');
  var temp1 = setTemp[1] || 37.0;
  var temp2 = setTemp[2] || 37.0;
  
  // Update temperatures
  if (temp1El) {
    temp1El.textContent = temp1.toFixed(1) + '°C';
  }
  if (temp2El) {
    temp2El.textContent = temp2.toFixed(1) + '°C';
  }
  
  // Show/hide button sections based on configured beakers
  if (tempBtn) {
    var basket1Section = document.getElementById('dashboard-temp-basket1-section') || (temp1El ? temp1El.closest('div[style*="flex:1"]') : null);
    var basket2Section = document.getElementById('dashboard-temp-basket2-section') || (temp2El ? temp2El.closest('div[style*="flex:1"]') : null);
    
    if (configuredBeakers[1] && configuredBeakers[2]) {
      // Both configured - show both
      if (basket1Section) {
        basket1Section.style.display = 'flex';
        basket1Section.style.visibility = 'visible';
      }
      if (basket2Section) {
        basket2Section.style.display = 'flex';
        basket2Section.style.visibility = 'visible';
      }
      tempBtn.style.display = 'flex';
      tempBtn.style.visibility = 'visible';
    } else if (configuredBeakers[1] && !configuredBeakers[2]) {
      // Only basket 1 - show only basket 1 section
      if (basket1Section) {
        basket1Section.style.display = 'flex';
        basket1Section.style.visibility = 'visible';
      }
      if (basket2Section) basket2Section.style.display = 'none';
      tempBtn.style.display = 'flex';
      tempBtn.style.visibility = 'visible';
    } else if (configuredBeakers[2] && !configuredBeakers[1]) {
      // Only basket 2 - show only basket 2 section
      if (basket1Section) basket1Section.style.display = 'none';
      if (basket2Section) {
        basket2Section.style.display = 'flex';
        basket2Section.style.visibility = 'visible';
      }
      tempBtn.style.display = 'flex';
      tempBtn.style.visibility = 'visible';
    } else {
      // No beakers configured - hide button
      tempBtn.style.display = 'none';
    }
  }
  
  // Refresh lucide icons if needed
  if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
    setTimeout(function() {
      lucide.createIcons();
    }, 50);
  }
}

// Function to show set temperatures for both baskets
function showSetTemperatures() {
  var temp1 = setTemp[1] || 37.0;
  var temp2 = setTemp[2] || 37.0;
  var mode1 = basketModes[1] || 'timer';
  var mode2 = basketModes[2] || 'timer';
  var duration1 = basketDurations[1];
  var duration2 = basketDurations[2];
  
  var message = 'Set Temperatures:\n\n';
  message += 'Basket 1:\n';
  message += '  Temperature: ' + temp1.toFixed(1) + '°C\n';
  message += '  Mode: ' + (mode1 === 'timer' ? 'Timer' : 'Manual');
  if (mode1 === 'timer' && duration1) {
    message += '\n  Duration: ' + duration1 + ' minutes';
  }
  message += '\n\nBasket 2:\n';
  message += '  Temperature: ' + temp2.toFixed(1) + '°C\n';
  message += '  Mode: ' + (mode2 === 'timer' ? 'Timer' : 'Manual');
  if (mode2 === 'timer' && duration2) {
    message += '\n  Duration: ' + duration2 + ' minutes';
  }
  
  if (typeof showModal === 'function') {
    showModal(message);
  } else if (typeof alert === 'function') {
    alert(message);
  }
}

window.showSetTemperatures = showSetTemperatures;
window.updateDashboardTempButton = updateDashboardTempButton;

// Function to show batch number prompt when loading a recipe
function showBatchNumberPrompt(recipeName) {
  console.log('[showBatchNumberPrompt] Creating batch number modal for:', recipeName);
  return new Promise(function(resolve) {
    var existing = document.getElementById('batch-number-modal');
    if (existing) {
      console.log('[showBatchNumberPrompt] Removing existing modal');
      existing.remove();
    }

    var modal = document.createElement('div');
    modal.id = 'batch-number-modal';
    modal.className = 'modal active';
    modal.style.cssText = 'display:flex!important;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:11000;justify-content:center;align-items:center;';
    modal.innerHTML = '<div class="modal-content" style="background:#1f2937;border-radius:20px;padding:32px;max-width:500px;border:4px solid #4b5563;box-shadow:0 8px 32px rgba(0,0,0,0.5);" onclick="event.stopPropagation();">' +
      '<h2 style="font-size:24px;font-weight:bold;margin-bottom:16px;color:white;text-align:center;">Enter Batch Number</h2>' +
      '<p style="margin-bottom:20px;color:#a0aec0;font-size:16px;text-align:center;">Loading recipe: ' + (recipeName || 'Recipe') + '</p>' +
      '<input type="text" id="batch-number-input" placeholder="Enter Batch No" style="width:100%;padding:16px 20px;font-size:18px;background:#374151;border:3px solid #4b5563;border-radius:12px;color:white;margin-bottom:20px;box-sizing:border-box;" onfocus="if(typeof openOSKForInput === \'function\') openOSKForInput(this)"/>' +
      '<div style="display:flex;gap:12px;">' +
      '<button id="batch-number-ok" class="action-btn-large bg-green-600 hover:bg-green-700 text-white" style="flex:1;padding:16px 24px;font-size:18px;">OK</button>' +
      '<button id="batch-number-cancel" class="action-btn-large bg-gray-600 hover:bg-gray-700 text-white" style="flex:1;padding:16px 24px;font-size:18px;">Cancel</button>' +
      '</div></div>';
    document.body.appendChild(modal);
    console.log('[showBatchNumberPrompt] Modal added to DOM');

    function cleanup() {
      console.log('[showBatchNumberPrompt] Cleaning up modal');
      if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
    }

    setTimeout(function() {
      var inputEl = document.getElementById('batch-number-input');
      var okBtn = document.getElementById('batch-number-ok');
      var cancelBtn = document.getElementById('batch-number-cancel');

      console.log('[showBatchNumberPrompt] Wiring up buttons');

      if (okBtn) {
        okBtn.onclick = function(e) {
          e.stopPropagation();
          var val = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
          console.log('[showBatchNumberPrompt] OK clicked, batch number:', val || '(empty)');
          cleanup();
          // Small delay to ensure DOM cleanup before next modal
          setTimeout(function() {
            resolve(val);
          }, 100);
        };
      }
      if (cancelBtn) {
        cancelBtn.onclick = function(e) {
          e.stopPropagation();
          console.log('[showBatchNumberPrompt] Cancel clicked');
          cleanup();
          setTimeout(function() {
            resolve(null);
          }, 100);
        };
      }
      // REMOVED: Background click handler to prevent accidental dismissal when closing OSK
      // This was causing the modal to dismiss when users tapped outside to close the keyboard
      if (inputEl) inputEl.focus();
    }, 50);
  });
}

// Function to show beaker selection popup when loading a recipe
function showBeakerSelectionPopup(recipeName) {
  console.log('[showBeakerSelectionPopup] Creating beaker selection modal for:', recipeName);
  return new Promise(resolve => {
    // Remove existing modal if any
    const existing = document.getElementById('beaker-selection-modal');
    if (existing) {
      console.log('[showBeakerSelectionPopup] Removing existing modal');
      existing.remove();
    }
    
    const modal = document.createElement('div');
    modal.id = 'beaker-selection-modal';
    modal.className = 'modal active';
    modal.style.cssText = 'display:flex!important;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:11000;justify-content:center;align-items:center;';
    modal.innerHTML = `
      <div class="modal-content"
           style="background:#1f2937;border-radius:20px;padding:32px;max-width:600px;border:4px solid #4b5563;box-shadow:0 8px 32px rgba(0,0,0,0.5);"
           onclick="event.stopPropagation();">
        <h2 style="font-size:24px;font-weight:bold;margin-bottom:16px;color:white;text-align:center;">Select Beaker</h2>
        <p style="margin-bottom:24px;color:#a0aec0;font-size:16px;text-align:center;">
          Which beaker should the recipe "${recipeName}" be applied to?
        </p>
        <div style="display:flex;flex-direction:column;gap:12px;">
          <button id="recipe-beaker-select-1"
                  class="action-btn-large bg-blue-600 hover:bg-blue-700 text-white"
                  style="width:100%;padding:20px 24px;font-size:18px;display:flex;align-items:center;justify-content:center;gap:12px;">
            <i data-lucide="beaker" style="width:24px;height:24px;"></i>
            <span>Beaker 1</span>
          </button>
          <button id="recipe-beaker-select-2"
                  class="action-btn-large bg-blue-600 hover:bg-blue-700 text-white"
                  style="width:100%;padding:20px 24px;font-size:18px;display:flex;align-items:center;justify-content:center;gap:12px;">
            <i data-lucide="beaker" style="width:24px;height:24px;"></i>
            <span>Beaker 2</span>
          </button>
          <button id="recipe-beaker-select-both"
                  class="action-btn-large bg-green-600 hover:bg-green-700 text-white"
                  style="width:100%;padding:20px 24px;font-size:18px;display:flex;align-items:center;justify-content:center;gap:12px;">
            <i data-lucide="beaker" style="width:24px;height:24px;"></i>
            <span>Both Beakers</span>
          </button>
          <button id="recipe-beaker-select-cancel"
                  class="action-btn-large bg-gray-600 hover:bg-gray-700 text-white"
                  style="width:100%;padding:16px 24px;font-size:16px;margin-top:8px;">
            Cancel
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    console.log('[showBeakerSelectionPopup] Modal added to DOM');
    
    // Refresh lucide icons
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      setTimeout(() => {
        lucide.createIcons();
      }, 50);
    }
    
    setTimeout(() => {
      const cleanup = () => {
        console.log('[showBeakerSelectionPopup] Cleaning up modal');
        if (modal && modal.parentNode) {
          modal.parentNode.removeChild(modal);
        }
      };
      
      const btn1 = document.getElementById('recipe-beaker-select-1');
      const btn2 = document.getElementById('recipe-beaker-select-2');
      const btnBoth = document.getElementById('recipe-beaker-select-both');
      const btnCancel = document.getElementById('recipe-beaker-select-cancel');
      
      console.log('[showBeakerSelectionPopup] Wiring up buttons');
      
      if (btn1) {
        btn1.onclick = (e) => {
          e.stopPropagation();
          console.log('[showBeakerSelectionPopup] Beaker 1 selected');
          cleanup();
          resolve(1);
        };
      }
      
      if (btn2) {
        btn2.onclick = (e) => {
          e.stopPropagation();
          console.log('[showBeakerSelectionPopup] Beaker 2 selected');
          cleanup();
          resolve(2);
        };
      }
      
      if (btnBoth) {
        btnBoth.onclick = (e) => {
          e.stopPropagation();
          console.log('[showBeakerSelectionPopup] Both beakers selected');
          cleanup();
          resolve('both');
        };
      }
      
      if (btnCancel) {
        btnCancel.onclick = (e) => {
          e.stopPropagation();
          console.log('[showBeakerSelectionPopup] Cancel clicked');
          cleanup();
          resolve(null);
        };
      }
      
      // Close on backdrop click
      modal.onclick = (e) => {
        if (e.target === modal) {
          cleanup();
          resolve(null);
        }
      };
    }, 10);
  });
}

// Show beaker selection popup for calibration
function showCalibrationBeakerSelection() {
  return new Promise(resolve => {
    const existing = document.getElementById('calibration-beaker-selection-modal');
    if (existing) {
      existing.remove();
    }
    
    const modal = document.createElement('div');
    modal.id = 'calibration-beaker-selection-modal';
    modal.className = 'modal active';
    modal.style.cssText = 'display:flex!important;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:11000;justify-content:center;align-items:center;';
    modal.innerHTML = `
      <div class="modal-content"
           style="background:#1f2937;border-radius:20px;padding:40px;max-width:600px;border:4px solid #4b5563;box-shadow:0 8px 32px rgba(0,0,0,0.5);"
           onclick="event.stopPropagation();">
        <h2 style="font-size:28px;font-weight:bold;margin-bottom:20px;color:white;text-align:center;">Temperature Calibration</h2>
        <p style="margin-bottom:32px;color:#9ca3af;font-size:18px;text-align:center;line-height:1.6;">
          Select which beaker you want to calibrate.<br>
          System will read current temperature and you'll enter the actual value.
        </p>
        <div style="display:flex;flex-direction:column;gap:16px;">
          <button id="calibration-beaker-select-1"
                  class="action-btn-large bg-blue-600 hover:bg-blue-700 text-white"
                  style="width:100%;padding:24px;font-size:20px;display:flex;align-items:center;justify-content:center;gap:12px;">
            <i data-lucide="thermometer" style="width:28px;height:28px;"></i>
            <span>Beaker 1</span>
          </button>
          <button id="calibration-beaker-select-2"
                  class="action-btn-large bg-blue-600 hover:bg-blue-700 text-white"
                  style="width:100%;padding:24px;font-size:20px;display:flex;align-items:center;justify-content:center;gap:12px;">
            <i data-lucide="thermometer" style="width:28px;height:28px;"></i>
            <span>Beaker 2</span>
          </button>
          <button id="calibration-beaker-select-cancel"
                  class="action-btn-large bg-gray-600 hover:bg-gray-700 text-white"
                  style="width:100%;padding:18px;font-size:18px;margin-top:12px;">
            Cancel
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    if (typeof lucide !== 'undefined' && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
    
    const cleanup = () => {
      if (modal && modal.parentNode) {
        modal.remove();
      }
    };
    
    const btn1 = document.getElementById('calibration-beaker-select-1');
    const btn2 = document.getElementById('calibration-beaker-select-2');
    const btnCancel = document.getElementById('calibration-beaker-select-cancel');
    
    if (btn1) {
      btn1.onclick = (e) => {
        e.stopPropagation();
        cleanup();
        resolve(1);
      };
    }
    
    if (btn2) {
      btn2.onclick = (e) => {
        e.stopPropagation();
        cleanup();
        resolve(2);
      };
    }
    
    if (btnCancel) {
      btnCancel.onclick = (e) => {
        e.stopPropagation();
        cleanup();
        resolve(null);
      };
    }
    
    modal.onclick = (e) => {
      if (e.target === modal) {
        cleanup();
        resolve(null);
      }
    };
  });
}

async function selectRecipeForExecution(index) {
  console.log('[selectRecipeForExecution] Starting for recipe index:', index);
  var r = recipes[index];
  if (!r) {
    if (typeof showModal === 'function') {
      showModal('Recipe not found');
    }
    return;
  }

  // Ask for batch number first
  console.log('[selectRecipeForExecution] Showing batch number prompt for recipe:', r.name);
  var batchNumber = await showBatchNumberPrompt(r.name || 'Recipe');
  console.log('[selectRecipeForExecution] Batch number received:', batchNumber);
  if (batchNumber === null) {
    console.log('[selectRecipeForExecution] Batch number was cancelled, exiting');
    return;
  }

  // Ask which beaker to apply to
  console.log('[selectRecipeForExecution] Showing beaker selection popup');
  var selectedBeaker = await showBeakerSelectionPopup(r.name || 'Recipe');
  console.log('[selectRecipeForExecution] Beaker selected:', selectedBeaker);
  if (selectedBeaker === null) {
    console.log('[selectRecipeForExecution] Beaker selection was cancelled, exiting');
    return;
  }

  var beakerNum = selectedBeaker === 'both' ? 1 : selectedBeaker;
  var applyToBoth = (selectedBeaker === 'both');

  var productName = r.product || r.name || 'Unknown Product';
  batchNumber = batchNumber || 'N/A';
  var temperature = parseFloat(r.temp) || 37.0;
  var mode = r.mode || 'timer';
  var duration = parseFloat(r.duration) || 30; // minutes
  
  // Store product/batch/duration per basket
  if (applyToBoth) {
    basketProducts[1] = productName;
    basketProducts[2] = productName;
    basketBatches[1] = batchNumber;
    basketBatches[2] = batchNumber;
    basketDurations[1] = duration;
    basketDurations[2] = duration;
  } else {
    var basketId = beakerNum;
    
    basketProducts[basketId] = productName;
    basketBatches[basketId] = batchNumber;
    basketDurations[basketId] = duration;
    
    // Do NOT clear the other basket's recipe - allow both to have recipes
  }
  
  // Apply mode and temperature per beaker
  if (applyToBoth) {
    basketModes[1] = mode;
    basketModes[2] = mode;
    setTemp[1] = temperature;
    setTemp[2] = temperature;
    
    // NOTE: temp1 and temp2 show INTERNAL temperatures, not set temperatures
    // They are updated by updateTempsToDOM() from the backend
    // dashboard-temp-1 and dashboard-temp-2 show SET temperatures and are updated by updateDashboardTempButton()
    
    if (typeof updateDashboardTempButton === 'function') {
      updateDashboardTempButton();
    }
    
    // Update mode buttons UI for both baskets
    if (typeof selectMode === 'function') {
      selectMode(1, mode);
      selectMode(2, mode);
    }
    
    if (!configuredBeakers[1]) configuredBeakers[1] = true;
    if (!configuredBeakers[2]) configuredBeakers[2] = true;
  } else {
    var basketId2 = beakerNum;
    basketModes[basketId2] = mode;
    setTemp[basketId2] = temperature;
    
    // NOTE: temp1 and temp2 show INTERNAL temperatures, not set temperatures
    // They are updated by updateTempsToDOM() from the backend
    // dashboard-temp-1 and dashboard-temp-2 show SET temperatures and are updated by updateDashboardTempButton()
    
    if (typeof updateDashboardTempButton === 'function') {
      updateDashboardTempButton();
    }
    
    // Update mode button UI for the selected basket
    if (typeof selectMode === 'function') {
      selectMode(basketId2, mode);
    }
    
    if (!configuredBeakers[basketId2]) {
      configuredBeakers[basketId2] = true;
    }
  }
  
  // Persist everything
  await safeSave('basketProducts', basketProducts);
  await safeSave('basketBatches', basketBatches);
  await safeSave('basketDurations', basketDurations);
  await safeSave('basketModes', basketModes);
  await safeSave('setTemp', setTemp);
  await safeSave('configuredBeakers', configuredBeakers);
  
  // Update dashboard beaker visibility and buttons
  if (typeof updateBasketStates === 'function') {
    updateBasketStates();
  }
  
  // Update top bar product names (must be after configuredBeakers is set)
  if (typeof updateDashboardProductNames === 'function') {
    updateDashboardProductNames();
  }
  
  // Show confirmation popup
  let targetDescription;
  if (applyToBoth) {
    targetDescription = 'both beakers';
  } else if (selectedBeaker === 1 || selectedBeaker === 2) {
    targetDescription = 'Beaker ' + selectedBeaker;
  } else {
    targetDescription = 'selected beaker';
  }
  
  const recipeName = r.name || r.product || 'Recipe';
  
  if (typeof showToast === 'function') {
    showToast(`"${recipeName}" has been loaded to ${targetDescription}.`);
  } else if (typeof showModal === 'function') {
    showModal(`"${recipeName}" has been loaded to ${targetDescription}.`);
  } else {
    alert(`"${recipeName}" has been loaded to ${targetDescription}.`);
  }
  
  // Navigate back to home/dashboard after loading recipe
  if (typeof navigateTo === 'function') {
    navigateTo('dashboard');
  } else if (typeof window.navigateTo === 'function') {
    window.navigateTo('dashboard');
  }
  
  // Do NOT auto-start tests – user will press Start
}

// Update dashboard product names display
function updateDashboardProductNames() {
  var elem = document.getElementById('dashboard-product-names');
  if (!elem) return;
  
  var c1 = configuredBeakers && !!configuredBeakers[1];
  var c2 = configuredBeakers && !!configuredBeakers[2];
  
  var p1 = basketProducts ? basketProducts[1] : null;
  var p2 = basketProducts ? basketProducts[2] : null;
  
  var b1 = basketBatches ? basketBatches[1] : null;
  var b2 = basketBatches ? basketBatches[2] : null;
  
  var parts = [];
  
  if (c1 && p1) {
    var part1 = 'B1: ' + p1;
    if (b1) part1 += ' (Batch : ' + b1 + ')';
    parts.push(part1);
  }
  
  if (c2 && p2) {
    var part2 = 'B2: ' + p2;
    if (b2) part2 += ' (Batch : ' + b2 + ')';
    parts.push(part2);
  }
  
  elem.textContent = parts.join('  |  ');
  
  // Save to storage
  (async function() {
    await safeSave('basketProducts', basketProducts);
    await safeSave('basketBatches', basketBatches);
  })();
}

// Clear product names on dashboard load (no preloading)
async function loadDashboardProductNames() {
  try {
    // Clear basket products and batches - dashboard should start blank
    basketProducts[1] = null;
    basketProducts[2] = null;
    basketBatches[1] = null;
    basketBatches[2] = null;
    
    // Clear from storage as well
    await safeSave('basketProducts', basketProducts);
    await safeSave('basketBatches', basketBatches);
    
    updateDashboardProductNames();
  } catch (e) {
    console.error('Error clearing dashboard product names:', e);
  }
}

// Expose all functions globally
window.selectMode = selectMode;
window.updateModeButtonsUI = updateModeButtonsUI;
window.toggleHeater = toggleHeater;
window.handleBasketTap = handleBasketTap;
window.startTest = startTest;
window.stopTest = stopTest;
window.upd = upd;
window.fmt = fmt;
window.saveProfile = saveProfile;
window.filterReports = filterReports;
window.exportReports = exportReports;
window.exportReport = exportReport;
window.exportSingleReport = exportSingleReport;
window.exportFilteredReports = exportFilteredReports;
window.exportReportsByType = exportReportsByType;

// Wire export buttons on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireExportButtons);
} else {
  wireExportButtons();
}

// --- Dashboard temperature updates (Pi → UI) ---

// Try socket.io first, if available
function startTempUpdates() {
  if (typeof io !== 'undefined') {
    try {
      const socket = io();
      socket.on('connect', () => console.log('[TEMP] Socket connected'));
      socket.on('temps_update', (data) => {
        // data: { t1: <num>, t2: <num>, ext1: <num>, ext2: <num>, ts: <epoch> }
        updateTempWidgets(data);
      });
      // on reconnect try to request latest once
      socket.on('reconnect', () => {
        fetchLatestTemps().then(updateTempWidgets).catch(()=>{});
      });
      return;
    } catch (e) {
      console.warn('[TEMP] socket.io init failed', e);
    }
  }
  // Fallback polling every 5s
  setInterval(async () => {
    try {
      const t = await fetchLatestTemps();
      if (t) updateTempWidgets(t);
    } catch (e) { 
      console.warn('[TEMP] polling failed', e); 
    }
  }, 5000);
}

async function fetchLatestTemps() {
  // Use SSE-pushed data from bridge; no frontend fetch
  if (window.latestTemps && (window.latestTemps.IR1 !== undefined || window.latestTemps.IR2 !== undefined)) {
    const ts = window.latestTemps.timestamp ? Math.floor(window.latestTemps.timestamp / 1000) : null;
    return {
      t1: window.latestTemps.IR1, t2: window.latestTemps.IR2,
      ext1: window.latestTemps.EXT1, ext2: window.latestTemps.EXT2,
      ts: ts
    };
  }
  return null;
}

function updateTempWidgets(data) {
  if (!data) return;
  
  // Helper function to validate and format temperature value
  function isValidTemp(val) {
    return val !== null && val !== undefined && typeof val === 'number' && !isNaN(val) && isFinite(val);
  }
  
  const el1 = document.getElementById('temp-t1');
  const el2 = document.getElementById('temp-t2');
  const elExt1 = document.getElementById('temp-ext1');
  const elExt2 = document.getElementById('temp-ext2');
  
  if (el1) el1.innerText = isValidTemp(data.t1) ? data.t1.toFixed(2) : '--';
  if (el2) el2.innerText = isValidTemp(data.t2) ? data.t2.toFixed(2) : '--';
  if (elExt1) elExt1.innerText = isValidTemp(data.ext1) ? data.ext1.toFixed(2) : '--';
  if (elExt2) elExt2.innerText = isValidTemp(data.ext2) ? data.ext2.toFixed(2) : '--';
  
  // show last updated time if needed
  const ts = document.getElementById('temp-ts');
  if (ts && data.ts) ts.innerText = new Date(data.ts * 1000).toLocaleTimeString();
  
  // NOTE: dashboard-temp-1 and dashboard-temp-2 should NOT be updated here
  // They show SET temperatures and are managed by updateDashboardTempButton()
  // which uses setTemp[1] and setTemp[2] values
}

// Start temperature updates on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startTempUpdates);
} else {
  startTempUpdates();
}

window.saveReportPdfToServer = saveReportPdfToServer;
window.saveReportPdfFromHtml = saveReportPdfFromHtml;
window.handlePrintA4 = handlePrintA4;
window.handlePrintThermal = handlePrintThermal;
window.openReportPreview = openReportPreview;
window.selectBeakerForValidation = selectBeakerForValidation;
window.navigateToValidateFlow = navigateToValidateFlow;
window.navigateToCalibration = navigateToCalibration;
window.updateValidationSelection = updateValidationSelection;
window.startValidationProcess = startValidationProcess;
window.stopValidation = stopValidation;
window.completeValidation = completeValidation;
window.calibrateTemperatureSensor = calibrateTemperatureSensor;
window.stopCalibration = stopCalibration;
window.handleTempValidationPass = handleTempValidationPass;
window.handleTempValidationFail = handleTempValidationFail;
window.incrementValidationTemp = incrementValidationTemp;
window.decrementValidationTemp = decrementValidationTemp;
window.applyValidationSetTemp = applyValidationSetTemp;
window.performCalibration = performCalibration;
window.deleteCalibration = deleteCalibration;
window.setCalibrationDeleteVisible = setCalibrationDeleteVisible;
window.loadReports = loadReports;
window.saveReportRecord = saveReportRecord;
window.setBasketConfig = setBasketConfig;
window.selectBeaker = selectBeaker;
window.proceedWithBeakerSelection = proceedWithBeakerSelection;
window.applyHeaterSettings = applyHeaterSettings;
window.setTimeFormat = setTimeFormat;
window.renderRecipeList = renderRecipeList;
window.editRecipe = editRecipe;
window.saveRecipe = saveRecipe;
window.cancelRecipe = cancelRecipe;
window.deleteRecipe = deleteRecipe;
window.selectRecipeBeaker = selectRecipeBeaker;
window.selectRecipeMode = selectRecipeMode;
window.clearRecipeModeSelection = clearRecipeModeSelection;
window.selectRecipeForExecution = selectRecipeForExecution;
window.incrementTemp = incrementTemp;
window.decrementTemp = decrementTemp;
window.formatTemperatureInput = formatTemperatureInput;
window.initTemperatureInputs = initTemperatureInputs;
window.updateDashboardProductNames = updateDashboardProductNames;

// ========== SMOOTH INFINITE SCROLLING WHEEL HELPER ==========
// Creates a smooth infinite scrolling wheel with better padding and snap behavior
// (because regular dropdowns are boring and this looks cooler)
function createSmoothInfiniteWheel(wheel, minValue, maxValue, currentValue, onUpdate) {
  if (!wheel) return;
  
  wheel.innerHTML = '';
  
  var itemHeight = 60;
  var padding = 10; // Increased padding for smoother infinite loop
  var totalItems = maxValue - minValue + 1;
  
  // Add multiple sets of padding items at top (duplicates of last items)
  for (var p = padding; p > 0; p--) {
    var paddingItem = document.createElement('div');
    paddingItem.className = 'temp-wheel-item';
    paddingItem.style.height = itemHeight + 'px';
    var val = ((maxValue + 1 - p) % totalItems + totalItems) % totalItems;
    if (val < minValue) val = minValue;
    if (val > maxValue) val = maxValue;
    paddingItem.textContent = val;
    paddingItem.dataset.value = val;
    wheel.appendChild(paddingItem);
  }
  
  // Add actual items
  for (var i = minValue; i <= maxValue; i++) {
    var item = document.createElement('div');
    item.className = 'temp-wheel-item';
    item.style.height = itemHeight + 'px';
    item.textContent = i;
    item.dataset.value = i;
    if (i === currentValue) {
      item.classList.add('selected');
    }
    wheel.appendChild(item);
  }
  
  // Add multiple sets of padding items at bottom (duplicates of first items)
  for (var p = 1; p <= padding; p++) {
    var paddingItem = document.createElement('div');
    paddingItem.className = 'temp-wheel-item';
    paddingItem.style.height = itemHeight + 'px';
    var val = ((minValue + p - 1) % totalItems + totalItems) % totalItems;
    if (val < minValue) val = minValue;
    if (val > maxValue) val = maxValue;
    paddingItem.textContent = val;
    paddingItem.dataset.value = val;
    wheel.appendChild(paddingItem);
  }
  
  // Set initial scroll position (start in the middle of actual items)
  var initialScroll = (padding + (currentValue - minValue)) * itemHeight;
  wheel.scrollTop = initialScroll;
  
  // CRITICAL: Ensure wheel is scrollable with touch - make it work like datetime picker
  wheel.style.touchAction = 'pan-y';
  wheel.style.webkitOverflowScrolling = 'touch';
  wheel.style.overflowY = 'auto';
  wheel.style.overflowX = 'hidden';
  wheel.style.cursor = 'pointer';
  
  // Make individual items also scrollable (direct touch on numbers)
  var items = wheel.querySelectorAll('.temp-wheel-item');
  for (var itemIdx = 0; itemIdx < items.length; itemIdx++) {
    items[itemIdx].style.pointerEvents = 'auto';
    items[itemIdx].style.touchAction = 'pan-y';
    items[itemIdx].style.cursor = 'grab';
  }
  
  // Remove existing listeners by cloning
  var newWheel = wheel.cloneNode(true);
  wheel.parentNode.replaceChild(newWheel, wheel);
  wheel = newWheel;
  
  var isScrolling = false;
  var scrollTimeout = null;
  
  // FIXED: Add proper touch scrolling support
  var touchStartY = 0;
  var touchStartScroll = 0;
  var isTouchActive = false;
  
  // FIXED: Enhanced touch scrolling - allow direct scrolling on numbers
  wheel.addEventListener('touchstart', function(e) {
    touchStartY = e.touches[0].clientY;
    touchStartScroll = wheel.scrollTop;
    isTouchActive = true;
    // Don't prevent default - allow native scrolling
    // Update selection immediately when touch starts
    if (onUpdate) {
      onUpdate(wheel);
    }
  }, { passive: true });
  
  wheel.addEventListener('touchmove', function(e) {
    // Allow native scrolling - don't prevent default
    isTouchActive = true;
    // Update selection while scrolling for immediate feedback
    if (onUpdate) {
      onUpdate(wheel);
    }
  }, { passive: true });
  
  wheel.addEventListener('touchend', function(e) {
    isTouchActive = false;
    // Trigger snap after touch ends to ensure proper alignment
    setTimeout(function() {
      snapToCenter(wheel, itemHeight, padding, minValue, maxValue, onUpdate);
    }, 150);
  }, { passive: true });
  
  // Also allow mouse wheel scrolling directly on the wheel
  wheel.addEventListener('wheel', function(e) {
    // Allow native scrolling
    e.preventDefault(); // Prevent page scroll, but allow wheel scrolling
    wheel.scrollTop += e.deltaY;
    // Update selection while scrolling
    if (onUpdate) {
      onUpdate(wheel);
    }
    // Clear existing timeout and set new one
    if (scrollTimeout) clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(function() {
      snapToCenter(wheel, itemHeight, padding, minValue, maxValue, onUpdate);
    }, 150);
  }, { passive: false });
  
  wheel.addEventListener('scroll', function() {
    if (isScrolling) return;
    
    // Clear previous timeout
    if (scrollTimeout) clearTimeout(scrollTimeout);
    
    // Update selection
    if (onUpdate) {
      onUpdate(wheel);
    }
    
    // Handle infinite loop - check boundaries
    var scrollPos = wheel.scrollTop;
    var topBoundary = padding * itemHeight;
    var bottomBoundary = (padding + totalItems) * itemHeight;
    
    if (scrollPos < topBoundary) {
      // Scrolled into top padding - jump forward
      isScrolling = true;
      wheel.scrollTop = scrollPos + (totalItems * itemHeight);
      setTimeout(function() { isScrolling = false; }, 10);
    } else if (scrollPos >= bottomBoundary) {
      // Scrolled into bottom padding - jump backward
      isScrolling = true;
      wheel.scrollTop = scrollPos - (totalItems * itemHeight);
      setTimeout(function() { isScrolling = false; }, 10);
    }
    
    // Debounce snap-to-center after scrolling stops (longer delay for touch)
    var delay = isTouchActive ? 300 : 150;
    scrollTimeout = setTimeout(function() {
      if (!isTouchActive) {
        snapToCenter(wheel, itemHeight, padding, minValue, maxValue, onUpdate);
      }
    }, delay);
  }, { passive: true });
  
  // Initial snap
  setTimeout(function() {
    snapToCenter(wheel, itemHeight, padding, minValue, maxValue, onUpdate);
  }, 100);
}

// Snap the wheel to center the closest item
function snapToCenter(wheel, itemHeight, padding, minValue, maxValue, onUpdate) {
  if (!wheel) return;
  
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    // Calculate target scroll position to center this item
    var targetScroll = closestIndex * itemHeight - (wheelRect.height / 2) + (itemHeight / 2);
    
    // Smooth scroll to center
    wheel.scrollTo({
      top: targetScroll,
      behavior: 'smooth'
    });
    
    // Update selection
    if (onUpdate) {
      setTimeout(function() {
        onUpdate(wheel);
      }, 300);
    }
  }
}

// ========== TEMPERATURE PICKER (SCROLLING WHEEL) ==========
// Temperature selection with fancy scrolling wheels (because typing numbers is hard)
var tempPickerBasketId = null;
var tempPickerWholeValue = 37;
var tempPickerDecimalValue = 0;

function showTempPicker(basketId) {
  tempPickerBasketId = basketId;
  var inputEl = document.getElementById('set-temp-' + basketId);
  var currentValue = 37.0;
  
  if (inputEl) {
    currentValue = parseFloat(inputEl.value) || 37.0;
  }
  
  tempPickerWholeValue = Math.floor(currentValue);
  tempPickerDecimalValue = Math.round((currentValue - tempPickerWholeValue) * 10);
  
  // Update display
  var displayEl = document.getElementById('temp-picker-display');
  var basketEl = document.getElementById('temp-picker-basket');
  if (displayEl) {
    displayEl.textContent = currentValue.toFixed(1);
  }
  if (basketEl) {
    basketEl.textContent = basketId;
  }
  
  // Populate whole number wheel (0-50) with smooth infinite loop
  var wholeWheel = document.getElementById('temp-wheel-whole');
  if (wholeWheel) {
    createSmoothInfiniteWheel(wholeWheel, 0, 55, tempPickerWholeValue, function(wheel) {
      updateTempPickerSelection('whole', wheel);
    });
  }
  
  // Populate decimal wheel (0-9) with smooth infinite loop
  var decimalWheel = document.getElementById('temp-wheel-decimal');
  if (decimalWheel) {
    createSmoothInfiniteWheel(decimalWheel, 0, 9, tempPickerDecimalValue, function(wheel) {
      updateTempPickerSelection('decimal', wheel);
    });
  }
  
  // Show modal
  var modalEl = document.getElementById('temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  // Hide OSK if visible
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  // Update icons
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateTempPickerSelection(type, wheel) {
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    // Remove selected class from all items
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove('selected');
    }
    // Add selected class to closest item
    closestItem.classList.add('selected');
    
    var itemHeight = 60;
    var padding = 10;
    
    if (type === 'whole') {
      var minValue = 0;
      var maxValue = 55;
      var totalItems = maxValue - minValue + 1;
      
      // Calculate which actual item index this corresponds to
      if (closestIndex >= padding && closestIndex < padding + totalItems) {
        // This is an actual item - calculate its value directly from index
        var actualItemIndex = closestIndex - padding;
        tempPickerWholeValue = minValue + actualItemIndex;
      } else {
        // This is a padding item - use dataset value
        var datasetValue = parseInt(closestItem.dataset.value);
        if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
          tempPickerWholeValue = datasetValue;
        }
      }
    } else {
      var minValue = 0;
      var maxValue = 9;
      var totalItems = maxValue - minValue + 1;
      
      // Same logic for decimal wheel
      if (closestIndex >= padding && closestIndex < padding + totalItems) {
        // This is an actual item - calculate its value directly from index
        var actualItemIndex = closestIndex - padding;
        tempPickerDecimalValue = minValue + actualItemIndex;
      } else {
        // This is a padding item - use dataset value
        var datasetValue = parseInt(closestItem.dataset.value);
        if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
          tempPickerDecimalValue = datasetValue;
        }
      }
    }
    
    // Update display - use precise calculation
    var displayValue = tempPickerWholeValue + (tempPickerDecimalValue / 10);
    var displayEl = document.getElementById('temp-picker-display');
    if (displayEl) {
      displayEl.textContent = displayValue.toFixed(1);
    }
  }
}

function cancelTempPicker() {
  var modalEl = document.getElementById('temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
  tempPickerBasketId = null;
}

function applyTempPicker() {
  if (tempPickerBasketId === null) return;
  
  var inputEl = document.getElementById('set-temp-' + tempPickerBasketId);
  var displayEl = document.getElementById('set-temp-' + tempPickerBasketId + '-text');
  var finalValue = tempPickerWholeValue + (tempPickerDecimalValue / 10);
  if (finalValue > MAX_TEMP_C) {
    if (typeof showModal === 'function') {
      showModal('MAX temperature is 55°C. Enter the temperature in range.');
    }
    return;
  }
  if (inputEl) {
    inputEl.value = finalValue.toFixed(1);
    setTemp[tempPickerBasketId] = finalValue;
  }
  
  if (displayEl) {
    displayEl.textContent = finalValue.toFixed(1);
  }
  
  try {
    if (typeof safeSave === 'function') safeSave('setTemp', setTemp);
  } catch (e) {}
  
  // Update all set temperature displays
  updateSetTempUI(finalValue);
  
  cancelTempPicker();
}

// ========== RECIPE TEMPERATURE PICKER ==========
var recipeTempPickerWholeValue = 37;
var recipeTempPickerDecimalValue = 0;

function showRecipeTempPicker() {
  var inputEl = document.getElementById('recipe-temp');
  var currentValue = 37.0;
  
  if (inputEl) {
    currentValue = parseFloat(inputEl.value) || 37.0;
  }
  
  recipeTempPickerWholeValue = Math.floor(currentValue);
  recipeTempPickerDecimalValue = Math.round((currentValue - recipeTempPickerWholeValue) * 10);
  
  // Update display
  var displayEl = document.getElementById('recipe-temp-picker-display');
  if (displayEl) {
    displayEl.textContent = currentValue.toFixed(1);
  }
  
  // Populate whole number wheel (0-55) with smooth infinite loop
  var wholeWheel = document.getElementById('recipe-temp-wheel-whole');
  if (wholeWheel) {
    createSmoothInfiniteWheel(wholeWheel, 0, 55, recipeTempPickerWholeValue, function(wheel) {
      updateRecipeTempPickerSelection('whole', wheel);
    });
  }
  
  // Populate decimal wheel (0-9) with smooth infinite loop
  var decimalWheel = document.getElementById('recipe-temp-wheel-decimal');
  if (decimalWheel) {
    createSmoothInfiniteWheel(decimalWheel, 0, 9, recipeTempPickerDecimalValue, function(wheel) {
      updateRecipeTempPickerSelection('decimal', wheel);
    });
  }
  
  // Show modal
  var modalEl = document.getElementById('recipe-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateRecipeTempPickerSelection(type, wheel) {
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove('selected');
    }
    closestItem.classList.add('selected');
    
    var itemHeight = 60;
    var padding = 10;
    
    if (type === 'whole') {
      var minValue = 0;
      var maxValue = 55;
      var totalItems = maxValue - minValue + 1;
      
      if (closestIndex >= padding && closestIndex < padding + totalItems) {
        var actualItemIndex = closestIndex - padding;
        recipeTempPickerWholeValue = minValue + actualItemIndex;
      } else {
        var datasetValue = parseInt(closestItem.dataset.value);
        if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
          recipeTempPickerWholeValue = datasetValue;
        }
      }
    } else {
      var minValue = 0;
      var maxValue = 9;
      var totalItems = maxValue - minValue + 1;
      
      if (closestIndex >= padding && closestIndex < padding + totalItems) {
        var actualItemIndex = closestIndex - padding;
        recipeTempPickerDecimalValue = minValue + actualItemIndex;
      } else {
        var datasetValue = parseInt(closestItem.dataset.value);
        if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
          recipeTempPickerDecimalValue = datasetValue;
        }
      }
    }
    
    var displayValue = recipeTempPickerWholeValue + (recipeTempPickerDecimalValue / 10);
    var displayEl = document.getElementById('recipe-temp-picker-display');
    if (displayEl) {
      displayEl.textContent = displayValue.toFixed(1);
    }
  }
}

function cancelRecipeTempPicker() {
  var modalEl = document.getElementById('recipe-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyRecipeTempPicker() {
  var inputEl = document.getElementById('recipe-temp');
  var displayEl = document.getElementById('recipe-temp-text');
  var finalValue = recipeTempPickerWholeValue + (recipeTempPickerDecimalValue / 10);
  if (finalValue > MAX_TEMP_C) {
    if (typeof showModal === 'function') {
      showModal('MAX temperature is 55°C. Enter the temperature in range.');
    }
    return;
  }
  if (inputEl) {
    inputEl.value = finalValue.toFixed(1);
  }
  
  if (displayEl) {
    displayEl.textContent = finalValue.toFixed(1);
  }
  
  // Update all set temperature displays
  updateSetTempUI(finalValue);
  
  cancelRecipeTempPicker();
}

// ========== RECIPE DURATION PICKER (MM:SS only) ==========
var recipeDurationPickerMinutes = 0;
var recipeDurationPickerSeconds = 0;

function showRecipeDurationPicker() {
  var inputEl = document.getElementById('recipe-duration');
  recipeDurationPickerMinutes = 0;
  recipeDurationPickerSeconds = 0;
  
  if (inputEl && inputEl.value) {
    var parts = inputEl.value.trim().split(':');
    if (parts.length === 2) {
      var m = parseInt(parts[0], 10);
      var s = parseInt(parts[1], 10);
      if (!isNaN(m) && m >= 0 && m <= 99) recipeDurationPickerMinutes = m;
      if (!isNaN(s) && s >= 0 && s <= 59) recipeDurationPickerSeconds = s;
    }
  }
  
  var displayEl = document.getElementById('recipe-duration-picker-display');
  if (displayEl) {
    displayEl.textContent = String(recipeDurationPickerMinutes).padStart(2, '0') + ':' + String(recipeDurationPickerSeconds).padStart(2, '0');
  }
  
  var minutesWheel = document.getElementById('recipe-duration-wheel-minutes');
  if (minutesWheel) {
    createSmoothInfiniteWheel(minutesWheel, 0, 99, recipeDurationPickerMinutes, function(wheel) {
      updateRecipeDurationPickerSelection('minutes', wheel);
    });
  }
  
  var secondsWheel = document.getElementById('recipe-duration-wheel-seconds');
  if (secondsWheel) {
    createSmoothInfiniteWheel(secondsWheel, 0, 59, recipeDurationPickerSeconds, function(wheel) {
      updateRecipeDurationPickerSelection('seconds', wheel);
    });
  }
  
  // Show modal
  var modalEl = document.getElementById('recipe-duration-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateRecipeDurationPickerSelection(type, wheel) {
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove('selected');
    }
    closestItem.classList.add('selected');
    
    var itemHeight = 60;
    var padding = 10;
    
    var minValue, maxValue;
    if (type === 'minutes') {
      minValue = 0;
      maxValue = 99;
    } else {
      minValue = 0;
      maxValue = 59;
    }
    
    var totalItems = maxValue - minValue + 1;
    
    if (closestIndex >= padding && closestIndex < padding + totalItems) {
      var actualItemIndex = closestIndex - padding;
      var value = minValue + actualItemIndex;
      
      if (type === 'minutes') {
        recipeDurationPickerMinutes = value;
      } else {
        recipeDurationPickerSeconds = value;
      }
    } else {
      var datasetValue = parseInt(closestItem.dataset.value);
      if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
        if (type === 'minutes') {
          recipeDurationPickerMinutes = datasetValue;
        } else {
          recipeDurationPickerSeconds = datasetValue;
        }
      }
    }
    
    var displayEl = document.getElementById('recipe-duration-picker-display');
    if (displayEl) {
      displayEl.textContent = String(recipeDurationPickerMinutes).padStart(2, '0') + ':' + String(recipeDurationPickerSeconds).padStart(2, '0');
    }
  }
}

function cancelRecipeDurationPicker() {
  var modalEl = document.getElementById('recipe-duration-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyRecipeDurationPicker() {
  var inputEl = document.getElementById('recipe-duration');
  var displayEl = document.getElementById('recipe-duration-text');
  var mmss = String(recipeDurationPickerMinutes).padStart(2, '0') + ':' + String(recipeDurationPickerSeconds).padStart(2, '0');
  
  if (inputEl) {
    inputEl.value = mmss;
  }
  
  if (displayEl) {
    displayEl.textContent = mmss;
  }
  
  cancelRecipeDurationPicker();
}

window.showTempPicker = showTempPicker;
window.cancelTempPicker = cancelTempPicker;
window.applyTempPicker = applyTempPicker;
// ========== VALIDATION TEMPERATURE PICKER ==========
var validationTempPickerWholeValue = 37;
var validationTempPickerDecimalValue = 0;

function showValidationTempPicker() {
  var inputEl = document.getElementById('temp-validation-set-temp-input');
  var currentValue = 37.0;
  
  if (inputEl) {
    currentValue = parseFloat(inputEl.value) || 37.0;
  }
  
  validationTempPickerWholeValue = Math.floor(currentValue);
  validationTempPickerDecimalValue = Math.round((currentValue - validationTempPickerWholeValue) * 10);
  
  // Update display
  var displayEl = document.getElementById('validation-temp-picker-display');
  if (displayEl) {
    displayEl.textContent = currentValue.toFixed(1);
  }
  
  // Populate whole number wheel (0-50) with smooth infinite loop
  var wholeWheel = document.getElementById('validation-temp-wheel-whole');
  if (wholeWheel) {
    createSmoothInfiniteWheel(wholeWheel, 0, 55, validationTempPickerWholeValue, function(wheel) {
      updateValidationTempPickerSelection('whole', wheel);
    });
  }
  
  // Populate decimal wheel (0-9) with smooth infinite loop
  var decimalWheel = document.getElementById('validation-temp-wheel-decimal');
  if (decimalWheel) {
    createSmoothInfiniteWheel(decimalWheel, 0, 9, validationTempPickerDecimalValue, function(wheel) {
      updateValidationTempPickerSelection('decimal', wheel);
    });
  }
  
  // Show modal
  var modalEl = document.getElementById('validation-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateValidationTempPickerSelection(type, wheel) {
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove('selected');
    }
    closestItem.classList.add('selected');
    
    var itemHeight = 60;
    var padding = 10;
    
    if (type === 'whole') {
      var minValue = 0;
      var maxValue = 55;
      var totalItems = maxValue - minValue + 1;
      
      if (closestIndex >= padding && closestIndex < padding + totalItems) {
        var actualItemIndex = closestIndex - padding;
        validationTempPickerWholeValue = minValue + actualItemIndex;
      } else {
        var datasetValue = parseInt(closestItem.dataset.value);
        if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
          validationTempPickerWholeValue = datasetValue;
        }
      }
    } else {
      var minValue = 0;
      var maxValue = 9;
      var totalItems = maxValue - minValue + 1;
      
      if (closestIndex >= padding && closestIndex < padding + totalItems) {
        var actualItemIndex = closestIndex - padding;
        validationTempPickerDecimalValue = minValue + actualItemIndex;
      } else {
        var datasetValue = parseInt(closestItem.dataset.value);
        if (!isNaN(datasetValue) && datasetValue >= minValue && datasetValue <= maxValue) {
          validationTempPickerDecimalValue = datasetValue;
        }
      }
    }
    
    var displayValue = validationTempPickerWholeValue + (validationTempPickerDecimalValue / 10);
    var displayEl = document.getElementById('validation-temp-picker-display');
    if (displayEl) {
      displayEl.textContent = displayValue.toFixed(1);
    }
  }
}

function cancelValidationTempPicker() {
  var modalEl = document.getElementById('validation-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyValidationTempPicker() {
  var inputEl = document.getElementById('temp-validation-set-temp-input');
  var displayEl = document.getElementById('temp-validation-set-temp-text');
  var finalValue = validationTempPickerWholeValue + (validationTempPickerDecimalValue / 10);
  if (finalValue > MAX_TEMP_C) {
    if (typeof showModal === 'function') {
      showModal('MAX temperature is 55°C. Enter the temperature in range.');
    }
    return;
  }
  if (inputEl) {
    inputEl.value = finalValue.toFixed(1);
  }
  
  if (displayEl) {
    displayEl.textContent = finalValue.toFixed(1);
  }
  
  // Update tempValidationSetTemp and all displays
  tempValidationSetTemp = finalValue;
  updateSetTempUI(finalValue);
  
  cancelValidationTempPicker();
}

// ========== CALIBRATION TEMPERATURE PICKER ==========
var calibrationTempPickerWholeValue = 37;
var calibrationTempPickerDecimalValue = 0;

function showCalibrationTempPicker() {
  var setTempEl = document.getElementById('calibration-set-temp');
  var currentValue = 37.0;
  
  if (setTempEl) {
    var tempText = setTempEl.textContent || '37.0°C';
    tempText = tempText.replace(/[^0-9.]/g, '');
    currentValue = parseFloat(tempText) || 37.0;
  }
  
  calibrationTempPickerWholeValue = Math.floor(currentValue);
  calibrationTempPickerDecimalValue = Math.round((currentValue - calibrationTempPickerWholeValue) * 10);
  
  // Update display
  var displayEl = document.getElementById('calibration-temp-picker-display');
  if (displayEl) {
    displayEl.textContent = currentValue.toFixed(1);
  }
  
  // Populate whole number wheel (0-50) with smooth infinite loop
  var wholeWheel = document.getElementById('calibration-temp-wheel-whole');
  if (wholeWheel) {
    createSmoothInfiniteWheel(wholeWheel, 0, 50, calibrationTempPickerWholeValue, function(wheel) {
      updateCalibrationTempPickerSelection('whole', wheel);
    });
  }
  
  // Populate decimal wheel (0-9) with smooth infinite loop
  var decimalWheel = document.getElementById('calibration-temp-wheel-decimal');
  if (decimalWheel) {
    createSmoothInfiniteWheel(decimalWheel, 0, 9, calibrationTempPickerDecimalValue, function(wheel) {
      updateCalibrationTempPickerSelection('decimal', wheel);
    });
  }
  
  // Show modal
  var modalEl = document.getElementById('calibration-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateCalibrationTempPickerSelection(type, wheel) {
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove('selected');
    }
    closestItem.classList.add('selected');
    
    var datasetValue = parseInt(closestItem.dataset.value);
    if (!isNaN(datasetValue)) {
      if (type === 'whole') {
        calibrationTempPickerWholeValue = datasetValue;
      } else if (type === 'decimal') {
        calibrationTempPickerDecimalValue = datasetValue;
      }
    }
    
    var displayValue = calibrationTempPickerWholeValue + (calibrationTempPickerDecimalValue / 10);
    var displayEl = document.getElementById('calibration-temp-picker-display');
    if (displayEl) {
      displayEl.textContent = displayValue.toFixed(1);
    }
  }
}

function cancelCalibrationTempPicker() {
  var modalEl = document.getElementById('calibration-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyCalibrationTempPicker() {
  var setTempEl = document.getElementById('calibration-set-temp');
  var finalValue = calibrationTempPickerWholeValue + (calibrationTempPickerDecimalValue / 10);
  
  if (setTempEl) {
    setTempEl.textContent = finalValue.toFixed(1) + '°C';
  }
  
  // Update tempValidationSetTemp and all displays
  tempValidationSetTemp = finalValue;
  updateSetTempUI(finalValue);
  
  cancelCalibrationTempPicker();
}

// Measured Temperature Picker Variables
var measuredTempPickerWholeValue = 37;
var measuredTempPickerDecimalValue = 0;

function showMeasuredTempPicker() {
  var measuredTempEl = document.getElementById('calibration-measured-temp-display');
  var currentValue = 37.0;
  
  if (measuredTempEl) {
    var tempText = measuredTempEl.textContent || '37.0°C';
    tempText = tempText.replace(/[^0-9.]/g, '');
    currentValue = parseFloat(tempText) || 37.0;
  }
  
  measuredTempPickerWholeValue = Math.floor(currentValue);
  measuredTempPickerDecimalValue = Math.round((currentValue - measuredTempPickerWholeValue) * 10);
  
  // Update display
  var displayEl = document.getElementById('measured-temp-picker-display');
  if (displayEl) {
    displayEl.textContent = currentValue.toFixed(1);
  }
  
  // Populate whole number wheel (0-50) with smooth infinite loop
  var wholeWheel = document.getElementById('measured-temp-wheel-whole');
  if (wholeWheel) {
    createSmoothInfiniteWheel(wholeWheel, 0, 50, measuredTempPickerWholeValue, function(wheel) {
      updateMeasuredTempPickerSelection('whole', wheel);
    });
  }
  
  // Populate decimal wheel (0-9) with smooth infinite loop
  var decimalWheel = document.getElementById('measured-temp-wheel-decimal');
  if (decimalWheel) {
    createSmoothInfiniteWheel(decimalWheel, 0, 9, measuredTempPickerDecimalValue, function(wheel) {
      updateMeasuredTempPickerSelection('decimal', wheel);
    });
  }
  
  // Show modal
  var modalEl = document.getElementById('measured-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function updateMeasuredTempPickerSelection(type, wheel) {
  var items = wheel.querySelectorAll('.temp-wheel-item');
  var wheelRect = wheel.getBoundingClientRect();
  var centerY = wheelRect.top + wheelRect.height / 2;
  
  var closestItem = null;
  var closestDistance = Infinity;
  var closestIndex = -1;
  
  for (var i = 0; i < items.length; i++) {
    var itemRect = items[i].getBoundingClientRect();
    var itemCenterY = itemRect.top + itemRect.height / 2;
    var distance = Math.abs(itemCenterY - centerY);
    
    if (distance < closestDistance) {
      closestDistance = distance;
      closestItem = items[i];
      closestIndex = i;
    }
  }
  
  if (closestItem) {
    for (var j = 0; j < items.length; j++) {
      items[j].classList.remove('selected');
    }
    closestItem.classList.add('selected');
    
    var datasetValue = parseInt(closestItem.dataset.value);
    if (!isNaN(datasetValue)) {
      if (type === 'whole') {
        measuredTempPickerWholeValue = datasetValue;
      } else if (type === 'decimal') {
        measuredTempPickerDecimalValue = datasetValue;
      }
    }
    
    var displayValue = measuredTempPickerWholeValue + (measuredTempPickerDecimalValue / 10);
    var displayEl = document.getElementById('measured-temp-picker-display');
    if (displayEl) {
      displayEl.textContent = displayValue.toFixed(1);
    }
  }
}

function cancelMeasuredTempPicker() {
  var modalEl = document.getElementById('measured-temp-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyMeasuredTempPicker() {
  var measuredTempEl = document.getElementById('calibration-measured-temp-display');
  var finalValue = measuredTempPickerWholeValue + (measuredTempPickerDecimalValue / 10);
  
  if (measuredTempEl) {
    measuredTempEl.textContent = finalValue.toFixed(1) + '°C';
  }
  
  // Auto-update calibration when measured temperature is set
  updateCalibrationFromMeasuredTemp(finalValue);
  
  cancelMeasuredTempPicker();
}

// Auto-update calibration when measured temperature changes
async function updateCalibrationFromMeasuredTemp(measuredTrue) {
  try {
    var setTempEl = document.getElementById('calibration-set-temp');
    var setPoint = 37.0;
    
    if (setTempEl) {
      var setTempText = setTempEl.textContent || '37.0°C';
      setTempText = setTempText.replace(/[^0-9.]/g, '');
      setPoint = parseFloat(setTempText) || 37.0;
    }
    
    var beakerNum = validationBeaker || 1;
    
    // Calculate offset: offset = measuredTrue - setPoint
    // This offset will be subtracted from raw sensor readings
    var offset = measuredTrue - setPoint;
    calibrationOffsets[beakerNum] = offset;
    
    // Save calibration offsets automatically
    await safeSave('calibrationOffsets', calibrationOffsets);
    
    // Show a subtle notification that calibration was updated
    if (typeof showToast === 'function') {
      showToast('Calibration updated: Offset ' + offset.toFixed(2) + '°C', 'success');
    }
  } catch (e) {
    console.error('Error auto-updating calibration:', e);
  }
}

// Show or hide the delete calibration button
function setCalibrationDeleteVisible(visible) {
  var btn = document.getElementById('btn-delete-calibration');
  if (btn) {
    btn.style.display = visible ? 'flex' : 'none';
  }
}

function deleteCalibration() {
  var beakerNum = validationBeaker || 1;
  calibrationOffsets[beakerNum] = 0;
  safeSave('calibrationOffsets', calibrationOffsets);
  if (typeof showModal === 'function') {
    showModal('Calibration deleted successfully');
  }
  setCalibrationDeleteVisible(false);
}

window.showRecipeTempPicker = showRecipeTempPicker;
window.cancelRecipeTempPicker = cancelRecipeTempPicker;
window.applyRecipeTempPicker = applyRecipeTempPicker;
window.showRecipeDurationPicker = showRecipeDurationPicker;
window.cancelRecipeDurationPicker = cancelRecipeDurationPicker;
window.applyRecipeDurationPicker = applyRecipeDurationPicker;
window.showValidationTempPicker = showValidationTempPicker;
window.cancelValidationTempPicker = cancelValidationTempPicker;
window.applyValidationTempPicker = applyValidationTempPicker;
window.showCalibrationTempPicker = showCalibrationTempPicker;
window.cancelCalibrationTempPicker = cancelCalibrationTempPicker;
window.applyCalibrationTempPicker = applyCalibrationTempPicker;
window.showMeasuredTempPicker = showMeasuredTempPicker;
window.cancelMeasuredTempPicker = cancelMeasuredTempPicker;
window.applyMeasuredTempPicker = applyMeasuredTempPicker;
window.loadDashboardProductNames = loadDashboardProductNames;

// ========== HELPER FUNCTIONS ==========
// Utility functions that make life easier (or at least less repetitive)
// Update set temperature display in all relevant UI elements
function updateSetTempUI(newTemp) {
  var tempStr = newTemp.toFixed(1) + '°C';
  
  // Dashboard temperature displays
  var el1 = document.getElementById('set-temp-display');
  if (el1) el1.textContent = tempStr;
  
  // Validation set temperature display
  var el2 = document.getElementById('validation-set-temp');
  if (el2) el2.textContent = tempStr;
  
  // NOTE: calibration-internal-temp-input shows live IR sensor reading, not set temp - do not update here
  
  // Temp validation set temp input
  var el4 = document.getElementById('temp-validation-set-temp-input');
  if (el4) el4.value = newTemp.toFixed(1);
  
  // NOTE: temp1 and temp2 elements should NOT be updated here
  // They show INTERNAL temperatures and are managed by updateTempsToDOM()
  // dashboard-temp-1 and dashboard-temp-2 show SET temperatures and are managed by updateDashboardTempButton()
}

// Clean temperature text by removing encoding artifacts like "Â"
function cleanTemperatureText(text) {
  if (!text) return '';
  // Remove "Â" character and any other encoding artifacts
  text = text.toString().replace(/Â/g, '').replace(/â/g, '').trim();
  return text;
}

// Set temperature display text, ensuring no encoding issues
function setTemperatureDisplay(elementId, value) {
  var el = document.getElementById(elementId);
  if (el) {
    var tempStr = parseFloat(value || 0).toFixed(1) + '°C';
    el.textContent = tempStr;
    // Double-check and clean if encoding issue persists
    setTimeout(function() {
      var currentText = el.textContent || '';
      if (currentText.indexOf('Â') > -1) {
        el.textContent = cleanTemperatureText(currentText);
      }
    }, 10);
  }
}

function initializeTemperatureValidationReal() {
  var beakerNum = validationBeaker || 1;
  
  // Load saved calibration offset for this beaker
  (async function() {
    var savedOffsets = await StorageAdapter.get('calibrationOffsets');
    if (savedOffsets) {
      calibrationOffsets[1] = savedOffsets[1] || 0;
      calibrationOffsets[2] = savedOffsets[2] || 0;
    }
  })();
  
  var setTempDisplayEl = document.getElementById('set-temp-display');
  var measuredTempDisplayEl = document.getElementById('measured-temp-display');
  var elapsedTimeEl = document.getElementById('temp-validation-elapsed');
  var passBtn = document.getElementById('temp-validation-pass-btn');
  var failBtn = document.getElementById('temp-validation-fail-btn');
  var calibrateBtn = document.getElementById('calibrate-temp-btn');
  var completeBtn = document.getElementById('complete-temp-validation-btn');
  var setTempInput = document.getElementById('temp-validation-set-temp-input');
  
  // Initialize with default value
  if (setTempInput) {
    setTempInput.value = tempValidationSetTemp.toFixed(1);
    // Validate max 55°C on blur when user types (add once)
    if (!setTempInput.dataset.maxTempHandlerAdded) {
      setTempInput.dataset.maxTempHandlerAdded = 'true';
      setTempInput.addEventListener('blur', function() {
        var val = parseFloat(this.value);
        if (!isNaN(val) && val > MAX_TEMP_C) {
          if (typeof showModal === 'function') {
            showModal('MAX temperature is 55°C. Enter the temperature in range.', function() {
              this.value = MAX_TEMP_C.toFixed(1);
            }.bind(this));
          }
        }
      });
    }
  }
  if (setTempDisplayEl) setTempDisplayEl.textContent = tempValidationSetTemp.toFixed(1);
  if (measuredTempDisplayEl) measuredTempDisplayEl.textContent = '0.0';
  
  // Hide Pass/Fail buttons initially
  if (passBtn) passBtn.style.display = 'none';
  if (failBtn) failBtn.style.display = 'none';
  if (calibrateBtn) calibrateBtn.style.display = 'none';
  if (completeBtn) completeBtn.style.display = 'none';
  
  // Reset status - waiting for user to apply set temperature, or preheating if armed
  var statusEl = document.getElementById('validation-status');
  var messageEl = document.getElementById('validation-message');
  if (statusEl) {
    statusEl.textContent = (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed) ? 'Preheating' : 'Waiting...';
    statusEl.style.color = (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed) ? '#fbbf24' : '#9ca3af';
  }
  if (messageEl) {
    messageEl.textContent = (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed)
      ? 'Temperature will update continuously. Waiting for temperature to reach set point...'
      : 'Please set and apply the target temperature';
    messageEl.style.color = (typeof tempValidationPreheatArmed !== 'undefined' && tempValidationPreheatArmed) ? '#fbbf24' : '#9ca3af';
  }
  
  // Update elapsed time display
  if (elapsedTimeEl) {
    elapsedTimeEl.textContent = '02:00';
  }
  
  // Reset validation state
  tempValidationElapsedStarted = false;
  tempValidationStartTime = null;
  
  // Clear any existing intervals
  if (tempValidationInterval) {
    clearInterval(tempValidationInterval);
    tempValidationInterval = null;
  }
  if (tempValidationTimer) {
    clearTimeout(tempValidationTimer);
    tempValidationTimer = null;
  }
}

function incrementValidationTemp() {
  var input = document.getElementById('temp-validation-set-temp-input');
  if (input) {
    var current = parseFloat(input.value) || 37.0;
    current = Math.min(MAX_TEMP_C, current + 0.1);
    input.value = current.toFixed(1);
  }
}

function decrementValidationTemp() {
  var input = document.getElementById('temp-validation-set-temp-input');
  if (input) {
    var current = parseFloat(input.value) || 37.0;
    current = Math.max(0.0, current - 0.1);
    input.value = current.toFixed(1);
  }
}

async function applyValidationSetTemp() {
  var input = document.getElementById('temp-validation-set-temp-input');
  var setTempDisplayEl = document.getElementById('set-temp-display');
  var setTempContainer = document.getElementById('temp-validation-set-temp-container');
  
  if (!input) return;
  
  var setTempValue = parseFloat(input.value) || 37.0;
  // Validate range (max 55°C)
  if (setTempValue < 0 || setTempValue > MAX_TEMP_C) {
    if (typeof showToast === 'function') {
      showToast('MAX temperature is 55°C. Enter the temperature in range.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('MAX temperature is 55°C. Enter the temperature in range.');
    }
    return;
  }
  tempValidationSetTemp = setTempValue;
  var beaker = validationBeaker || 1;
  
  // Update display
  if (setTempDisplayEl) {
    setTempDisplayEl.textContent = setTempValue.toFixed(1);
  }
  
  // Update all set temperature displays
  updateSetTempUI(setTempValue);
  
  // Hide the input container
  if (setTempContainer) {
    setTempContainer.style.display = 'none';
  }
  
  // Temperature validation must preheat ONLY the selected beaker.
  // IMPORTANT: Do not "preserve" the other heater state here, otherwise a leftover non-zero
  // HEATER_STATE value can unintentionally turn the other heater ON.
  try {
    var result;
    if (beaker === 1) {
      // Beaker 1 only: h1=setTemp, h2=0
      result = await sendPreheat(setTempValue, 0);
    } else if (beaker === 2) {
      // Beaker 2 only: h1=0, h2=setTemp
      result = await sendPreheat(0, setTempValue);
    } else {
      // Fallback (shouldn't happen): keep previous behavior
      result = await sendPreheatForBasket(beaker, setTempValue);
    }
    if (result && result.error) {
      if (typeof showToast === 'function') {
        showToast('Failed to start preheat: ' + result.error, 'error');
      } else if (typeof showModal === 'function') {
        showModal('Failed to start preheat: ' + result.error);
      }
      return;
    }
    tempValidationPreheatArmed = true;
    window.validationInProgress = true;
    updateTempValidationToggleButton();
    updateValidationStopButton();
    startTempValidationTempPoll();
    if (typeof showToast === 'function') {
      showToast('Preheat started. Temperature will update continuously. Waiting for temperature to reach set point...', 'success');
    }
  } catch (e) {
    console.error('[Temp Validation] Error applying set temp:', e);
    if (typeof showToast === 'function') {
      showToast('Error starting preheat: ' + (e.message || String(e)), 'error');
    }
  }
}

// Helper function to get basket temperature from temps object (Basket 1=IR1, Basket 2=IR2)
function getBasketTemp(temps, beakerNum) {
  if (!temps || typeof temps !== 'object') return null;
  
  if (beakerNum === 1) {
    if (typeof temps.IR1 === 'number' && !isNaN(temps.IR1)) return temps.IR1;
    if (typeof temps.basket1 === 'number' && !isNaN(temps.basket1)) return temps.basket1;
    if (typeof temps.temp1 === 'number' && !isNaN(temps.temp1)) return temps.temp1;
  } else if (beakerNum === 2) {
    if (typeof temps.IR2 === 'number' && !isNaN(temps.IR2)) return temps.IR2;
    if (typeof temps.basket2 === 'number' && !isNaN(temps.basket2)) return temps.basket2;
    if (typeof temps.temp2 === 'number' && !isNaN(temps.temp2)) return temps.temp2;
  }
  
  return null;
}

// Called when TR popup is OK'd - starts 2-minute holding phase
function startHoldingPhase() {
  if (typeof startTempValidationTempPoll === 'function') startTempValidationTempPoll();
  var setTempValue = tempValidationSetTemp || 37.0;
  var beakerNum = validationBeaker || 1;
  var elapsedTimeEl = document.getElementById('temp-validation-elapsed');
  var statusEl = document.getElementById('validation-status');
  var messageEl = document.getElementById('validation-message');
  var deviationEl = document.getElementById('deviation-display');
  var measuredTempDisplayEl = document.getElementById('measured-temp-display');
  var calibrateBtn = document.getElementById('calibrate-temp-btn');
  var buttonsContainer = document.getElementById('temp-validation-buttons');
  
  tempValidationRunning = true;
  tempValidationElapsedStarted = true;
  tempValidationStartTime = Date.now();
  lastTempValidationMaxDeviation = 0;
  lastTempValidationMinTemp = null;
  lastTempValidationMaxTemp = null;
  window.validationInProgress = true;
  
  if (statusEl) {
    statusEl.textContent = 'Holding';
    statusEl.style.color = '#3b82f6';
  }
  if (messageEl) {
    messageEl.textContent = 'Holding temperature for 2 minutes. Max deviation will be calculated.';
    messageEl.style.color = '#3b82f6';
  }
  if (calibrateBtn) calibrateBtn.style.display = 'none';
  if (buttonsContainer) buttonsContainer.style.display = 'none';
  
  if (tempValidationInterval) {
    clearInterval(tempValidationInterval);
    tempValidationInterval = null;
  }
  if (tempValidationTimer) {
    clearTimeout(tempValidationTimer);
    tempValidationTimer = null;
  }
  
  updateTempValidationToggleButton();
  updateValidationStopButton();
  
  var durSec = typeof VALIDATION_HOLD_DURATION_SEC !== 'undefined' ? VALIDATION_HOLD_DURATION_SEC : 120;
  var lim = typeof VALIDATION_DEVIATION_LIMIT !== 'undefined' ? VALIDATION_DEVIATION_LIMIT : 0.5;
  
  tempValidationInterval = setInterval(function() {
    (async function() {
      try {
        var temps = await readValidationTemps();
        if (!temps || typeof temps !== 'object') return;
        var rawTemp = getBasketTemp(temps, beakerNum);
        if (rawTemp === null || isNaN(rawTemp)) return;
        var currentTemp = Number(rawTemp);
        // Track min/max raw temps (no calibration) for report
        if (lastTempValidationMinTemp === null || currentTemp < lastTempValidationMinTemp) lastTempValidationMinTemp = currentTemp;
        if (lastTempValidationMaxTemp === null || currentTemp > lastTempValidationMaxTemp) lastTempValidationMaxTemp = currentTemp;
        // Max deviation = half range (max - min) / 2
        var maxDev = (lastTempValidationMinTemp !== null && lastTempValidationMaxTemp !== null)
          ? (lastTempValidationMaxTemp - lastTempValidationMinTemp) / 2
          : 0;
        if (maxDev > lastTempValidationMaxDeviation) lastTempValidationMaxDeviation = maxDev;
        
        if (measuredTempDisplayEl) measuredTempDisplayEl.textContent = currentTemp.toFixed(1);
        if (deviationEl) deviationEl.textContent = '\u00B1' + lastTempValidationMaxDeviation.toFixed(2) + '\u00B0C';
        
        var elapsedSec = Math.floor((Date.now() - tempValidationStartTime) / 1000);
        var remaining = Math.max(0, durSec - elapsedSec);
        if (elapsedTimeEl) {
          var m = Math.floor(remaining / 60);
          var s = remaining % 60;
          elapsedTimeEl.textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        }
        
        if (elapsedSec >= durSec) {
          clearInterval(tempValidationInterval);
          tempValidationInterval = null;
          tempValidationRunning = false;
          if (tempValidationTimer) {
            clearTimeout(tempValidationTimer);
            tempValidationTimer = null;
          }
          
          var withinSpec = lastTempValidationMaxDeviation <= lim;
          if (statusEl) {
            statusEl.textContent = 'Complete';
            statusEl.style.color = '#9ca3af';
          }
          if (messageEl) {
            messageEl.textContent = 'Max deviation: \u00B1' + lastTempValidationMaxDeviation.toFixed(2) + '\u00B0C (Limit \u00B1' + lim.toFixed(1) + '\u00B0C). ' + (withinSpec ? 'PASS' : 'FAIL');
            messageEl.style.color = withinSpec ? '#10b981' : '#ef4444';
          }
          
          if (withinSpec) {
            handleTempValidationPass();
          } else {
            handleTempValidationFail();
          }
        }
      } catch (e) {
        console.error('[Temp Validation] Error in holding loop:', e);
      }
    })();
  }, 1000);
  
  tempValidationTimer = setTimeout(function() {
    if (tempValidationInterval) {
      clearInterval(tempValidationInterval);
      tempValidationInterval = null;
    }
  }, (durSec + 15) * 1000);
}

window.startHoldingPhase = startHoldingPhase;

async function startTemperatureValidation() {
  if (typeof startHoldingPhase === 'function') startHoldingPhase();
}

// G: Validation temperature reading from live temps (SSE-pushed, no fetch)
async function readValidationTemps() {
  if (window.latestTemps && Object.keys(window.latestTemps).length > 0) {
    return window.latestTemps;
  }
  // Fallback to HardwareAdapter.readTemps (which returns window.latestTemps)
  if (window.HardwareAdapter && typeof window.HardwareAdapter.readTemps === 'function') {
    return await window.HardwareAdapter.readTemps();
  }
  return {};
}

function checkTemperatureValidationReal() {
  var setTempDisplayEl = document.getElementById('set-temp-display');
  var measuredTempDisplayEl = document.getElementById('measured-temp-display');
  if (!setTempDisplayEl || !measuredTempDisplayEl) return;
  
  var setTempValue = parseFloat(setTempDisplayEl.textContent);
  var measuredTempValue = parseFloat(measuredTempDisplayEl.textContent);
  
  var deviation = Math.abs(measuredTempValue - setTempValue);
  var deviationEl = document.getElementById('deviation-display');
  if (deviationEl) deviationEl.textContent = '±' + deviation.toFixed(2) + '°C';
  
  var withinTolerance = deviation <= 0.5;
  var statusEl = document.getElementById('validation-status');
  var resultCard = document.getElementById('validation-result-card');
  var messageEl = document.getElementById('validation-message');
  var calibrateBtn = document.getElementById('calibrate-temp-btn');
  var completeBtn = document.getElementById('complete-temp-validation-btn');
    
    if (withinTolerance) {
    if (statusEl) {
        statusEl.textContent = 'PASS';
        statusEl.style.color = '#10b981';
    }
    if (resultCard) {
        resultCard.className = 'bg-green-600 p-8 rounded-2xl border-4 border-green-400 mb-4 text-center';
        resultCard.style.boxShadow = '0 0 30px rgba(16, 185, 129, 0.5)';
    }
    if (messageEl) {
        messageEl.textContent = 'Validation Successful';
        messageEl.style.color = 'white';
    }
    if (calibrateBtn) calibrateBtn.style.display = 'none';
    if (completeBtn) completeBtn.style.display = 'flex';
    } else {
    if (statusEl) {
        statusEl.textContent = 'FAIL';
        statusEl.style.color = '#ef4444';
    }
    if (resultCard) {
        resultCard.className = 'bg-red-600 p-8 rounded-2xl border-4 border-red-400 mb-4 text-center';
        resultCard.style.boxShadow = '0 0 30px rgba(239, 68, 68, 0.5)';
    }
    if (messageEl) {
      messageEl.textContent = 'Calibration Required';
        messageEl.style.color = 'white';
    }
    if (calibrateBtn) calibrateBtn.style.display = 'flex';
    if (completeBtn) completeBtn.style.display = 'none';
  }
}

function updateBasketStates() {
  var basket1Wrapper = document.getElementById('basket1-wrapper');
  var basket2Wrapper = document.getElementById('basket2-wrapper');
  var heater1 = document.getElementById('heater1');
  var heater2 = document.getElementById('heater2');
  var start1 = document.getElementById('start1');
  var start2 = document.getElementById('start2');
  var container1 = document.getElementById('basket1-container');
  var container2 = document.getElementById('basket2-container');
  
  // Timer/Manual buttons
  var timerBtn1 = document.getElementById('timer-btn-1');
  var manualBtn1 = document.getElementById('manual-btn-1');
  var timerBtn2 = document.getElementById('timer-btn-2');
  var manualBtn2 = document.getElementById('manual-btn-2');
  
  // External probes
  var probe1 = document.getElementById('probe-1');
  var probe2 = document.getElementById('probe-2');
  
  // Mode button (Recipe Management)
  var modeWrapper = document.getElementById('dashboard-mode-wrapper');
  
  if (basket1Wrapper) basket1Wrapper.classList.remove('basket-inactive');
  if (basket2Wrapper) basket2Wrapper.classList.remove('basket-inactive');
  
  if (container1) {
    var ring1 = container1.querySelector('.basket-active-ring');
    if (ring1 && !testRunning[1]) ring1.remove();
  }
  if (container2) {
    var ring2 = container2.querySelector('.basket-active-ring');
    if (ring2 && !testRunning[2]) ring2.remove();
  }
  
  var beaker1Configured = configuredBeakers[1];
  var beaker2Configured = configuredBeakers[2];
  
  if (!beaker1Configured && !beaker2Configured) {
    if (heater1) { heater1.disabled = true; heater1.style.opacity = '0.5'; }
    if (start1) { start1.disabled = true; start1.style.opacity = '0.5'; }
    if (heater2) { heater2.disabled = true; heater2.style.opacity = '0.5'; }
    if (start2) { start2.disabled = true; start2.style.opacity = '0.5'; }
    // Hide timer/manual buttons and probes when no baskets configured
    if (timerBtn1) timerBtn1.style.display = 'none';
    if (manualBtn1) manualBtn1.style.display = 'none';
    if (timerBtn2) timerBtn2.style.display = 'none';
    if (manualBtn2) manualBtn2.style.display = 'none';
    if (probe1) probe1.style.display = 'none';
    if (probe2) probe2.style.display = 'none';
    // Hide mode button when no baskets configured
    if (modeWrapper) {
      modeWrapper.style.display = 'none';
      modeWrapper.style.visibility = 'hidden';
    }
    return;
  }
  
  if (beaker1Configured && !beaker2Configured) {
    // Only basket 1 configured - hide basket 2 and its controls
    if (basket2Wrapper) {
      basket2Wrapper.style.display = 'none';
      basket2Wrapper.style.visibility = 'hidden';
    }
    if (basket1Wrapper) {
      basket1Wrapper.style.display = 'flex';
      basket1Wrapper.style.visibility = 'visible';
    }
    if (heater1) { heater1.disabled = false; heater1.style.opacity = '1'; }
    if (start1) { start1.disabled = false; start1.style.opacity = '1'; }
    // Disable basket 2 controls
    if (heater2) { heater2.disabled = true; heater2.style.opacity = '0.5'; }
    if (start2) { start2.disabled = true; start2.style.opacity = '0.5'; }
    // Show basket 1 controls, hide basket 2 controls
    if (timerBtn1) {
      timerBtn1.style.display = 'flex';
      timerBtn1.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[1]) {
        timerBtn1.style.opacity = '0.5';
        timerBtn1.style.pointerEvents = 'none';
        timerBtn1.style.cursor = 'not-allowed';
      } else {
        timerBtn1.style.opacity = '1';
        timerBtn1.style.pointerEvents = 'auto';
        timerBtn1.style.cursor = 'pointer';
      }
    }
    if (manualBtn1) {
      manualBtn1.style.display = 'flex';
      manualBtn1.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[1]) {
        manualBtn1.style.opacity = '0.5';
        manualBtn1.style.pointerEvents = 'none';
        manualBtn1.style.cursor = 'not-allowed';
      } else {
        manualBtn1.style.opacity = '1';
        manualBtn1.style.pointerEvents = 'auto';
        manualBtn1.style.cursor = 'pointer';
      }
    }
    if (timerBtn2) {
      timerBtn2.style.display = 'none';
      timerBtn2.style.visibility = 'hidden';
    }
    if (manualBtn2) {
      manualBtn2.style.display = 'none';
      manualBtn2.style.visibility = 'hidden';
    }
    if (probe1) {
      probe1.style.display = 'block';
      probe1.style.visibility = 'visible';
    }
    if (probe2) {
      probe2.style.display = 'none';
      probe2.style.visibility = 'hidden';
    }
    // Hide basket 2 container and timer display
    if (container2) {
      container2.style.display = 'none';
      container2.style.visibility = 'hidden';
    }
    // Show basket 1 container and timer display
    if (container1) {
      container1.style.display = 'block';
      container1.style.visibility = 'visible';
    }
    var timer2El = document.getElementById('timer2');
    if (timer2El) {
      timer2El.style.display = 'none';
      timer2El.style.visibility = 'hidden';
    }
    var timer1El = document.getElementById('timer1');
    if (timer1El) {
      timer1El.style.display = 'block';
      timer1El.style.visibility = 'visible';
    }
    // Show mode button when at least one basket is configured
    if (modeWrapper) {
      modeWrapper.style.display = 'flex';
      modeWrapper.style.visibility = 'visible';
    }
  } else if (beaker2Configured && !beaker1Configured) {
    // Only basket 2 configured - hide basket 1 and its controls
    if (basket1Wrapper) {
      basket1Wrapper.style.display = 'none';
      basket1Wrapper.style.visibility = 'hidden';
    }
    if (basket2Wrapper) {
      basket2Wrapper.style.display = 'flex';
      basket2Wrapper.style.visibility = 'visible';
    }
    if (heater2) { heater2.disabled = false; heater2.style.opacity = '1'; }
    if (start2) { start2.disabled = false; start2.style.opacity = '1'; }
    // Disable basket 1 controls
    if (heater1) { heater1.disabled = true; heater1.style.opacity = '0.5'; }
    if (start1) { start1.disabled = true; start1.style.opacity = '0.5'; }
    // Hide basket 1 controls, show basket 2 controls
    if (timerBtn1) {
      timerBtn1.style.display = 'none';
      timerBtn1.style.visibility = 'hidden';
    }
    if (manualBtn1) {
      manualBtn1.style.display = 'none';
      manualBtn1.style.visibility = 'hidden';
    }
    if (timerBtn2) {
      timerBtn2.style.display = 'flex';
      timerBtn2.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[2]) {
        timerBtn2.style.opacity = '0.5';
        timerBtn2.style.pointerEvents = 'none';
        timerBtn2.style.cursor = 'not-allowed';
      } else {
        timerBtn2.style.opacity = '1';
        timerBtn2.style.pointerEvents = 'auto';
        timerBtn2.style.cursor = 'pointer';
      }
    }
    if (manualBtn2) {
      manualBtn2.style.display = 'flex';
      manualBtn2.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[2]) {
        manualBtn2.style.opacity = '0.5';
        manualBtn2.style.pointerEvents = 'none';
        manualBtn2.style.cursor = 'not-allowed';
      } else {
        manualBtn2.style.opacity = '1';
        manualBtn2.style.pointerEvents = 'auto';
        manualBtn2.style.cursor = 'pointer';
      }
    }
    if (probe1) {
      probe1.style.display = 'none';
      probe1.style.visibility = 'hidden';
    }
    if (probe2) {
      probe2.style.display = 'block';
      probe2.style.visibility = 'visible';
    }
    // Hide basket 1 container and timer display
    if (container1) {
      container1.style.display = 'none';
      container1.style.visibility = 'hidden';
    }
    // Show basket 2 container and timer display
    if (container2) {
      container2.style.display = 'block';
      container2.style.visibility = 'visible';
    }
    var timer1El = document.getElementById('timer1');
    if (timer1El) {
      timer1El.style.display = 'none';
      timer1El.style.visibility = 'hidden';
    }
    var timer2El = document.getElementById('timer2');
    if (timer2El) {
      timer2El.style.display = 'block';
      timer2El.style.visibility = 'visible';
    }
    // Show mode button when at least one basket is configured
    if (modeWrapper) {
      modeWrapper.style.display = 'flex';
      modeWrapper.style.visibility = 'visible';
    }
  } else if (beaker1Configured && beaker2Configured) {
    // Both baskets configured - show all controls
    if (basket1Wrapper) {
      basket1Wrapper.style.display = 'flex';
      basket1Wrapper.style.visibility = 'visible';
    }
    if (basket2Wrapper) {
      basket2Wrapper.style.display = 'flex';
      basket2Wrapper.style.visibility = 'visible';
    }
    if (heater1) { heater1.disabled = false; heater1.style.opacity = '1'; }
    if (start1) { start1.disabled = false; start1.style.opacity = '1'; }
    if (heater2) { heater2.disabled = false; heater2.style.opacity = '1'; }
    if (start2) { start2.disabled = false; start2.style.opacity = '1'; }
    // Show all timer/manual buttons and probes
    if (timerBtn1) {
      timerBtn1.style.display = 'flex';
      timerBtn1.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[1]) {
        timerBtn1.style.opacity = '0.5';
        timerBtn1.style.pointerEvents = 'none';
        timerBtn1.style.cursor = 'not-allowed';
      } else {
        timerBtn1.style.opacity = '1';
        timerBtn1.style.pointerEvents = 'auto';
        timerBtn1.style.cursor = 'pointer';
      }
    }
    if (manualBtn1) {
      manualBtn1.style.display = 'flex';
      manualBtn1.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[1]) {
        manualBtn1.style.opacity = '0.5';
        manualBtn1.style.pointerEvents = 'none';
        manualBtn1.style.cursor = 'not-allowed';
      } else {
        manualBtn1.style.opacity = '1';
        manualBtn1.style.pointerEvents = 'auto';
        manualBtn1.style.cursor = 'pointer';
      }
    }
    if (timerBtn2) {
      timerBtn2.style.display = 'flex';
      timerBtn2.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[2]) {
        timerBtn2.style.opacity = '0.5';
        timerBtn2.style.pointerEvents = 'none';
        timerBtn2.style.cursor = 'not-allowed';
      } else {
        timerBtn2.style.opacity = '1';
        timerBtn2.style.pointerEvents = 'auto';
        timerBtn2.style.cursor = 'pointer';
      }
    }
    if (manualBtn2) {
      manualBtn2.style.display = 'flex';
      manualBtn2.style.visibility = 'visible';
      // Disable/gray out if test is running
      if (testRunning[2]) {
        manualBtn2.style.opacity = '0.5';
        manualBtn2.style.pointerEvents = 'none';
        manualBtn2.style.cursor = 'not-allowed';
      } else {
        manualBtn2.style.opacity = '1';
        manualBtn2.style.pointerEvents = 'auto';
        manualBtn2.style.cursor = 'pointer';
      }
    }
    if (probe1) {
      probe1.style.display = 'block';
      probe1.style.visibility = 'visible';
    }
    if (probe2) {
      probe2.style.display = 'block';
      probe2.style.visibility = 'visible';
    }
    // Show all containers and timers
    if (container1) {
      container1.style.display = 'block';
      container1.style.visibility = 'visible';
    }
    if (container2) {
      container2.style.display = 'block';
      container2.style.visibility = 'visible';
    }
    var timer1El = document.getElementById('timer1');
    var timer2El = document.getElementById('timer2');
    if (timer1El) {
      timer1El.style.display = 'block';
      timer1El.style.visibility = 'visible';
    }
    if (timer2El) {
      timer2El.style.display = 'block';
      timer2El.style.visibility = 'visible';
    }
    // Show mode button when both baskets are configured
    if (modeWrapper) {
      modeWrapper.style.display = 'flex';
      modeWrapper.style.visibility = 'visible';
    }
  }
  
  if (testRunning[1] && container1 && !container1.querySelector('.basket-active-ring')) {
    var ring = document.createElement('div');
    ring.className = 'basket-active-ring';
    container1.appendChild(ring);
  }
  if (testRunning[2] && container2 && !container2.querySelector('.basket-active-ring')) {
    var ring = document.createElement('div');
    ring.className = 'basket-active-ring';
    container2.appendChild(ring);
  }
}

function updateBasketHoles(basketId, holeCount) {
  var container = document.getElementById('basket' + basketId + '-container');
  if (!container) return;
  
  var existingHoles = container.querySelectorAll('.basket-hole');
  for (var i = 0; i < existingHoles.length; i++) {
    existingHoles[i].remove();
  }
  
  if (holeCount === 1) {
    // Single hole - no visual holes
  } else if (holeCount === 3) {
    var radius = 33;
    var positions = [
      {top: (50 - radius) + '%', left: '50%', num: 1},
      {top: (50 + radius * 0.5) + '%', left: (50 + radius * 0.866) + '%', num: 2},
      {top: (50 + radius * 0.5) + '%', left: (50 - radius * 0.866) + '%', num: 3}
    ];
    for (var j = 0; j < positions.length; j++) {
      var pos = positions[j];
      var hole = document.createElement('div');
      hole.className = 'basket-hole';
      hole.textContent = pos.num;
      hole.style.cssText = 'top:' + pos.top + ';left:' + pos.left + ';transform:translate(-50%,-50%);display:none;';
      hole.onclick = function(e, bid, num) {
        return function(ev) {
          if (ev.stopPropagation) ev.stopPropagation();
          if (typeof toggleHole === 'function') {
            toggleHole(bid, num);
          }
        };
      }(null, basketId, pos.num);
      container.appendChild(hole);
    }
  } else if (holeCount === 6) {
    var radius = 31;
    var centerX = 50;
    var centerY = 50;
    var positions = [
      {top: (centerY - radius) + '%', left: centerX + '%', num: 1},
      {top: (centerY - radius * 0.5) + '%', left: (centerX + radius * 0.866) + '%', num: 2},
      {top: (centerY + radius * 0.5) + '%', left: (centerX + radius * 0.866) + '%', num: 3},
      {top: (centerY + radius) + '%', left: centerX + '%', num: 4},
      {top: (centerY + radius * 0.5) + '%', left: (centerX - radius * 0.866) + '%', num: 5},
      {top: (centerY - radius * 0.5) + '%', left: (centerX - radius * 0.866) + '%', num: 6}
    ];
    for (var k = 0; k < positions.length; k++) {
      var pos = positions[k];
      var hole = document.createElement('div');
      hole.className = 'basket-hole';
      hole.textContent = pos.num;
      hole.style.cssText = 'top:' + pos.top + ';left:' + pos.left + ';transform:translate(-50%,-50%);display:none;';
      hole.onclick = function(e, bid, num) {
        return function(ev) {
          if (ev.stopPropagation) ev.stopPropagation();
          if (typeof toggleHole === 'function') {
            toggleHole(bid, num);
          }
        };
      }(null, basketId, pos.num);
      container.appendChild(hole);
    }
  }
  
  basketHoles[basketId] = {};
  if (typeof updateBasketHoleSelection === 'function') {
    updateBasketHoleSelection(basketId);
  }
}

function updateBasketHoleSelection(basketId) {
  var container = document.getElementById('basket' + basketId + '-container');
  if (!container) return;
  
  var holes = container.querySelectorAll('.basket-hole');
  
  if (configuredBeakers[basketId]) {
    for (var i = 0; i < holes.length; i++) {
      var holeNumber = i + 1;
      if (holeNumber <= basketConfig) {
        holes[i].style.display = 'flex';
        } else {
        holes[i].style.display = 'none';
      }
        }
    } else {
    for (var j = 0; j < holes.length; j++) {
      holes[j].style.display = 'none';
    }
  }
}

function toggleHole(basket, hole) {
  if (!testRunning[basket]) return;
  
  // Prevent hole tapping in timer mode during test (only allow in manual mode)
  var mode = basketModes[basket] || 'timer';
  if (mode === 'timer') {
    // In timer mode, holes should not be tappable during test
    console.log('[toggleHole] Hole tapping disabled in timer mode for basket', basket);
    return;
  }
  
  var container = document.getElementById('basket' + basket + '-container');
  if (!container) return;
  
  var holes = container.querySelectorAll('.basket-hole');
  var holeEl = null;
  for (var i = 0; i < holes.length; i++) {
    if (holes[i].textContent == hole) {
      holeEl = holes[i];
      break;
    }
  }
  
  if (holeEl) {
    if (holeEl.style.display === 'none') {
      holeEl.style.display = 'flex';
    }
    
    if (!holeEl.classList.contains('completed')) {
      holeEl.classList.add('completed');
      basketHoles[basket][hole] = true;
      var completionTime = Date.now();
      holeCompletionTimes[basket][hole] = completionTime;
      
      // Track vessel completion time (for report) - store as duration HH:MM:SS
      var vesselIndex = hole; // Use hole number as vessel index
      if (!currentRunVesselTimes[vesselIndex] && testStartTime[basket]) {
        const finish = Date.now();
        const durationMs = finish - (testStartTime[basket] || finish);
        const hh = Math.floor(durationMs / 3600000);
        const mm = Math.floor((durationMs % 3600000) / 60000);
        const ss = Math.floor((durationMs % 60000) / 1000);
        currentRunVesselTimes[vesselIndex] = String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
      }
      
      if (typeof checkAllHolesComplete === 'function') {
        checkAllHolesComplete(basket);
      }
    }
  }
}

function checkAllHolesComplete(basketId) {
  var container = document.getElementById('basket' + basketId + '-container');
  if (!container) return;
  
  // Handle single tube configuration (basketConfig === 1)
  if (basketConfig === 1) {
    if (basketHoles[basketId] && basketHoles[basketId][1]) {
      // Single tube is complete
      var btn = document.getElementById('start' + basketId);
      if (btn && testRunning[basketId]) {
        // Send STOP command to ESP32 when single tube completes - use per-basket stop
        console.log('[checkAllHolesComplete] Single tube completed for basket', basketId, '- sending STOP command for basket', basketId, 'only');
        if (typeof sendStopForBasket === 'function') {
          sendStopForBasket(basketId).then(function(result) {
            if (result && result.error) {
              console.error('[checkAllHolesComplete] Failed to send STOP command for basket', basketId, ':', result.error);
            } else {
              console.log('[checkAllHolesComplete] STOP command sent successfully for basket', basketId, 'only');
            }
          }).catch(function(e) {
            console.error('[checkAllHolesComplete] Error sending STOP command for basket', basketId, ':', e);
          });
        }
        
        if (timers[basketId].interval) {
          clearInterval(timers[basketId].interval);
          timers[basketId].interval = null;
        }
        if (timers[basketId].tempPollInterval) {
          clearInterval(timers[basketId].tempPollInterval);
          timers[basketId].tempPollInterval = null;
        }
        btn.textContent = 'Start';
        btn.style.background = '#10b981';
        timers[basketId].running = false;
        testRunning[basketId] = false;
        
        // Ensure preheat/heater state is fully cleared when test completes for this basket
        if (window.preheatInProgress) {
          window.preheatInProgress[basketId] = false;
        }
        if (typeof heaterOn !== 'undefined') {
          heaterOn[basketId] = false;
        }
        if (typeof stopPreheatTempPolling === 'function') {
          stopPreheatTempPolling(basketId);
        }
        if (typeof preheatMonitor !== 'undefined' && preheatMonitor && preheatMonitor.stopMonitoring) {
          preheatMonitor.stopMonitoring(basketId);
        }
        if (typeof updateHeaterControlUI === 'function') {
          updateHeaterControlUI();
        }
        
        // Update mode button UI to re-enable mode switching
        if (typeof updateModeButtonsUI === 'function') {
          updateModeButtonsUI(basketId);
        }
        
        // DO NOT clear hole data here - saveCompletedTestReport needs it
        // basketHoles[basketId] = {};
        // holeCompletionTimes[basketId] = {};
        
        // Remove active ring
        var ring = container.querySelector('.basket-active-ring');
        if (ring) ring.remove();
        
        // IMPORTANT: Do NOT reset configuredBeakers - keep basket enabled after test
        if (typeof updateBasketStates === 'function') {
          updateBasketStates();
        }
        if (typeof saveCompletedTestReport === 'function') {
          try {
            saveCompletedTestReport(basketId, { aborted: false });
          } catch(e) {
            console.error(e);
          }
        }
        if (typeof showModal === 'function') {
          showModal('Basket ' + basketId + ' test completed - single tube finished!');
        }
      }
    }
        return;
  }
  
  // Handle multi-tube configurations - use basketConfig and basketHoles for reliable check (quick test without recipe)
  var expectedHoles = (basketConfig === 3 || basketConfig === 6) ? basketConfig : 0;
  if (expectedHoles > 0) {
    var completedCount = 0;
    for (var h = 1; h <= expectedHoles; h++) {
      if (basketHoles[basketId] && basketHoles[basketId][h]) completedCount++;
    }
    if (completedCount === expectedHoles) {
      var btn = document.getElementById('start' + basketId);
      if (btn && testRunning[basketId]) {
        // Send STOP command to ESP32 when all tubes complete - use per-basket stop
        console.log('[checkAllHolesComplete] All tubes completed for basket', basketId, '- sending STOP command for basket', basketId, 'only');
        if (typeof sendStopForBasket === 'function') {
          sendStopForBasket(basketId).then(function(result) {
            if (result && result.error) {
              console.error('[checkAllHolesComplete] Failed to send STOP command for basket', basketId, ':', result.error);
            } else {
              console.log('[checkAllHolesComplete] STOP command sent successfully for basket', basketId, 'only');
            }
          }).catch(function(e) {
            console.error('[checkAllHolesComplete] Error sending STOP command for basket', basketId, ':', e);
          });
        }
        
        // Guard against missing timers (e.g. quick-test path)
        if (timers[basketId]) {
          if (timers[basketId].interval) {
            clearInterval(timers[basketId].interval);
            timers[basketId].interval = null;
          }
          if (timers[basketId].tempPollInterval) {
            clearInterval(timers[basketId].tempPollInterval);
            timers[basketId].tempPollInterval = null;
          }
        }
        if (timers[basketId]) timers[basketId].running = false;
        btn.textContent = 'Start';
        btn.style.background = '#10b981';
        testRunning[basketId] = false;
      
      // Ensure preheat/heater state is fully cleared when test completes for this basket
      if (window.preheatInProgress) {
        window.preheatInProgress[basketId] = false;
      }
      if (typeof heaterOn !== 'undefined') {
        heaterOn[basketId] = false;
      }
      if (typeof stopPreheatTempPolling === 'function') {
        stopPreheatTempPolling(basketId);
      }
      if (typeof preheatMonitor !== 'undefined' && preheatMonitor && preheatMonitor.stopMonitoring) {
        preheatMonitor.stopMonitoring(basketId);
      }
      if (typeof updateHeaterControlUI === 'function') {
        updateHeaterControlUI();
      }
      
      // Update mode button UI to re-enable mode switching
      if (typeof updateModeButtonsUI === 'function') {
        updateModeButtonsUI(basketId);
      }
      
      // Reset holes to hollow state (remove completed class, but keep them visible)
      var holes = container.querySelectorAll('.basket-hole');
      for (var i = 0; i < holes.length; i++) {
        holes[i].classList.remove('completed');
        // Keep holes visible - ensure they remain visible after test
        if (configuredBeakers[basketId]) {
          var holeNumber = i + 1;
          if (holeNumber <= basketConfig) {
            holes[i].style.display = 'flex';
          }
        }
      }
      
      // DO NOT clear hole data here - saveCompletedTestReport needs it
      // basketHoles[basketId] = {};
      // holeCompletionTimes[basketId] = {};
      
      // Remove active ring
      var ring = container.querySelector('.basket-active-ring');
      if (ring) ring.remove();
      
      // Update hole visibility based on configuration (but don't hide configured holes)
      if (typeof updateBasketHoleSelection === 'function') {
        updateBasketHoleSelection(basketId);
      }
      
      // IMPORTANT: Do NOT reset configuredBeakers - keep basket enabled after test
      if (typeof updateBasketStates === 'function') {
        updateBasketStates();
      }
      if (typeof saveCompletedTestReport === 'function') {
        try {
          saveCompletedTestReport(basketId, { aborted: false });
        } catch(e) {
          console.error(e);
        }
      }
      if (typeof showModal === 'function') {
        showModal('Basket ' + basketId + ' test completed - all tubes finished!');
      }
      }
    }
  }
}

// ========== REPORT SAVING SYSTEM ==========
// Save test reports to storage (because we need to keep records, apparently)
async function saveReportRecord(report) {
  try {
    var reports = await StorageAdapter.get('reports') || [];
    reports.push(report);
    await safeSave('reports', reports);
    return true;
  } catch (e) {
    console.error('Error saving report:', e);
    return false;
  }
}

async function saveCompletedTestReport(basketId, options) {
  try {
    var product1 = basketProducts[1] || 'Unknown Product';
    var product2 = basketProducts[2] || null;
    var batch1 = basketBatches[1] || 'N/A';
    var batch2 = basketBatches[2] || null;
    var mode = basketModes[basketId] || 'timer';
    var temperature = setTemp[basketId] || 37.0;
    
    var reportName = 'Test Report - ' + (basketId === 1 ? product1 : (product2 || product1)) + ' - Basket ' + basketId;
    if (basketId === 1 && batch1) reportName += ' B:' + batch1;
    if (basketId === 2 && batch2) reportName += ' B:' + batch2;
    
    // Save hole completion times and start time for this basket
    var basketHoleTimes = {};
    var startTime = testStartTime[basketId] || Date.now();
    var stopTime = Date.now();
    
    // Calculate actual test duration (from start to stop)
    var actualDuration = Math.floor((stopTime - startTime) / 1000);
    
    // For manual mode: setDuration is null, use actual duration
    // For timer mode: setDuration is the recipe duration, actual duration is the timer value
    var setDuration = null;
    var duration = 0;
    
    if (mode === 'manual') {
      // Manual mode: no set duration, use actual test duration
      setDuration = null;
      duration = actualDuration;
    } else {
      // Timer mode: use recipe duration as set duration, timer secs as actual duration
      var recipeDuration = basketDurations[basketId];
      if (recipeDuration !== null && recipeDuration !== undefined) {
        setDuration = Math.floor(recipeDuration * 60); // Convert minutes to seconds
      }
      duration = timers[basketId] && timers[basketId].secs ? timers[basketId].secs : actualDuration;
    }
    
    if (holeCompletionTimes[basketId]) {
      for (var hole in holeCompletionTimes[basketId]) {
        if (holeCompletionTimes[basketId].hasOwnProperty(hole)) {
          var completionTime = holeCompletionTimes[basketId][hole];
          if (completionTime && !isNaN(completionTime)) {
            var elapsedSeconds = Math.floor((completionTime - startTime) / 1000);
            // Save with both string and number keys to ensure lookup works
            var holeKey = parseInt(hole) || hole;
            basketHoleTimes[String(holeKey)] = elapsedSeconds;
            basketHoleTimes[Number(holeKey)] = elapsedSeconds;
            basketHoleTimes[hole] = elapsedSeconds; // Keep original key format
          }
        }
      }
    }
    
    // Create a copy of currentRunVesselTimes for the report (already in HH:MM:SS format)
    var vesselTimesCopy = {};
    if (typeof currentRunVesselTimes === 'object' && currentRunVesselTimes !== null) {
      for (var vKey in currentRunVesselTimes) {
        if (Object.prototype.hasOwnProperty.call(currentRunVesselTimes, vKey)) {
          // If it's already a duration string (HH:MM:SS), use it; otherwise convert
          var vTime = currentRunVesselTimes[vKey];
          if (typeof vTime === 'string' && vTime.match(/^\d{2}:\d{2}:\d{2}$/)) {
            vesselTimesCopy[vKey] = vTime; // Already in duration format
          } else if (typeof vTime === 'string') {
            // Try to parse ISO string and convert to duration
            var vDate = new Date(vTime);
            if (!isNaN(vDate.getTime()) && startTime) {
              const durationMs = vDate.getTime() - (typeof startTime === 'number' ? startTime : new Date(startTime).getTime());
              const hh = Math.floor(durationMs / 3600000);
              const mm = Math.floor((durationMs % 3600000) / 60000);
              const ss = Math.floor((durationMs % 60000) / 1000);
              vesselTimesCopy[vKey] = String(hh).padStart(2,'0') + ':' + String(mm).padStart(2,'0') + ':' + String(ss).padStart(2,'0');
            } else {
              vesselTimesCopy[vKey] = vTime; // Fallback
            }
          } else {
            vesselTimesCopy[vKey] = vTime; // Fallback
          }
        }
      }
    }
    
    // Debug: log what's being saved
    console.log('Saving test report - vessel completion data:', {
      basketId: basketId,
      holeCompletionTimes: holeCompletionTimes[basketId],
      basketHoleTimes: basketHoleTimes,
      basketConfig: basketConfig,
      vesselTimesCopy: vesselTimesCopy
    });
    
    // Compute min/max temperatures from recorded data
    var tempsOnly = [];
    if (recordedTemps[basketId] && recordedTemps[basketId].length > 0) {
      for (var i = 0; i < recordedTemps[basketId].length; i++) {
        var temp = basketId === 1 ? recordedTemps[basketId][i].basket1 : recordedTemps[basketId][i].basket2;
        if (typeof temp === 'number' && !isNaN(temp) && isFinite(temp)) {
          tempsOnly.push(temp);
        }
      }
    }
    
    var minTemp = null;
    var maxTemp = null;
    if (tempsOnly.length > 0) {
      minTemp = Math.min.apply(Math, tempsOnly);
      maxTemp = Math.max.apply(Math, tempsOnly);
      console.log('[saveCompletedTestReport] Basket ' + basketId + ' recorded ' + tempsOnly.length + ' temperature readings. Min: ' + minTemp + '°C, Max: ' + maxTemp + '°C');
    } else {
      console.warn('[saveCompletedTestReport] No temperature readings recorded for basket ' + basketId + '. recordedTemps length: ' + (recordedTemps[basketId] ? recordedTemps[basketId].length : 0));
    }
    
    // Compute duration in seconds
    var durationSeconds = Math.floor((stopTime - startTime) / 1000);

    // Use bridge RTC time for report timestamps (fallback to browser time).
    function _pad2(n){ return String(n).padStart(2, '0'); }
    function _fmtLocalIsoNoTz(d){
      return String(d.getFullYear()) + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate()) +
             'T' + _pad2(d.getHours()) + ':' + _pad2(d.getMinutes()) + ':' + _pad2(d.getSeconds());
    }
    var rtcNow = null;
    try {
      var rtcRes = await fetchWithTimeout('/api/get_datetime', {}, 3000);
      if (rtcRes && rtcRes.ok) {
        var rtcData = await rtcRes.json();
        rtcNow = (rtcData && (rtcData.datetime || rtcData.createdAt || rtcData.iso)) || null;
      }
    } catch (e) {
      rtcNow = null;
    }
    var now = rtcNow || new Date().toISOString();

    // Use RTC end time, and derive start time from duration when possible.
    var testEndTimeIso = now;
    var testStartTimeIso = null;
    try {
      var endDate = new Date(now);
      if (!isNaN(endDate.getTime())) {
        var startDate = new Date(endDate.getTime() - (durationSeconds * 1000));
        testStartTimeIso = _fmtLocalIsoNoTz(startDate);
      }
    } catch (e) {
      testStartTimeIso = null;
    }
    var report = {
      id: Date.now(),
      type: 'test',
      validationSubtype: null,
      name: reportName,
      createdAt: now,
      completedAt: now, // Test completion timestamp (RTC)
      productName1: basketId === 1 ? product1 : null,
      batch1: basketId === 1 ? batch1 : null,
      productName2: basketId === 2 ? (product2 || product1) : null,
      batch2: basketId === 2 ? (batch2 || batch1) : null,
      mode: mode,
      setTemperature: temperature,
      setDuration: setDuration, // null for manual mode, recipe duration for timer mode
      duration: duration, // Actual test duration
      durationSeconds: durationSeconds, // Duration in seconds (computed from start/end times)
      status: (options && options.aborted) ? 'Test Aborted' : 'Completed',
      beaker: null,
      basket: basketId,
      basketConfig: basketConfig, // Save vessel (1, 3, or 6)
      holeCompletionTimes: basketHoleTimes, // Save vessel completion times 
      holeCompletionTimestamps: holeCompletionTimes[basketId] || {}, // Save vessel completion timestamps (absolute time)
      vesselTimes: vesselTimesCopy, // ISO timestamps per vessel index
      testStartTime: testStartTimeIso || new Date(startTime).toISOString(), // Prefer RTC-derived start time
      testEndTime: testEndTimeIso || new Date(stopTime).toISOString(), // Prefer RTC end time
      minTemp: minTemp, // Minimum temperature recorded during test
      maxTemp: maxTemp, // Maximum temperature recorded during test
      operatorName: (currentUser && currentUser.name) || '',
      operatorId: (currentUser && currentUser.username) || ''
    };
    
    await saveReportRecord(report);
    console.log('Test report saved for basket ' + basketId);
    
    // Generate PDF from HTML after saving the report
    // Note: saveReportPdfFromHtml will handle rendering internally
    if (typeof saveReportPdfFromHtml === 'function') {
      console.log('[saveCompletedTestReport] Generating PDF for report:', report.id);
      var pdfSuccess = await saveReportPdfFromHtml(report);
      if (pdfSuccess) {
        console.log('[saveCompletedTestReport] PDF generated successfully for report:', report.id);
      } else {
        console.warn('[saveCompletedTestReport] PDF generation failed for report:', report.id);
      }
    } else {
      console.warn('[saveCompletedTestReport] saveReportPdfFromHtml function not available');
    }
    
    // Auto-redirect to reports page after saving
    if (typeof navigateTo === 'function') {
      navigateTo('reports');
      // After short timeout, open preview for this saved report
      setTimeout(function() {
        if (typeof openReportPreview === 'function') {
          openReportPreview(report.id);
        }
      }, 500);
    }
    
    // NOW clear the per-run state after saving, so the next test starts fresh
    basketHoles[basketId] = {};
    holeCompletionTimes[basketId] = {};
    recordedTemps[basketId] = []; // Clear temperature recordings
    if (typeof currentRunVesselTimes !== 'undefined') {
      currentRunVesselTimes = {};
    }
  } catch (e) {
    console.error('Error saving test report:', e);
  }
}

function updateHeaterControlVisibility() {
  var b1 = document.getElementById('heater-control-basket-1');
  var b2 = document.getElementById('heater-control-basket-2');
  var grid = document.getElementById('heater-control-grid');
  if (!b1 || !b2) return;
  var c1 = configuredBeakers && !!configuredBeakers[1];
  var c2 = configuredBeakers && !!configuredBeakers[2];
  if (c1) {
    b1.style.display = '';
    b1.style.visibility = 'visible';
  } else {
    b1.style.display = 'none';
    b1.style.visibility = 'hidden';
  }
  if (c2) {
    b2.style.display = '';
    b2.style.visibility = 'visible';
  } else {
    b2.style.display = 'none';
    b2.style.visibility = 'hidden';
  }
  if (grid) {
    grid.className = (c1 && c2) ? 'grid grid-cols-2 gap-6' : 'grid grid-cols-1 gap-6 max-w-2xl mx-auto';
  }
}

function updateHeaterControlUI() {
  for (var i = 1; i <= 2; i++) {
    var controlBtn = document.getElementById('heater-control-btn-' + i);
    var controlText = document.getElementById('control-text-' + i);
    
    if (heaterOn[i]) {
      if (controlBtn) {
        controlBtn.style.background = 'linear-gradient(to right, #dc2626, #b91c1c)';
        controlBtn.style.borderColor = '#dc2626';
        controlBtn.style.color = 'white';
      }
      if (controlText) {
        // Show status text (not the toggle action)
        controlText.textContent = 'Heating';
      }
    } else {
      if (controlBtn) {
        controlBtn.style.background = 'linear-gradient(to right, #16a34a, #15803d)';
        controlBtn.style.borderColor = '#16a34a';
        controlBtn.style.color = 'white';
      }
      if (controlText) {
        // Show status text (not the toggle action)
        controlText.textContent = 'Start';
      }
    }
    
    // Update dashboard heater icon and text glow
    var dashboardHeaterBtn = document.getElementById('heater' + i);
    if (dashboardHeaterBtn) {
      var flame = dashboardHeaterBtn.querySelector('i');
      var label = dashboardHeaterBtn.querySelector('span');
      
      if (heaterOn[i]) {
        if (flame) {
          flame.style.color = '#f97316';
          flame.classList.add('flame-glow');
        }
        if (label) {
          label.textContent = 'Heater On';
          label.style.color = '#f97316';
          label.classList.add('heater-text-glow');
        }
        dashboardHeaterBtn.classList.add('heater-on-glow');
      } else {
        if (flame) {
          flame.style.color = '#6b7280';
          flame.classList.remove('flame-glow');
        }
        if (label) {
          label.textContent = 'Heater Off';
          label.style.color = '#6b7280';
          label.classList.remove('heater-text-glow');
        }
        dashboardHeaterBtn.classList.remove('heater-on-glow');
      }
    }
    
    // FIX: Update dashboard start/preheating button based on heater state
    var startBtn = document.getElementById('start' + i);
    if (startBtn) {
      // Only update if test is not running (test running state takes precedence)
      if (!testRunning[i] && !timers[i]?.running) {
        if (heaterOn[i]) {
          // Heater is ON → show Preheating button
          startBtn.textContent = 'Preheating...';
          startBtn.style.background = '#f59e0b'; // amber
          startBtn.disabled = false; // Allow clicking to abort
          // Set preheat in progress flag
          if (!window.preheatInProgress) {
            window.preheatInProgress = {1: false, 2: false, 3: false};
          }
          window.preheatInProgress[i] = true;
        } else {
          // Heater is OFF → show Start button
          startBtn.textContent = 'Start';
          startBtn.style.background = '#10b981'; // green
          startBtn.disabled = false;
          // Clear preheat in progress flag
          if (window.preheatInProgress) {
            window.preheatInProgress[i] = false;
          }
        }
      }
      // If test is running, don't change the button (it should show "Stop")
    }
  }
}

// Expose helper functions
window.initializeTemperatureValidationReal = initializeTemperatureValidationReal;
window.checkTemperatureValidationReal = checkTemperatureValidationReal;
window.updateBasketStates = updateBasketStates;
window.updateBasketHoles = updateBasketHoles;
window.updateBasketHoleSelection = updateBasketHoleSelection;
window.toggleHole = toggleHole;
window.checkAllHolesComplete = checkAllHolesComplete;
window.saveCompletedTestReport = saveCompletedTestReport;
window.updateHeaterControlUI = updateHeaterControlUI;

// ========== RECIPE MODE MENU ==========
function showRecipeModeMenu() {
  var modalMessageEl = document.getElementById('modal-message');
  var modalEl = document.getElementById('modal');
  var modalButtonsEl = document.getElementById('modal-buttons');
  
  if (!modalMessageEl || !modalEl) return;
  
  // Hide default buttons
  if (modalButtonsEl) {
    modalButtonsEl.style.display = 'none';
  }
  
  // Create custom buttons for recipe actions
  var customButtons = '<div style="display:flex;flex-direction:column;gap:12px;width:100%;margin-top:20px;">' +
    '<button onclick="navigateToRecipeList()" style="padding:16px 24px;background:#0891b2;color:white;border-radius:12px;font-size:18px;font-weight:bold;border:3px solid #0e7490;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;">' +
    '<i data-lucide="list" style="width:24px;height:24px;"></i>' +
    '<span>Load Recipe</span>' +
    '</button>' +
    '<button onclick="navigateToCreateRecipe()" style="padding:16px 24px;background:#10b981;color:white;border-radius:12px;font-size:18px;font-weight:bold;border:3px solid #059669;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;">' +
    '<i data-lucide="plus-circle" style="width:24px;height:24px;"></i>' +
    '<span>Create Recipe</span>' +
    '</button>' +
    '<button onclick="hideModal()" style="padding:12px 24px;background:#6b7280;color:white;border-radius:12px;font-size:16px;font-weight:bold;border:3px solid #4b5563;box-shadow:0 4px 12px rgba(0,0,0,.3);cursor:pointer;">Cancel</button>' +
    '</div>';
  
  modalMessageEl.innerHTML = '<div style="text-align:center;"><h2 style="color:white;font-size:24px;margin-bottom:10px;font-weight:bold;">Recipe Management</h2><p style="color:#9ca3af;font-size:16px;">Choose an action</p></div>' + customButtons;
  
  modalEl.classList.add('active');
  
  // Re-initialize Lucide icons for the new buttons
  setTimeout(function() {
    if (window.lucide && typeof lucide.createIcons === 'function') {
      lucide.createIcons();
    }
  }, 50);
}

function navigateToRecipeList() {
  hideModal();
  if (typeof navigateTo === 'function') {
    navigateTo('recipe-list');
  }
}

function navigateToCreateRecipe() {
  hideModal();
  editingRecipeId = null;  // Ensure create-new mode
  if (typeof navigateTo === 'function') {
    navigateTo('create-recipe');
  }
}

window.showRecipeModeMenu = showRecipeModeMenu;
window.navigateToRecipeList = navigateToRecipeList;
window.navigateToCreateRecipe = navigateToCreateRecipe;

async function persistMembers(members){
  await safeSave('users', members);
  // refresh UI
  renderMembersTable(members);
}

/* Render members table (idempotent) - FIXED: Now reads from StorageAdapter */
async function renderMembersTable(members){
  // FIXED: If members not provided, load from StorageAdapter
  if (!members || members.length === 0) {
    members = await StorageAdapter.get('users') || [];
  }
  
  var tbody = document.getElementById('members-table-body');
  if(!tbody) return;
  tbody.innerHTML = '';
  
  // Filter out protected factory user
  var visibleMembers = members.filter(m => !isProtectedFactoryUser(m));
  
  if (visibleMembers.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-400 py-4">No members found</td></tr>';
    return;
  }
  
  // RBAC: Check permissions for edit/delete actions
  // Factory and Admin have full access to manage members
  var role = getCurrentRole();
  var normalizedRole = role ? String(role).toLowerCase() : null;
  // Factory and Admin always have full access (normalized comparison)
  var canEdit = (normalizedRole === 'factory' || normalizedRole === 'admin') || (canAccess(role, 'user-manage') && canPerformAction(role, 'user-manage', 'edit'));
  var canDelete = (normalizedRole === 'factory' || normalizedRole === 'admin') || (canAccess(role, 'user-manage') && canPerformAction(role, 'user-manage', 'delete'));
  
  // Map original indices to filtered indices for action handlers
  var originalToFiltered = {};
  var filteredIdx = 0;
  for (var origIdx = 0; origIdx < members.length; origIdx++) {
    if (!isProtectedFactoryUser(members[origIdx])) {
      originalToFiltered[filteredIdx] = origIdx;
      filteredIdx++;
    }
  }
  
  for (var idx = 0; idx < visibleMembers.length; idx++) {
    var m = visibleMembers[idx];
    var originalIdx = originalToFiltered[idx];
    var tr = document.createElement('tr');
    var mName = m.name || m.fullName || '';
    var mUsername = m.username || '';
    var mRole = m.role || '';
    
    var actionButtons = '';
    if (canEdit || canDelete) {
      actionButtons = '<td style="display:flex;gap:8px;">';
      if (canEdit) {
        actionButtons += '<button class="bg-yellow-500 text-black px-4 py-2" data-action="change-role" data-idx="' + originalIdx + '">Change Role</button>';
      }
      if (canDelete) {
        actionButtons += '<button class="bg-red-600 text-white px-4 py-2" data-action="delete-member" data-idx="' + originalIdx + '">Delete</button>';
      }
      actionButtons += '</td>';
    } else {
      actionButtons = '<td class="text-gray-500">No actions available</td>';
    }
    
    tr.innerHTML = '<td>' + mName + '</td>' +
      '<td>' + mUsername + '</td>' +
      '<td id="member-role-' + originalIdx + '">' + mRole + '</td>' +
      actionButtons;
    tbody.appendChild(tr);
  }
}

/* Attach table action handlers */
function attachMembersTableHandlers(){
  const tbody = document.getElementById('members-table-body');
  if(!tbody) return;
  tbody.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('button');
    if(!btn) return;
    const action = btn.dataset.action;
    const idx = Number(btn.dataset.idx);
    if(action === 'delete-member'){
      // RBAC: Check permission to delete members
      // Factory and Admin have full access
      var role = getCurrentRole();
      var normalizedRole = role ? String(role).toLowerCase() : null;
      if (normalizedRole !== 'factory' && normalizedRole !== 'admin' && (!canAccess(role, 'user-manage') || !canPerformAction(role, 'user-manage', 'delete'))) {
        if (typeof showToast === 'function') {
          showToast('You do not have permission to perform this action. Please contact your administrator.', 'error');
        } else if (typeof showModal === 'function') {
          showModal('You do not have permission to perform this action. Please contact your administrator.');
        }
        return;
      }
      
      // confirm
      const members = await loadMembers();
      const user = members[idx];
      
      // Protect factory user
      if (isProtectedFactoryUser(user)) {
        if (typeof showModal === 'function') {
          showModal('This factory user is protected and cannot be deleted.');
        } else if (typeof showToast === 'function') {
          showToast('This factory user is protected and cannot be deleted.', 'error');
        }
        return;
      }
      
      const ok = await showModalConfirm(`Delete user "${user.name || user.fullName || user.username}"? This action cannot be undone.`);
      if(!ok) { showToast('Delete cancelled','info'); return; }
      members.splice(idx,1);
      await persistMembers(members);
      showToast('User deleted', 'success');
    }else if(action === 'change-role'){
      // RBAC: Check permission to change roles
      // Factory and Admin have full access
      var role = getCurrentRole();
      var normalizedRole = role ? String(role).toLowerCase() : null;
      if (normalizedRole !== 'factory' && normalizedRole !== 'admin' && (!canAccess(role, 'user-manage') || !canPerformAction(role, 'user-manage', 'change'))) {
        if (typeof showToast === 'function') {
          showToast('You do not have permission to perform this action. Please contact your administrator.', 'error');
        } else if (typeof showModal === 'function') {
          showModal('You do not have permission to perform this action. Please contact your administrator.');
        }
        return;
      }
      (async function() {
        var members = await loadMembers();
        var user = members[idx];
        
        // Protect factory user
        if (isProtectedFactoryUser(user)) {
          if (typeof showModal === 'function') {
            showModal('This factory user is protected and cannot be modified.');
          } else if (typeof showToast === 'function') {
            showToast('This factory user is protected and cannot be modified.', 'error');
          }
          return;
        }
        
        var userName = user.name || user.fullName || user.username || 'User';
        var currentRole = user.role || 'User';
        
        // Create custom role selection modal
        var modalEl = document.getElementById('modal');
        var modalMessageEl = document.getElementById('modal-message');
        var modalContentEl = modalEl ? modalEl.querySelector('.modal-content') : null;
        
        if (!modalEl || !modalMessageEl) {
          if (typeof showToast === 'function') {
            showToast('Modal not found', 'error');
          }
          return;
        }
        
        // Hide the default OK and Cancel buttons
        var defaultButtons = modalContentEl ? modalContentEl.querySelectorAll('button') : [];
        for (var btnIdx = 0; btnIdx < defaultButtons.length; btnIdx++) {
          defaultButtons[btnIdx].style.display = 'none';
        }
        
        // Set innerHTML instead of textContent to allow HTML
        modalMessageEl.innerHTML = '<div style="padding: 20px; text-align: center;">' +
          '<h3 style="font-size: 24px; font-weight: bold; margin-bottom: 20px; color: white;">Change Role for ' + userName + '</h3>' +
          '<p style="margin-bottom: 20px; color: #d1d5db;">Current Role: <strong style="color: white;">' + currentRole + '</strong></p>' +
          '<div style="display: flex; flex-direction: column; gap: 12px; margin-bottom: 20px;">' +
          '<button id="role-select-admin" style="background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; font-size: 18px; font-weight: bold; border: none; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background=\'#1d4ed8\'" onmouseout="this.style.background=\'#2563eb\'" onclick="window._selectedRole = \'Admin\'; window._roleModalConfirmed = true; hideModal();">Admin</button>' +
          '<button id="role-select-supervisor" style="background: #9333ea; color: white; padding: 12px 24px; border-radius: 8px; font-size: 18px; font-weight: bold; border: none; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background=\'#7e22ce\'" onmouseout="this.style.background=\'#9333ea\'" onclick="window._selectedRole = \'Supervisor\'; window._roleModalConfirmed = true; hideModal();">Supervisor</button>' +
          '<button id="role-select-user" style="background: #16a34a; color: white; padding: 12px 24px; border-radius: 8px; font-size: 18px; font-weight: bold; border: none; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background=\'#15803d\'" onmouseout="this.style.background=\'#16a34a\'" onclick="window._selectedRole = \'User\'; window._roleModalConfirmed = true; hideModal();">User</button>' +
          '</div>' +
          '<button style="background: #4b5563; color: white; padding: 12px 24px; border-radius: 8px; font-size: 18px; border: none; cursor: pointer; transition: background 0.2s;" onmouseover="this.style.background=\'#374151\'" onmouseout="this.style.background=\'#4b5563\'" onclick="window._roleModalConfirmed = false; hideModal();">Cancel</button>' +
          '</div>';
        
        // Show the modal
        modalEl.classList.add('active');
        
        window._selectedRole = null;
        window._roleModalConfirmed = false;
        window._changeRoleUserIndex = idx;
        window._changeRoleUserName = userName;
        window._changeRoleUsername = user.username; // Store username for reliable lookup
        
        // Wait for modal to be closed
        var checkInterval = setInterval(function() {
          if (!modalEl.classList.contains('active')) {
            clearInterval(checkInterval);
            
            if (window._roleModalConfirmed && window._selectedRole) {
              var normalized = window._selectedRole;
              var allowed = ['Admin','Supervisor','User'];
              var isValid = false;
              for (var i = 0; i < allowed.length; i++) {
                if (allowed[i] === normalized) {
                  isValid = true;
                  break;
                }
              }
              
              if (!isValid) {
                if (typeof showToast === 'function') {
                  showToast('Invalid role', 'error');
                }
                window._selectedRole = null;
                window._roleModalConfirmed = undefined;
                window._changeRoleUserIndex = undefined;
                window._changeRoleUserName = undefined;
                window._changeRoleUsername = undefined;
                return;
              }
              
              // Confirm the change
              // FIX: Use showModalConfirm only, remove window.confirm fallback
              (async function() {
                var confirmed = false;
                if (typeof showModalConfirm === 'function') {
                  confirmed = await showModalConfirm('Change role of ' + window._changeRoleUserName + ' to ' + normalized + '?');
                }
                
                if (confirmed) {
                  // Reload members to get latest data
                  var members2 = await loadMembers();
                  
                  // Find user by username (more reliable than index)
                  var user2 = null;
                  var userIndex = -1;
                  for (var j = 0; j < members2.length; j++) {
                    if (members2[j].username === window._changeRoleUsername) {
                      user2 = members2[j];
                      userIndex = j;
                      break;
                    }
                  }
                  
                  if (user2) {
                    // Protect factory user
                    if (isProtectedFactoryUser(user2)) {
                      if (typeof showModal === 'function') {
                        showModal('This factory user is protected and cannot be modified.');
                      } else if (typeof showToast === 'function') {
                        showToast('This factory user is protected and cannot be modified.', 'error');
                      }
                      return;
                    }
                    
                    user2.role = normalized;
                    await safeSave('users', members2);
                    
                    // Refresh the table
                    if (typeof renderMembersTable === 'function') {
                      await renderMembersTable(members2);
                    }
                    if (typeof attachMembersTableHandlers === 'function') {
                      attachMembersTableHandlers();
                    }
                    
                    if (typeof showToast === 'function') {
                      showToast('Role updated successfully', 'success');
                    }
                  } else {
                    if (typeof showToast === 'function') {
                      showToast('User not found', 'error');
                    }
                  }
                } else {
                  if (typeof showToast === 'function') {
                    showToast('Role change cancelled', 'info');
                  }
                }
                
                window._selectedRole = null; 
                window._roleModalConfirmed = undefined;
                window._changeRoleUserIndex = undefined;
                window._changeRoleUserName = undefined;
                window._changeRoleUsername = undefined;
              })();
            } else {
              if (typeof showToast === 'function') {
                showToast('Role change cancelled', 'info');
              }
              window._selectedRole = null;
              window._roleModalConfirmed = undefined;
              window._changeRoleUserIndex = undefined;
              window._changeRoleUserName = undefined;
              window._changeRoleUsername = undefined;
            }
          }
    }, 100);
      })();
    }
  });
}

/* initialize members UI - FIXED: Now properly loads from StorageAdapter */
async function initManageMembers(){
  attachInputFocusHandlers(document.getElementById('screen-manage-members') || document);
  // FIXED: Load members from StorageAdapter
  const members = await StorageAdapter.get('users') || [];
  await renderMembersTable(members);
  attachMembersTableHandlers();
}

/* Factory Settings Functions */

async function initFactorySettings() {
  try {
    const screen = document.getElementById('screen-factory-settings');
    if (!screen) return;

    // Wait a bit to ensure screen is visible
    await new Promise(resolve => setTimeout(resolve, 50));

    // Attach keyboard / focus handlers for this screen
    if (typeof attachInputFocusHandlers === 'function') {
      attachInputFocusHandlers(screen);
    }

    // Load saved factory settings
    const settings = await StorageAdapter.get('factorySettings') || {};

    // Populate all fields with saved data (or leave empty if first launch)
    const companyNameEl      = document.getElementById('factory-company-name');
    const companyLocationEl  = document.getElementById('factory-company-location');
    const serialNoEl         = document.getElementById('factory-serial-no');
    const modelNoEl          = document.getElementById('factory-model-no');
    const instrumentIdEl     = document.getElementById('factory-instrument-id');
    const installationDateEl = document.getElementById('factory-installation-date');
    const firmwareEl         = document.getElementById('factory-firmware');
    const installedByEl      = document.getElementById('factory-installed-by');

    if (companyNameEl)      companyNameEl.value      = settings.companyName      || '';
    if (companyLocationEl)  companyLocationEl.value  = settings.companyLocation  || '';
    if (serialNoEl)         serialNoEl.value         = settings.serialNo         || '';
    if (modelNoEl)          modelNoEl.value          = settings.modelNo          || '';
    if (instrumentIdEl)     instrumentIdEl.value     = settings.instrumentId     || '';
    if (installationDateEl) installationDateEl.value = settings.installationDate || '';
    if (firmwareEl)         firmwareEl.value         = settings.firmware         || '';
    if (installedByEl)      installedByEl.value      = settings.installedBy      || '';

    if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
    }
  } catch (e) {
    console.error('Error initializing factory settings:', e);
  }
}

async function handleSaveFactorySettings(event) {
  console.log('[Factory Settings] handleSaveFactorySettings called', event);
  if (event) {
    if (typeof event.preventDefault === 'function')  event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
  }
  try {
    await saveFactorySettings();
  } catch (error) {
    console.error('[Factory Settings] Error in handleSaveFactorySettings:', error);
    if (typeof showToast === 'function') {
      showToast('An error occurred while saving', 'error');
    }
  }
  return false;
}

async function saveFactorySettings() {
  // RBAC: Check permission to save factory settings
  var role = getCurrentRole();
  if (isViewOnly(role, 'factory-settings') || !canAccess(role, 'factory-settings')) {
    if (typeof showToast === 'function') {
      showToast('You do not have permission to change factory settings.', 'error');
    } else if (typeof showModal === 'function') {
      showModal('You do not have permission to change factory settings.');
    }
    return;
  }
  
  console.log('[Factory Settings] Save button clicked');
  try {
    // Collect all form field values (no optional chaining)
    const companyNameEl      = document.getElementById('factory-company-name');
    const companyLocationEl  = document.getElementById('factory-company-location');
    const serialNoEl         = document.getElementById('factory-serial-no');
    const modelNoEl          = document.getElementById('factory-model-no');
    const instrumentIdEl     = document.getElementById('factory-instrument-id');
    const installationDateEl = document.getElementById('factory-installation-date');
    const firmwareEl         = document.getElementById('factory-firmware');
    const installedByEl      = document.getElementById('factory-installed-by');

    const companyName      = companyNameEl      && companyNameEl.value      ? companyNameEl.value.trim()      : '';
    const companyLocation  = companyLocationEl  && companyLocationEl.value  ? companyLocationEl.value.trim()  : '';
    const serialNo         = serialNoEl         && serialNoEl.value         ? serialNoEl.value.trim()         : '';
    const modelNo          = modelNoEl          && modelNoEl.value          ? modelNoEl.value.trim()          : '';
    const instrumentId     = instrumentIdEl     && instrumentIdEl.value     ? instrumentIdEl.value.trim()     : '';
    const installationDate = installationDateEl && installationDateEl.value ? installationDateEl.value        : '';
    const firmware         = firmwareEl         && firmwareEl.value         ? firmwareEl.value.trim()         : '';
    const installedBy      = installedByEl      && installedByEl.value      ? installedByEl.value.trim()      : '';

    // Validate required fields
    if (!companyName || !companyLocation) {
      if (typeof showToast === 'function') {
        showToast('Company Name and Location are required', 'error');
      }
        return;
    }

    // Confirm (like recipe)
    // FIX: Use showModalConfirm only, remove window.confirm fallback
    let confirmed = false;
    if (typeof showModalConfirm === 'function') {
      confirmed = await showModalConfirm('Are you sure you want to save these factory settings?');
    }
    if (!confirmed) return;

    // Prepare data object
    const data = {
      companyName,
      companyLocation,
      serialNo,
      modelNo,
      instrumentId,
      installationDate,
      firmware,
      installedBy
    };

    // Save to storage
    await safeSave('factorySettings', data);

    // Update related displays
    await updateFactorySettingsDisplays();

    // Show success message + navigate (same pattern as recipe)
    if (typeof showToast === 'function') {
      showToast('Factory settings saved successfully','success');
    }
    setTimeout(function () {
      if (typeof navigateTo === 'function') navigateTo('settings');
    }, 500);

  } catch (e) {
    console.error('[Factory Settings] Error saving factory settings:', e);
    if (typeof showToast === 'function') {
      showToast('Failed to save factory settings', 'error');
    }
    setTimeout(function () {
      if (typeof navigateTo === 'function') navigateTo('settings');
    }, 1000);
  }
}

async function updateFactorySettingsDisplays() {
  try {
    const factorySettings = await StorageAdapter.get('factorySettings') || {};

    // LOGIN screen - C2: Show Model + Serial instead of company name
    const modelNumberEl = document.getElementById('login-model-number');
    const serialNumberEl = document.getElementById('login-serial-number');
    const modelDisplayEl = document.getElementById('login-model-display');

    if (modelNumberEl) modelNumberEl.textContent = factorySettings.modelNo || 'DT-2025';
    if (serialNumberEl) serialNumberEl.textContent = factorySettings.serialNo || 'SN-0000';

    if (modelDisplayEl) {
      if (!factorySettings.modelNo && !factorySettings.companyName) {
        modelDisplayEl.style.display = 'none';
      } else {
        modelDisplayEl.style.display = 'block';
      }
    }

    // REPORT preview
    const reportCompanyEl = document.getElementById('report-client-company');
    if (reportCompanyEl) {
      reportCompanyEl.textContent = factorySettings.companyName || 'Client Company Name';
    }

  } catch (e) {
    console.error('Error updating factory settings displays:', e);
  }
}
 
/* Hook a small bootstrap so these init functions run when screens appear */
(function () {
  var originalNavigateTo = null;

  function hookNavigateTo() {
    if (typeof window.navigateTo === 'function' && !window.navigateTo._hooked) {
      originalNavigateTo = window.navigateTo;
      window.navigateTo = function (screenId) {
        originalNavigateTo(screenId);

        if (screenId === 'manage-members' && typeof initManageMembers === 'function') {
          setTimeout(function () {
            initManageMembers();
          }, 100);
        }

        if (screenId === 'factory-settings' && typeof initFactorySettings === 'function') {
          setTimeout(function () {
            initFactorySettings();
          }, 100);
        }
        
        // FIX: Load recipe data when navigating to dashboard
        if (screenId === 'dashboard') {
          (async function() {
            try {
              // Load saved recipe data
              var savedBasketProducts = await StorageAdapter.get('basketProducts');
              if (savedBasketProducts) {
                basketProducts[1] = savedBasketProducts[1] || null;
                basketProducts[2] = savedBasketProducts[2] || null;
              }
              
              var savedBasketBatches = await StorageAdapter.get('basketBatches');
              if (savedBasketBatches) {
                basketBatches[1] = savedBasketBatches[1] || null;
                basketBatches[2] = savedBasketBatches[2] || null;
              }
              
              var savedBasketDurations = await StorageAdapter.get('basketDurations');
              if (savedBasketDurations) {
                basketDurations[1] = savedBasketDurations[1] || null;
                basketDurations[2] = savedBasketDurations[2] || null;
              }
              
              var savedBasketModes = await StorageAdapter.get('basketModes');
              if (savedBasketModes) {
                basketModes[1] = savedBasketModes[1] || 'manual';
                basketModes[2] = savedBasketModes[2] || 'manual';
              }
              
              var savedSetTemp = await StorageAdapter.get('setTemp');
              if (savedSetTemp) {
                setTemp[1] = savedSetTemp[1] || 37.0;
                setTemp[2] = savedSetTemp[2] || 37.0;
              }
              
              // Update UI with loaded recipe data
              if (typeof updateDashboardProductNames === 'function') {
                updateDashboardProductNames();
              }
              if (typeof updateDashboardTempButton === 'function') {
                updateDashboardTempButton();
              }
              if (typeof updateModeButtonsUI === 'function') {
                updateModeButtonsUI(1);
                updateModeButtonsUI(2);
              }
              if (typeof updateBasketStates === 'function') {
                updateBasketStates();
              }
            } catch (e) {
              console.error('[Dashboard] Error loading recipe data:', e);
            }
          })();
        }
      };
      window.navigateTo._hooked = true;
    } else {
      setTimeout(hookNavigateTo, 100);
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    if (typeof attachInputFocusHandlers === 'function') {
      attachInputFocusHandlers(document);
    }
    hookNavigateTo();

    setTimeout(function () {
      var manageScreen  = document.getElementById('screen-manage-members');
      var factoryScreen = document.getElementById('screen-factory-settings');

      if (manageScreen && manageScreen.classList.contains('active') && typeof initManageMembers === 'function') {
        initManageMembers();
      }
      if (factoryScreen && factoryScreen.classList.contains('active') && typeof initFactorySettings === 'function') {
        initFactorySettings();
      }
    }, 500);
    
    // Attach login button handler
    var loginBtn = document.getElementById('login-btn');
    if (loginBtn) {
      loginBtn.addEventListener('click', function(e) {
        if (e) {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          if (typeof e.stopPropagation === 'function') e.stopPropagation();
        }
        if (typeof handleLogin === 'function') {
          handleLogin();
        }
      });
    }
    
    // Initialize app - FIX: Wrap in try/catch to prevent blocking login
    (async function() {
      try {
        // Load saved basket configuration
        var savedConfiguredBeakers = await StorageAdapter.get('configuredBeakers');
      if (savedConfiguredBeakers) {
        configuredBeakers[1] = savedConfiguredBeakers[1] || false;
        configuredBeakers[2] = savedConfiguredBeakers[2] || false;
      }
      
      // Load other saved settings
      var savedBasketConfig = await StorageAdapter.get('basketConfig');
      if (savedBasketConfig) {
        basketConfig = savedBasketConfig;
      } else {
        // Default to 6 basket configuration if not set
        basketConfig = 6;
        await safeSave('basketConfig', basketConfig);
      }
      
      // Only set both beakers as default when no saved config exists (first run)
      // Do NOT overwrite user's single-beaker choice (e.g. only beaker 2)
      if (!savedConfiguredBeakers || (savedConfiguredBeakers[1] == null && savedConfiguredBeakers[2] == null)) {
        if (!configuredBeakers[1]) configuredBeakers[1] = true;
        if (!configuredBeakers[2]) configuredBeakers[2] = true;
      }
      
      var savedSetTemp = await StorageAdapter.get('setTemp');
      if (savedSetTemp) {
        setTemp[1] = savedSetTemp[1] || 37.0;
        setTemp[2] = savedSetTemp[2] || 37.0;
      }
      
      var savedBasketModes = await StorageAdapter.get('basketModes');
      if (savedBasketModes) {
        basketModes[1] = savedBasketModes[1] || 'manual';
        basketModes[2] = savedBasketModes[2] || 'manual';
      }
      
      // FIX: Load saved recipe data (products, batches, durations)
      var savedBasketProducts = await StorageAdapter.get('basketProducts');
      if (savedBasketProducts) {
        basketProducts[1] = savedBasketProducts[1] || null;
        basketProducts[2] = savedBasketProducts[2] || null;
      }
      
      var savedBasketBatches = await StorageAdapter.get('basketBatches');
      if (savedBasketBatches) {
        basketBatches[1] = savedBasketBatches[1] || null;
        basketBatches[2] = savedBasketBatches[2] || null;
      }
      
      var savedBasketDurations = await StorageAdapter.get('basketDurations');
      if (savedBasketDurations) {
        basketDurations[1] = savedBasketDurations[1] || null;
        basketDurations[2] = savedBasketDurations[2] || null;
      }
      
      // Apply mode button UI after loading from storage
      if (typeof updateModeButtonsUI === 'function') {
        updateModeButtonsUI(1);
        updateModeButtonsUI(2);
      }
      
      // Update dashboard product names and temperature after loading recipe data
      if (typeof updateDashboardProductNames === 'function') {
        updateDashboardProductNames();
      }
      if (typeof updateDashboardTempButton === 'function') {
        updateDashboardTempButton();
      }
      
      // Load calibration offsets
      var savedCalibrationOffsets = await StorageAdapter.get('calibrationOffsets');
      if (savedCalibrationOffsets) {
        calibrationOffsets[1] = savedCalibrationOffsets[1] || 0;
        calibrationOffsets[2] = savedCalibrationOffsets[2] || 0;
      }
      
      // Update basket states after loading configuration
      if (typeof updateBasketStates === 'function') {
        updateBasketStates();
      }
      
      // Update basket holes/vessel layout based on basketConfig
      if (typeof updateBasketHoles === 'function') {
        updateBasketHoles(1, basketConfig);
        updateBasketHoles(2, basketConfig);
      }
      
      // Update basket hole selection UI
      if (typeof updateBasketHoleSelection === 'function') {
        updateBasketHoleSelection(1);
        updateBasketHoleSelection(2);
      }
      
      if (typeof initUsers === 'function') {
        await initUsers();
      }
      if (typeof updateFactorySettingsDisplays === 'function') {
        await updateFactorySettingsDisplays();
      }
      if (typeof updateClock === 'function') {
        updateClock();
      }
      // DO NOT auto-navigate to dashboard - always show login screen first
      // User must explicitly log in each time
      var savedUser = await StorageAdapter.get('currentUser');
      if (savedUser) {
        // Clear saved user to force login
        // currentUser = savedUser;
        // window.currentUser = savedUser;
        // Don't navigate - stay on login screen
      } else {
        if (typeof navigateTo === 'function') {
          navigateTo('login');
        }
      }
      } catch (initError) {
        // FIX: App initialization errors should not block login
        console.error('[App] Error during initialization (non-critical):', initError);
        // Continue - login should still work
        if (typeof navigateTo === 'function') {
          navigateTo('login');
        }
      }
    })();
  });
})();

// === KEYBOARD MODULE ===
// Keyboard is now isolated in keyboard.js
// Use Keyboard.show(inputElement) and Keyboard.hide()
// Legacy API: openOSKForInput() and closeOSK() are provided by keyboard.js
(function () {
  // Keyboard module is loaded separately
  // All keyboard logic moved to keyboard.js
  console.log('[App] Keyboard module should be loaded from keyboard.js');
  
  // Ensure legacy API exists (provided by keyboard.js)
  if (typeof window.openOSKForInput === 'undefined') {
    window.openOSKForInput = function(element) {
      if (window.Keyboard && typeof window.Keyboard.show === 'function') {
        window.Keyboard.show(element);
    } else {
        console.warn('[App] Keyboard module not loaded yet');
    }
    };
  }
  
  if (typeof window.closeOSK === 'undefined') {
    window.closeOSK = function() {
      if (window.Keyboard && typeof window.Keyboard.hide === 'function') {
        window.Keyboard.hide();
      }
    };
  }
  
  // PATCH 5: Heater back button handler (GUARANTEED)
  (function wireHeaterBackButton() {
    var heaterBackBtn = document.getElementById('heater-back-btn');
    if (heaterBackBtn) {
      heaterBackBtn.addEventListener('click', function() {
        if (typeof navigateTo === 'function') {
          navigateTo('settings');
        }
      });
    } else {
      // Button might not exist yet, try again after DOM is ready
    setTimeout(function() {
        heaterBackBtn = document.getElementById('heater-back-btn');
        if (heaterBackBtn) {
          heaterBackBtn.addEventListener('click', function() {
            if (typeof navigateTo === 'function') {
              navigateTo('settings');
          }
          });
        }
      }, 500);
    }
  })();
  
  // PATCH 5: Heater back button handler (GUARANTEED)
  (function wireHeaterBackButton() {
    var heaterBackBtn = document.getElementById('heater-back-btn');
    if (heaterBackBtn) {
      heaterBackBtn.addEventListener('click', function() {
        if (typeof navigateTo === 'function') {
          navigateTo('settings');
        }
      });
                } else {
      // Button might not exist yet, try again after DOM is ready
      setTimeout(function() {
        heaterBackBtn = document.getElementById('heater-back-btn');
        if (heaterBackBtn) {
          heaterBackBtn.addEventListener('click', function() {
            if (typeof navigateTo === 'function') {
              navigateTo('settings');
                            }
          });
        }
      }, 500);
                }
  })();

// Edit Date and Time Functions
var editUse24Hour = true; // Default to 24-hour format
var editAmPm = 'AM'; // For 12-hour format when user does not type AM/PM

function setEditTimeFormat(is24) {
  editUse24Hour = is24;

  // Keep global clock display format in sync with edit screen choice
  // so the top bar shows AM/PM in 12-hour mode.
  if (typeof setTimeFormat === 'function') {
    try { setTimeFormat(is24); } catch (e) {}
  } else {
    try {
      use24Hour = is24;
      if (typeof safeSave === 'function') safeSave('use24Hour', is24 ? 'true' : 'false');
      if (typeof updateClock === 'function') updateClock();
    } catch (e) {}
  }

  var btn12 = document.getElementById('edit-format-12h');
  var btn24 = document.getElementById('edit-format-24h');
  var timeInput = document.getElementById('edit-time-input');
  
  var ampmContainer = document.getElementById('edit-ampm-container');
  if (is24) {
    if (btn24) {
      btn24.classList.add('active');
      btn24.style.background = '#2563eb';
      btn24.style.borderColor = '#3b82f6';
    }
    if (btn12) {
      btn12.classList.remove('active');
      btn12.style.background = '#374151';
      btn12.style.borderColor = '#6b7280';
    }
    if (timeInput) {
      timeInput.placeholder = 'HH:MM (e.g., 14:30)';
    }
    if (ampmContainer) ampmContainer.style.display = 'none';
  } else {
    if (btn12) {
      btn12.classList.add('active');
      btn12.style.background = '#2563eb';
      btn12.style.borderColor = '#3b82f6';
    }
    if (btn24) {
      btn24.classList.remove('active');
      btn24.style.background = '#374151';
      btn24.style.borderColor = '#6b7280';
    }
    if (timeInput) {
      timeInput.placeholder = 'HH:MM AM/PM (e.g., 02:30 PM)';
    }
    if (ampmContainer) ampmContainer.style.display = 'flex';
    // Initialize editAmPm from current time input when switching to 12h
    var val = (timeInput && timeInput.value) ? timeInput.value.trim().toUpperCase() : '';
    if (/PM|P\.M\.|P\b/.test(val)) {
      editAmPm = 'PM';
    } else if (/AM|A\.M\.|A\b/.test(val)) {
      editAmPm = 'AM';
    } else if (val.match(/^\d{1,2}:\d{2}$/)) {
      var h = parseInt(val.split(':')[0], 10);
      editAmPm = (h >= 12) ? 'PM' : 'AM';
    }
    if (typeof setEditAmPm === 'function') setEditAmPm(editAmPm);
  }
}

window.setEditTimeFormat = setEditTimeFormat;

function setEditAmPm(ampm) {
  editAmPm = ampm;
  var btnAm = document.getElementById('edit-ampm-am');
  var btnPm = document.getElementById('edit-ampm-pm');
  if (btnAm) {
    btnAm.style.background = ampm === 'AM' ? '#2563eb' : '#374151';
    btnAm.style.borderColor = ampm === 'AM' ? '#3b82f6' : '#6b7280';
  }
  if (btnPm) {
    btnPm.style.background = ampm === 'PM' ? '#2563eb' : '#374151';
    btnPm.style.borderColor = ampm === 'PM' ? '#3b82f6' : '#6b7280';
  }
}
window.setEditAmPm = setEditAmPm;

// Parse date from DD-MM-YYYY format
function parseDateInput(dateStr) {
  if (!dateStr) return null;
  dateStr = dateStr.trim();
  
  // Replace placeholder D's and Y's with empty and clean up
  dateStr = dateStr.replace(/D/g, ''); // Remove D placeholders
  dateStr = dateStr.replace(/Y/g, ''); // Remove Y placeholders
  
  // Try DD-MM-YYYY format
  var parts = dateStr.split('-');
  if (parts.length === 3) {
    var day = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var year = parseInt(parts[2], 10);
    // Check if all are valid numbers (including 0 for edge cases)
    if (!isNaN(day) && !isNaN(month) && !isNaN(year) && 
        day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
      return String(year) + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
  }
  
  // Try YYYY-MM-DD format (already correct)
  if (dateStr.match(/^\d{4}-\d{2}-\d{2}$/)) {
    return dateStr;
  }
  
  // Try DD/MM/YYYY format
  parts = dateStr.split('/');
  if (parts.length === 3) {
    var day = parseInt(parts[0], 10);
    var month = parseInt(parts[1], 10);
    var year = parseInt(parts[2], 10);
    if (!isNaN(day) && !isNaN(month) && !isNaN(year) && 
        day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
      return String(year) + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
  }
  
  return null;
}

// Parse time input and convert to 24-hour format
function parseTimeInput(timeStr, is24Hour) {
  if (!timeStr) return null;
  
  // Remove spaces and convert to uppercase
  var originalStr = timeStr.trim();
  timeStr = originalStr.toUpperCase();
  
  // Replace placeholder H's and M's with empty and clean up
  timeStr = timeStr.replace(/^H+:M+$/, ''); // Remove if only placeholders
  timeStr = timeStr.replace(/H/g, ''); // Remove H placeholders
  timeStr = timeStr.replace(/M/g, ''); // Remove M placeholders
  
  // Try HH:MM AM/PM format first (12-hour with AM/PM indicator)
  var match12 = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|A|P|A\.M\.|P\.M\.)$/);
  if (match12) {
    var h = parseInt(match12[1], 10);
    var m = parseInt(match12[2], 10);
    var isPM = match12[3].toUpperCase().includes('P');
    
    if (!isNaN(h) && !isNaN(m) && h >= 1 && h <= 12 && m >= 0 && m <= 59) {
      if (isPM && h !== 12) h += 12;
      if (!isPM && h === 12) h = 0;
      return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    }
  }
  
  // If already in HH:MM format (no AM/PM)
  if (timeStr.match(/^\d{1,2}:\d{2}$/)) {
    var parts = timeStr.split(':');
    var hours = parseInt(parts[0], 10);
    var minutes = parseInt(parts[1], 10);
    
    if (isNaN(hours) || isNaN(minutes)) return null;
    
    if (is24Hour) {
      // Already 24-hour, just validate
      if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
        return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
      }
    } else {
      // 12-hour input without AM/PM - assume current format based on button selection
      // If user selected 12H but entered 24H format, try to convert
      if (hours >= 13 && hours <= 23) {
        // Looks like 24-hour format entered in 12H mode - convert
        hours = hours - 12;
        return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
      } else if (hours >= 1 && hours <= 12 && minutes >= 0 && minutes <= 59) {
        // Valid 12-hour format
        return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0');
      }
    }
  }
  
  return null;
}

// ========== DATE PICKER (Calendar Style) ==========
var calendarMonth = new Date().getMonth(); // 0-11
var calendarYear = new Date().getFullYear();
var selectedDay = new Date().getDate();

function showDatePicker() {
  // Get current date from input field, display, or use current date
  var dateInput = document.getElementById('edit-date-input');
  var dateTextEl = document.getElementById('current-date-text');
  var dateStr = (dateInput && dateInput.value) ? dateInput.value : (dateTextEl ? dateTextEl.textContent : '');
  
  var currentDate = new Date();
  
  // Try to parse date from input/display (DD-MM-YYYY format)
  if (dateStr) {
    var parts = dateStr.split('-');
    if (parts.length === 3) {
      var day = parseInt(parts[0], 10);
      var month = parseInt(parts[1], 10) - 1; // Month is 0-indexed
      var year = parseInt(parts[2], 10);
      if (!isNaN(day) && !isNaN(month) && !isNaN(year) && 
          day >= 1 && day <= 31 && month >= 0 && month <= 11 && year >= 2000 && year <= 2100) {
        currentDate = new Date(year, month, day);
      }
    }
  }
  
  calendarMonth = currentDate.getMonth();
  calendarYear = currentDate.getFullYear();
  selectedDay = currentDate.getDate();
  
  // Render calendar
  renderCalendar();
  
  // Show modal
  var modalEl = document.getElementById('date-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function renderCalendar() {
  // Update month/year header
  var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                    'July', 'August', 'September', 'October', 'November', 'December'];
  var headerEl = document.getElementById('calendar-month-year');
  if (headerEl) {
    headerEl.textContent = monthNames[calendarMonth] + ' ' + calendarYear;
  }
  
  // Calculate days in month
  var firstDay = new Date(calendarYear, calendarMonth, 1).getDay(); // 0=Sunday
  var daysInMonth = new Date(calendarYear, calendarMonth + 1, 0).getDate();
  
  // Render calendar days
  var calendarDays = document.getElementById('calendar-days');
  if (!calendarDays) return;
  
  calendarDays.innerHTML = '';
  
  // Add empty cells for days before first day of month
  for (var i = 0; i < firstDay; i++) {
    var emptyCell = document.createElement('div');
    emptyCell.style.padding = '8px';
    calendarDays.appendChild(emptyCell);
  }
  
  // Add day cells
  for (var day = 1; day <= daysInMonth; day++) {
    var dayCell = document.createElement('div');
    dayCell.textContent = day;
    dayCell.style.padding = '8px';
    dayCell.style.textAlign = 'center';
    dayCell.style.color = 'white';
    dayCell.style.cursor = 'pointer';
    dayCell.style.borderRadius = '6px';
    dayCell.style.fontSize = '14px';
    dayCell.style.fontWeight = 'bold';
    dayCell.style.transition = 'all 0.2s';
    
    // Highlight selected day
    if (day === selectedDay) {
      dayCell.style.background = '#3b82f6';
    } else {
      dayCell.style.background = 'rgba(59, 130, 246, 0.2)';
    }
    
    // Add hover effect
    dayCell.onmouseover = function() {
      if (this.style.background !== 'rgb(59, 130, 246)') {
        this.style.background = 'rgba(59, 130, 246, 0.4)';
      }
    };
    dayCell.onmouseout = function() {
      var dayNum = parseInt(this.textContent);
      if (dayNum !== selectedDay) {
        this.style.background = 'rgba(59, 130, 246, 0.2)';
      }
    };
    
    // Add click handler
    (function(d) {
      dayCell.onclick = function() {
        selectedDay = d;
        renderCalendar(); // Re-render to update selection
      };
    })(day);
    
    calendarDays.appendChild(dayCell);
  }
}

function prevMonth() {
  calendarMonth--;
  if (calendarMonth < 0) {
    calendarMonth = 11;
    calendarYear--;
  }
  renderCalendar();
}

function nextMonth() {
  calendarMonth++;
  if (calendarMonth > 11) {
    calendarMonth = 0;
    calendarYear++;
  }
  renderCalendar();
}

function cancelDatePicker() {
  var modalEl = document.getElementById('date-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyDatePicker() {
  var dayStr = String(selectedDay).padStart(2, '0');
  var monthStr = String(calendarMonth + 1).padStart(2, '0');
  var dateStr = dayStr + '-' + monthStr + '-' + calendarYear;
  
  // Update input field (new compact design)
  var dateInput = document.getElementById('edit-date-input');
  if (dateInput) {
    dateInput.value = dateStr;
  }
  // Mark as user-edited so async init can't overwrite.
  window._editDateTimeDirty = true;
  
  // Also update display element (for compatibility)
  var displayEl = document.getElementById('current-date-text');
  if (displayEl) {
    displayEl.textContent = dateStr;
  }
  
  // Update picker variables
  datePickerDay = selectedDay;
  datePickerMonth = calendarMonth;
  datePickerYear = calendarYear;
  
  cancelDatePicker();
}

// ========== TIME PICKER (Simple Input Style) ==========
function showTimePicker() {
  // Get current time from input field, display, or use current time
  var timeInput = document.getElementById('edit-time-input');
  var timeTextEl = document.getElementById('current-time-text');
  var timeStr = (timeInput && timeInput.value) ? timeInput.value : (timeTextEl ? timeTextEl.textContent : '');
  
  var currentTime = new Date();
  var hour = currentTime.getHours();
  var minute = currentTime.getMinutes();
  
  // Try to parse time from input/display (HH:MM format)
  if (timeStr) {
    var parts = timeStr.split(':');
    if (parts.length === 2) {
      var h = parseInt(parts[0], 10);
      var m = parseInt(parts[1], 10);
      if (!isNaN(h) && !isNaN(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
        hour = h;
        minute = m;
      }
    }
  }
  
  // Set input values
  var hourInput = document.getElementById('time-hour-input');
  var minuteInput = document.getElementById('time-minute-input');
  if (hourInput) hourInput.value = hour;
  if (minuteInput) minuteInput.value = minute;
  
  // Show modal
  var modalEl = document.getElementById('time-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'flex';
    modalEl.classList.add('active');
  }
  
  if (typeof hideOSK === 'function') {
    hideOSK();
  }
  
  if (window.lucide && typeof lucide.createIcons === 'function') {
    lucide.createIcons();
  }
}

function setQuickTime(hour, minute) {
  var hourInput = document.getElementById('time-hour-input');
  var minuteInput = document.getElementById('time-minute-input');
  if (hourInput) hourInput.value = hour;
  if (minuteInput) minuteInput.value = minute;
}

function cancelTimePicker() {
  var modalEl = document.getElementById('time-picker-modal');
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('active');
  }
}

function applyTimePicker() {
  var hourInput = document.getElementById('time-hour-input');
  var minuteInput = document.getElementById('time-minute-input');
  
  if (hourInput && minuteInput) {
    var hour = parseInt(hourInput.value) || 0;
    var minute = parseInt(minuteInput.value) || 0;
    
    // Validate and clamp values
    if (hour < 0) hour = 0;
    if (hour > 23) hour = 23;
    if (minute < 0) minute = 0;
    if (minute > 59) minute = 59;
    
    var hourStr = String(hour).padStart(2, '0');
    var minuteStr = String(minute).padStart(2, '0');
    var timeStr = hourStr + ':' + minuteStr;
    
    // Update input field (new compact design)
    var timeInput = document.getElementById('edit-time-input');
    if (timeInput) {
      timeInput.value = timeStr;
    }
    // Mark as user-edited so async init can't overwrite.
    window._editDateTimeDirty = true;
    
    // Also update display element (for compatibility)
    var displayEl = document.getElementById('current-time-text');
    if (displayEl) {
      displayEl.textContent = timeStr;
    }
    
    // Update picker variables
    timePickerHour = hour;
    timePickerMinute = minute;
  }
  
  cancelTimePicker();
}

async function applyEditDateTime() {
  // RBAC: Check permission to edit date/time (admin and factory only)
      var role = getCurrentRole();
  if (!canAccess(role, 'edit-datetime')) {
    var errorMsg = 'You do not have permission to edit date and time. Only admin can access this feature.';
    if (typeof showToast === 'function') {
      showToast(errorMsg, 'error');
    } else if (typeof showModal === 'function') {
      showModal(errorMsg);
    } else {
      alert(errorMsg);
    }
    return;
  }

  // FIX: Get date and time from input fields (new compact design) or fallback to display elements
  var dateInput = document.getElementById('edit-date-input');
  var timeInput = document.getElementById('edit-time-input');
  var dateTextEl = document.getElementById('current-date-text');
  var timeTextEl = document.getElementById('current-time-text');

  // Prefer input fields, fallback to display elements
  var dateText = (dateInput && dateInput.value) ? dateInput.value.trim() : (dateTextEl ? dateTextEl.textContent.trim() : '');
  var timeText = (timeInput && timeInput.value) ? timeInput.value.trim() : (timeTextEl ? timeTextEl.textContent.trim() : '');

  if (!dateText || !timeText) {
    var msg = 'Enter valid date and time';
    if (typeof showModal === 'function') {
      showModal(msg);
    } else if (typeof showToast === 'function') {
      showToast(msg, 'info');
    } else {
      alert(msg);
    }
    return;
  }
  
  // Convert DD-MM-YYYY to YYYY-MM-DD
  var dateParts = dateText.split('-');
  if (dateParts.length !== 3) {
    var msg = 'Enter valid date and time';
    if (typeof showModal === 'function') {
      showModal(msg);
    } else if (typeof showToast === 'function') {
      showToast(msg, 'info');
    } else {
      alert(msg);
    }
    return;
  }
  var datePart = dateParts[2] + '-' + dateParts[1] + '-' + dateParts[0]; // YYYY-MM-DD
  var timePart;
  if (editUse24Hour) {
    timePart = parseTimeInput(timeText, true);
  } else {
    var toParse = timeText.trim();
    if (!/AM|PM|A\.M\.|P\.M\./i.test(toParse) && typeof editAmPm !== 'undefined') {
      toParse = toParse + ' ' + editAmPm;
    }
    timePart = parseTimeInput(toParse, false);
  }
  if (!timePart || !timePart.match(/^\d{2}:\d{2}$/)) {
    var timeMsg = 'Enter valid date and time';
    if (typeof showModal === 'function') {
      showModal(timeMsg);
    } else if (typeof showToast === 'function') {
      showToast(timeMsg, 'info');
    } else {
      alert(timeMsg);
    }
    return;
  }

  // Combine into ISO format (YYYY-MM-DDTHH:MM:SS)
  var datetimeValue = datePart + 'T' + timePart + ':00';

  try {
    var roleHeader = getCurrentRole();
    var res = await fetchWithTimeout('/api/set_device_datetime', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Role': roleHeader || ''
      },
      body: JSON.stringify({ datetime: datetimeValue })
    }, 10000); // 10s timeout for datetime setting

    var data = null;
    try {
      var responseText = await res.text();
      if (responseText) {
        data = JSON.parse(responseText);
      }
    } catch (jsonErr) {
      console.error('[EditDateTime] Failed to parse JSON response:', jsonErr);
      data = { error: 'Invalid server response' };
    }

    if (!res.ok) {
      var err = (data && (data.detail || data.error || data.message)) || ('HTTP ' + res.status);
      console.error('[EditDateTime] API error response:', {
        status: res.status,
        statusText: res.statusText,
        data: data
      });
      // If user entered an invalid date/time, show a clear input error (do NOT convert to generic system error).
      var errLower = String(err || '').toLowerCase();
      if (
        errLower.includes('invalid datetime') ||
        errLower.includes('invalid date') ||
        errLower.includes('invalid time') ||
        errLower.includes('missing datetime')
      ) {
        if (typeof showModal === 'function') {
          showModal('Enter valid date and time');
        } else if (typeof showToast === 'function') {
          // Use non-error type to avoid error-code conversion.
          showToast('Enter valid date and time', 'info');
        } else {
          alert('Enter valid date and time');
        }
        return;
      }
      if (typeof showToast === 'function') {
        showToast('Failed to set date/time: ' + err, 'error');
      } else if (typeof showModal === 'function') {
        showModal('Failed to set date/time: ' + err);
      } else {
        alert('Failed: ' + err);
      }
      return;
    }
    
    // Check if response indicates success
    if (data && data.ok === false) {
      var err = data.error || data.detail || data.message || 'Unknown error';
      console.error('[EditDateTime] API returned ok=false:', data);
      // If user entered an invalid date/time, show a clear input error (do NOT convert to generic system error).
      var errLower = String(err || '').toLowerCase();
      if (
        errLower.includes('invalid datetime') ||
        errLower.includes('invalid date') ||
        errLower.includes('invalid time') ||
        errLower.includes('missing datetime')
      ) {
        if (typeof showModal === 'function') {
          showModal('Enter valid date and time');
        } else if (typeof showToast === 'function') {
          showToast('Enter valid date and time', 'info');
        } else {
          alert('Enter valid date and time');
        }
        return;
      }
      if (typeof showToast === 'function') {
        showToast('Failed to set date/time: ' + err, 'error');
      } else if (typeof showModal === 'function') {
        showModal('Failed to set date/time: ' + err);
      } else {
        alert('Failed: ' + err);
      }
      return;
    }

    // Success
    if (typeof showToast === 'function') {
      showToast('Date/time set successfully', 'success');
    } else if (typeof showModal === 'function') {
      showModal('Date/time set successfully');
    } else {
      alert('Date/time set successfully');
    }

    // Show restart-required modal overlay if backend confirms success
    if (data && data.ok === true) {
      var restartModal = document.getElementById("restartModal");
      if (restartModal) {
        restartModal.style.display = "flex";
        document.body.style.pointerEvents = "none";
      }
    }

    // Update clock display immediately (re-fetch so new RTC time is shown)
    if (typeof syncClockFromApi === 'function') {
      syncClockFromApi();
    }

    // Navigate back to settings after a short delay
    setTimeout(function() {
      if (typeof navigateTo === 'function') {
        navigateTo('settings');
      }
    }, 500);
    } catch (e) {
    console.error('[EditDateTime] Exception:', e);
    console.error('[EditDateTime] Stack:', e.stack);
    
    // FIX: Show more specific error messages
    var errMsg;
    if (e.name === 'AbortError' || (e.message && e.message.includes('timeout'))) {
      errMsg = 'Request timed out. Please check your network connection and try again.';
    } else if (e.message && (e.message.includes('NetworkError') || e.message.includes('Failed to fetch'))) {
      errMsg = 'error. Please try again.';
    } else if (e.message && e.message.includes('JSON')) {
      errMsg = 'Please try again.';
    } else {
      errMsg = 'Failed to set date/time: ' + (e.message || 'Unknown error');
    }
    
    // If the backend rejected invalid input, show a clear validation message (avoid generic system error conversion).
    var errLower = String(errMsg || '').toLowerCase();
    if (errLower.includes('invalid datetime') || errLower.includes('invalid date') || errLower.includes('invalid time')) {
      if (typeof showModal === 'function') {
        showModal('Enter valid date and time');
      } else if (typeof showToast === 'function') {
        showToast('Enter valid date and time', 'info');
      } else {
        alert('Enter valid date and time');
      }
      return;
    }
    
    if (typeof showToast === 'function') {
      showToast(errMsg, 'error');
    } else if (typeof showModal === 'function') {
      showModal(errMsg);
    } else {
      alert(errMsg);
    }
              }
}

window.applyEditDateTime = applyEditDateTime;
window.showDatePicker = showDatePicker;
window.cancelDatePicker = cancelDatePicker;
window.applyDatePicker = applyDatePicker;
window.prevMonth = prevMonth;
window.nextMonth = nextMonth;
window.showTimePicker = showTimePicker;
window.cancelTimePicker = cancelTimePicker;
window.applyTimePicker = applyTimePicker;
window.setQuickTime = setQuickTime;

})();
