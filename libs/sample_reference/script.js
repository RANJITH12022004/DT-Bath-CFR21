// Disable zoom shortcuts
document.addEventListener('wheel', function (e) { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
document.addEventListener('keydown', function (e) {
    if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || e.key === '=')) e.preventDefault();
});
// Block Chromium default context menu (Copy, etc.) on long-press / right-click
document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

// ===== GLOBAL STATE =====
const QUICK_TEST_LAST_VALUES_KEY = 'quickTestLastValues';
let currentShape = 'round';
let currentTest = null;
let currentParamConfig = null;
let paramTolerances = {};
let previousPage = 'home'; // Track previous page
let lastTestRunRecipe = null; // Last test run data for report
let lastTestRunMeasurements = null; // Accumulated measurements during test (for report and abort save)
let currentReportId = null; // Report ID when viewing report preview (for export)
let currentReportData = null; // Full report object for serial print (A4/thermal)
let currentReportRecipe = null; // Recipe from current report (for Preview/Print Recipe)
let customUnitConversionFactor = null; // Conversion factor for user-defined unit to Newton
let pendingRecipeToLoad = null; // Recipe to load after batch number is entered
let loadRecipeRunPending = false; // True when backoff modal was shown from Load Recipe flow
let editingRecipeId = null; // Recipe ID when editing (PUT instead of POST on save)
let lastDisplayedRecipes = null; // Cached recipe list from displayRecipeList for faster Load
let recipeListLoadOnly = false; // True when opened via Load Recipe (hide Create/Edit/Delete)
let hardwareEventSource = null; // SSE: ESP lines ERR,BO* / ERR,LC* → unified backoff error modal + recovery
var _espBackoffModalOpen = false; // Dedupe modal while user has not dismissed backoff error
var _navigatingAfterAbort = false; // Skip operation-running check when navigating after user chose Abort
var _navigatingAfterSave = false;   // Skip operation-running check when navigating after factory/member save
var testRunStartTime = 0; // Set at start of runHardnessTestLoop for duration calculation

// ===== OPERATION RUNNING (test / validation / calibration) =====
function isOperationRunning() {
    var testRunning = (typeof testRunActive !== 'undefined' && testRunActive);
    var valCalRunning = (typeof isValidationOrCalibrationRunning === 'function' && isValidationOrCalibrationRunning());
    if (testRunning || valCalRunning) {
        console.log('[DEBUG] isOperationRunning: testRunActive=', testRunning, ', valCalRunning=', valCalRunning);
    }
    if (testRunning) return true;
    if (valCalRunning) return true;
    return false;
}

function isNavigationLocked() {
    return !!(typeof testRunActive !== 'undefined' && testRunActive);
}

function lockNavigation() {
    if (typeof testRunActive !== 'undefined') testRunActive = true;
    var sidebar = document.querySelector('aside.sidebar');
    if (sidebar) sidebar.classList.add('sidebar-locked');
}

function unlockNavigation() {
    if (typeof testRunActive !== 'undefined') testRunActive = false;
    var sidebar = document.querySelector('aside.sidebar');
    if (sidebar) sidebar.classList.remove('sidebar-locked');
}

function doAbortAndNavigate(target) {
    if (typeof testRunActive !== 'undefined' && testRunActive) {
        testRunAborted = true;
        testRunActive = false;
        unlockNavigation();
        testRunPaused = false;
        apiRequest('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
    } else if (typeof isValidationOrCalibrationRunning === 'function' && isValidationOrCalibrationRunning()) {
        if (typeof loadValidationRunning !== 'undefined' && loadValidationRunning) {
            if (typeof stopLoadValidationSSE === 'function') stopLoadValidationSSE();
            loadValidationRunning = false;
            fetch('/api/hardware/validation/load/stop', { method: 'POST' }).catch(function () {});
        } else if ((typeof distanceValidationRunning !== 'undefined' && distanceValidationRunning) ||
            (typeof distanceCalibRunning !== 'undefined' && distanceCalibRunning)) {
            (typeof apiRequest === 'function' ? apiRequest : fetch)('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
            if (typeof clearValidationCalibrationRunning === 'function') clearValidationCalibrationRunning();
        } else if (typeof clearValidationCalibrationRunning === 'function') {
            clearValidationCalibrationRunning();
        }
    }
    _navigatingAfterAbort = true;
    if (target === 'back') {
        goBack();
    } else if (target === 'logout') {
        logout();
    } else {
        goToPage(target);
    }
}

/** After user dismisses ESP backoff modal: stop val/cal, unlock UI, open report or home. */
function completeEspBackoffDismissal(reportId, recipeForUi) {
    window._espBackoffModalOpen = false;
    if (typeof window !== 'undefined') {
        window._userAbortedOperation = false;
    }
    if (typeof unlockNavigation === 'function') {
        unlockNavigation();
    }
    if (typeof abortValidationCalibrationForHardwareError === 'function') {
        abortValidationCalibrationForHardwareError();
    }
    var r = recipeForUi;
    if (r) {
        var btnAction = document.getElementById('btn-test-start-abort');
        if (btnAction) {
            btnAction.dataset.state = 'start';
            btnAction.className = 'btn-ctrl start header-btn';
            btnAction.innerHTML = '<div class="ctrl-icon">▶</div><span>START</span>';
            var sampleSize = parseInt(r.sampleSize, 10) || 10;
            if (typeof updateTestRunSampleProgress === 'function') {
                updateTestRunSampleProgress(0, sampleSize);
            }
        }
    }
    if (reportId && typeof openReportPreview === 'function') {
        openReportPreview(reportId);
    } else if (typeof goToPage === 'function') {
        _navigatingAfterAbort = true;
        goToPage('home');
    }
    if (typeof currentTest !== 'undefined' && currentTest === 'quick' && typeof refreshQuickTestForm === 'function') {
        refreshQuickTestForm();
    }
}

// ===== HARDWARE STREAM (ESP error popups) =====
function initHardwareStream() {
    if (hardwareEventSource && (hardwareEventSource.readyState === EventSource.OPEN || hardwareEventSource.readyState === EventSource.CONNECTING))
        return;
    if (hardwareEventSource) {
        try { hardwareEventSource.close(); } catch (e) {}
        hardwareEventSource = null;
    }
    try {
        hardwareEventSource = new EventSource('/api/hardware/stream');
        hardwareEventSource.onmessage = function (event) {
            try {
                var data = JSON.parse(event.data);
                if (data.type !== 'data' || !data.line) return;
                var line = (String(data.line)).trim().toUpperCase();
                var isEspBackoffError =
                    line === 'ERR,BO*' ||
                    line.indexOf('ERR,BO') !== -1 ||
                    line === 'ERR,LC*' ||
                    line.indexOf('ERR,LC') !== -1;
                if (isEspBackoffError) {
                    if (window._espBackoffModalOpen) {
                        return;
                    }
                    window._espBackoffModalOpen = true;
                    var backoffModalTitle = 'Backoff error';
                    var backoffModalMessage =
                        'A hardware backoff error was reported by the instrument.\n\nPlease contact service for assistance.';
                    (typeof apiRequest === 'function' ? apiRequest : fetch)('/api/hardware/test/home', { method: 'POST' }).catch(function () {});

                    var hadActiveTest =
                        typeof testRunActive !== 'undefined' &&
                        testRunActive &&
                        typeof lastTestRunRecipe !== 'undefined' &&
                        lastTestRunRecipe;

                    function showBackoffModalWithReportId(rid, recipeSnap) {
                        showModal(
                            backoffModalTitle,
                            backoffModalMessage,
                            function () {
                                completeEspBackoffDismissal(rid, recipeSnap);
                            },
                            false,
                            false,
                            'OK'
                        );
                    }

                    if (hadActiveTest) {
                        testRunAborted = true;
                        testRunActive = false;
                        backoffAbortHandled = true;
                        var r = lastTestRunRecipe;
                        var recipeSnap = r;
                        var meas = lastTestRunMeasurements || {
                            Thickness: [],
                            Diameter: [],
                            Width: [],
                            Length: [],
                            Hardness: [],
                            Weight: []
                        };
                        var stats = {};
                        ['Thickness', 'Diameter', 'Width', 'Length', 'Hardness', 'Weight'].forEach(function (key) {
                            if (meas[key] && meas[key].length > 0) stats[key] = computeParamStatistics(meas[key]);
                        });
                        if (typeof saveReport === 'function') {
                            saveReport({
                                type: 'test',
                                name: (r.productName || 'Test') + ' - ' + (r.batchNumber || r.batch || 'N/A'),
                                productName: r.productName,
                                batchNumber: r.batchNumber || r.batch,
                                shape: r.shape,
                                parameters: r.parameters,
                                parameterSamples: r.parameterSamples || {},
                                unit: r.unit,
                                conversionFactor: r.conversionFactor,
                                sampleSize: r.sampleSize,
                                mode: r.mode || 'auto',
                                status: 'aborted',
                                measurements: meas,
                                statistics: stats,
                                parameterTolerances: r.parameterTolerances || {},
                                distanceUnit: r.distanceUnit,
                                weightUnit: r.weightUnit,
                                isQuickTest: (typeof currentTest !== 'undefined' && currentTest === 'quick'),
                                testStartTime: testRunStartTime ? new Date(testRunStartTime).toISOString() : undefined,
                                testEndTime: new Date().toISOString(),
                                durationSeconds: testRunStartTime
                                    ? Math.floor((Date.now() - testRunStartTime) / 1000)
                                    : undefined
                            })
                                .then(function (reportId) {
                                    if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
                                    showBackoffModalWithReportId(reportId, recipeSnap);
                                })
                                .catch(function () {
                                    if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
                                    showBackoffModalWithReportId(null, recipeSnap);
                                });
                        } else {
                            if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
                            showBackoffModalWithReportId(null, recipeSnap);
                        }
                    } else {
                        showBackoffModalWithReportId(null, null);
                    }
                }
            } catch (e) {}
        };
        hardwareEventSource.onerror = function () { /* EventSource auto-reconnects */ };
    } catch (e) {
        console.warn('Hardware stream init failed:', e);
    }
}

// ===== PAGE NAVIGATION =====
function sendTareOncePerSession(reason) {
    try {
        const key = '__tareSentThisSession';
        if (typeof sessionStorage !== 'undefined') {
            if (sessionStorage.getItem(key) === '1') return;
            sessionStorage.setItem(key, '1');
        } else {
            if (window.__tareSentThisSession) return;
            window.__tareSentThisSession = true;
        }
    } catch (e) {
        if (window.__tareSentThisSession) return;
        window.__tareSentThisSession = true;
    }

    try {
        fetch('/api/hardware/calibrate/tare', { method: 'POST' }).catch(function () { });
    } catch (e) {
        // Best-effort: never block navigation/login
    }
}

function goToPage(pageName) {
    if (isNavigationLocked()) {
        // Allow staying on test-run; block other navigation while test is active
        const activePage = document.querySelector('.page.active');
        const currentId = activePage ? activePage.id : '';
        if (pageName !== 'test-run' && currentId === 'page-test-run') {
            alert('Test is running. Please complete or abort the test before navigating.');
            return;
        }
    }

    // Special handling for login screen
    const loginScreen = document.getElementById('page-login');
    const appContainer = document.querySelector('.app-container');

    if (pageName === 'login') {
        if (loginScreen) {
            loginScreen.style.display = 'flex';
            loginScreen.classList.add('active');
        }
        if (appContainer) appContainer.style.display = 'none';
        if (typeof updateFactorySettingsDisplays === 'function') updateFactorySettingsDisplays();
        return;
    }

    if (_navigatingAfterAbort) {
        _navigatingAfterAbort = false;
    } else if (_navigatingAfterSave) {
        _navigatingAfterSave = false;
    } else if (window._navigatingAfterValidationCalibration) {
        // Bypass operation check when navigating after validation/calibration
        window._navigatingAfterValidationCalibration = false;
        console.log('[DEBUG] goToPage: bypassing operation check for post-validation navigation');
    } else if (isOperationRunning()) {
        console.log('[DEBUG] goToPage blocked: operation running, target page:', pageName);
        showAbortExitConfirmModal(pageName);
        return;
    }
    console.log('[DEBUG] goToPage: navigating to', pageName);

    {
        // Check navigation access using RBAC
        if (typeof checkNavigationAccess === 'function') {
            var skipRbac =
                pageName === 'report-preview' &&
                typeof window !== 'undefined' &&
                window._bypassReportPreviewRbacOnce;
            if (skipRbac) {
                window._bypassReportPreviewRbacOnce = false;
            } else if (!checkNavigationAccess(pageName)) {
                alert('You do not have permission to access this page.');
                return;
            }
        }
        
        if (loginScreen) {
            loginScreen.style.display = 'none';
            loginScreen.classList.remove('active');
        }
        if (appContainer) appContainer.style.display = 'flex';
        initHardwareStream();
    }

    // Session-scoped auto-tare on key entry points
    if (pageName === 'validate' || pageName === 'quick-test' || (pageName === 'manage-recipes' && recipeListLoadOnly)) {
        if (typeof sendTareOncePerSession === 'function') sendTareOncePerSession(pageName);
    }

    // Cleanup validation state when navigating away from load-validation
    const activePage = document.querySelector('.page.active');
    if (activePage && activePage.id === 'page-load-validation' && pageName !== 'load-validation') {
        if (typeof stopLoadValidationSSE === 'function') stopLoadValidationSSE();
        if (typeof fetch === 'function') fetch('/api/hardware/validation/load/stop', { method: 'POST' }).catch(function () {});
    }

    // Remove active class from all pages
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });

    // Add active class to selected page
    const targetPage = document.getElementById(`page-${pageName}`);
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // Update navigation active state
    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.remove('active');
    });

    const activeNav = document.querySelector(`[data-page="${pageName}"]`);
    if (activeNav && !activeNav.classList.contains('logout-btn')) {
        activeNav.classList.add('active');
    }

    // Update page title
    const titles = {
        'home': 'Tablet Hardness Tester',
        'validate': 'Validation & Calibration',
        'validate-type-select': 'Select Validation Type',
        'load-validation': 'Load Validation',
        'distance-validation': 'Distance Validation',
        'distance-validation-result': 'Distance Validation Result',
        'calibration-type-select': 'Select Calibration Type',
        'load-calibration': 'Load Calibration',
        'distance-zero-calibration': 'Distance Calibration',
        'reports': 'Reports',
        'view-recipes': 'View Recipe',
        'recipe-print-preview': 'Recipe Print',
        'report-preview': 'Report Preview',
        'settings': 'Settings',
        'shape-selection': 'Test Setup',
        'quick-test': 'New Recipe',
        'manage-recipes': 'Manage Recipes',
        'param-tolerance': 'Tolerance',
        'datetime': 'Date and Time',
        'user-profile': 'User Profile',
        'manage-members': 'Manage Members',
        'add-member': 'Add New Member',
        'test-run': 'Test Run',
        'factory-settings': 'Factory Settings',
        'factory-support': 'Factory Support',
        'factory-support-result': 'Factory Support'
    };

    const titleElement = document.querySelector('.page-title');
    if (titleElement) {
        titleElement.style.display = 'block';
        if (titles[pageName]) {
            titleElement.textContent = titles[pageName];
        }
    }

    // Toggle Logo/Back Button
    const logoEl = document.getElementById('header-logo');
    const backBtnEl = document.getElementById('header-back-btn');

    if (pageName === 'home') {
        if (logoEl) logoEl.style.display = 'block';
        if (backBtnEl) backBtnEl.style.display = 'none';
        previousPage = 'home';
    } else if (pageName === 'test-run') {
        // Hide back arrow specifically on Test Run page
        if (logoEl) logoEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'none';
    } else {
        if (logoEl) logoEl.style.display = 'none';
        if (backBtnEl) backBtnEl.style.display = 'block';
        // Set previous page logic if needed, for now mostly goes back to home or sequence
    }

    // Auto-load recipe list when navigating to manage-recipes page
    if (pageName === 'manage-recipes') {
        setTimeout(() => {
            if (typeof displayRecipeList === 'function') {
                displayRecipeList();
            }
            // Load Recipe flow: hide Create; Manage Recipe flow: show Create
            const createBtn = document.querySelector('#page-manage-recipes .btn-create-recipe');
            const titleEl = document.querySelector('.page-title');
            if (recipeListLoadOnly) {
                if (createBtn) createBtn.style.display = 'none';
                if (titleEl) titleEl.textContent = 'Load Recipe';
            } else {
                if (createBtn) createBtn.style.display = '';
                if (titleEl && titles[pageName]) titleEl.textContent = titles[pageName];
            }
        }, 50);
    }

    // Auto-load member list when navigating to manage-members page
    if (pageName === 'manage-members') {
        setTimeout(() => {
            if (typeof displayMembersList === 'function') {
                displayMembersList();
            }
        }, 50);
    }

    // Auto-load datetime when navigating to datetime page
    if (pageName === 'datetime') {
        setTimeout(() => {
            if (typeof initializeDatetime === 'function') {
                initializeDatetime();
            }
        }, 50);
    }

    // Auto-load reports when navigating to reports page
    if (pageName === 'reports') {
        setTimeout(() => {
            if (typeof loadReports === 'function') {
                loadReports(null);
            }
        }, 50);
    }

    // Auto-load view recipes when navigating to view-recipes page
    if (pageName === 'view-recipes') {
        setTimeout(() => {
            if (typeof loadViewRecipes === 'function') {
                loadViewRecipes();
            }
        }, 50);
    }

    // Sync parameter samples max when entering quick-test
    if (pageName === 'quick-test') {
        setTimeout(() => {
            if (typeof syncParameterSamplesMax === 'function') {
                syncParameterSamplesMax();
            }
        }, 50);
    }

    // Initialize factory settings when navigating to factory-settings page
    if (pageName === 'factory-settings') {
        setTimeout(() => {
            if (typeof initFactorySettings === 'function') {
                initFactorySettings();
            }
        }, 50);
    }

    if (pageName === 'factory-support') {
        setTimeout(() => {
            if (typeof initFactorySupportPage === 'function') {
                initFactorySupportPage();
            }
        }, 50);
    }

    if (pageName === 'factory-support-result') {
        setTimeout(() => {
            if (typeof initFactorySupportResultPage === 'function') {
                initFactorySupportResultPage();
            }
        }, 50);
    }
}

function goBack() {
    if (_navigatingAfterAbort) {
        _navigatingAfterAbort = false;
    } else if (isOperationRunning()) {
        showAbortExitConfirmModal('back');
        return;
    }

    const activePage = document.querySelector('.page.active');
    const pageId = activePage ? activePage.id : '';

    if (pageId === 'page-quick-test') {
        goToPage('shape-selection');
    } else if (pageId === 'page-shape-selection') {
        if (currentTest === 'create-recipe') {
            recipeListLoadOnly = false;
            goToPage('manage-recipes');
        } else {
            goToPage('home');
        }
    } else if (pageId === 'page-report-preview') {
        goToPage('reports');
    } else if (pageId === 'page-recipe-print-preview') {
        goToPage('view-recipes');
    } else if (pageId === 'page-view-recipes') {
        goToPage('reports');
    } else if (pageId === 'page-factory-settings') {
        goToPage('settings');
    } else if (pageId === 'page-factory-support-result') {
        goToPage('factory-support');
    } else if (pageId === 'page-factory-support') {
        goToPage('settings');
    } else {
        goToPage('home');
    }
}

// ===== NAVIGATION CLICK HANDLERS =====
document.addEventListener('DOMContentLoaded', function () {
    // Try to restore currentUser from localStorage
    try {
        const storedUser = localStorage.getItem('currentUser');
        if (storedUser) {
            const user = JSON.parse(storedUser);
            currentUser = user;
            window.currentUser = user;
            // Update UI based on restored user
            if (typeof updateUIForUser === 'function') {
                setTimeout(() => updateUIForUser(), 100);
            }
        }
    } catch (e) {
        console.warn('Failed to restore currentUser from localStorage:', e);
    }
    
    // Start at login screen
    goToPage('login');

    // Setup navigation
    document.querySelectorAll('.nav-item').forEach(item => {
        item.addEventListener('click', function () {
            const page = this.getAttribute('data-page');

            if (isNavigationLocked()) {
                alert('Test is running. Please complete or abort the test before navigating.');
                return;
            }

            if (page === 'logout') {
                if (isOperationRunning()) {
                    showAbortExitConfirmModal('logout');
                } else {
                    logout();
                }
            } else if (page) {
                if (page === 'manage-recipes') recipeListLoadOnly = false;
                goToPage(page);
            }
        });
    });

    // Quick Test per-parameter sample size listeners
    const quickTestSampleIds = ['param-samples-thickness', 'param-samples-diameter', 'param-samples-width', 'param-samples-length', 'param-samples-hardness', 'param-samples-weight'];
    quickTestSampleIds.forEach(function (id) {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', function () {
                if (typeof enforceQuickTestSampleSelectionRules === 'function') {
                    enforceQuickTestSampleSelectionRules();
                }
            });
        }
    });

    // Update time and date
    updateDateTime();
    setInterval(updateDateTime, 1000);

    // Setup mode radio buttons to show/hide delay
    const modeRadios = document.querySelectorAll('input[name="mode"]');
    modeRadios.forEach(radio => {
        radio.addEventListener('change', function () {
            const delayGroup = document.getElementById('delay-group');
            if (delayGroup) {
                delayGroup.style.display = this.value === 'auto' ? 'block' : 'none';
            }
        });
    });
});

// Hidden hardcoded factory user - not in members list, cannot be modified or deleted
var FACTORY_USERNAME = 'RLERLT';
var FACTORY_PASSWORD = 'Rahul';
var FACTORY_USER = { id: 0, name: 'Factory', username: FACTORY_USERNAME, role: 'Factory' };

// ===== LOGIN & AUTHENTICATION =====
async function login() {
    const uidEl = document.getElementById('login-uid');
    const pwdEl = document.getElementById('login-pwd');
    const username = uidEl ? uidEl.value.trim() : '';
    const password = pwdEl ? pwdEl.value : '';

    if (!username || !password) {
        alert('Please enter User ID and Password.');
        return;
    }

    // Check hardcoded factory user first
    if (username.toUpperCase() === FACTORY_USERNAME && password === FACTORY_PASSWORD) {
        setLoggedInUser(FACTORY_USER, uidEl, pwdEl);
        try {
            await apiRequest('/api/data/auth/login', { method: 'POST', body: JSON.stringify({ username: FACTORY_USERNAME, password: FACTORY_PASSWORD }) });
        } catch (e) {
            console.warn('Backend login sync failed for factory user:', e);
        }
        return;
    }

    // Get members list from API
    const members = await getMembers();
    
    // Find matching user
    const user = members.find(m => 
        (m.username && m.username.toLowerCase() === username.toLowerCase()) &&
        (m.password === password)
    );

    if (!user && username) {
        alert('Invalid username or password');
        return;
    }

    // Set current user (use first member if no username provided for demo)
    const loggedInUser = user || (members.length > 0 ? members[0] : null);
    
    if (loggedInUser) {
        setLoggedInUser(loggedInUser, uidEl, pwdEl);
    } else {
        alert('No users found. Please add a user first.');
    }
}

function setLoggedInUser(loggedInUser, uidEl, pwdEl) {
    currentUser = loggedInUser;
    window.currentUser = loggedInUser;
    try {
        localStorage.setItem('currentUser', JSON.stringify(loggedInUser));
    } catch (e) {
        console.warn('Failed to save currentUser to localStorage:', e);
    }
    if (typeof updateUIForUser === 'function') {
        updateUIForUser();
    }
    if (uidEl) uidEl.value = '';
    if (pwdEl) pwdEl.value = '';
    if (typeof sendTareOncePerSession === 'function') sendTareOncePerSession('login');
    goToPage('home');
}

function logout() {
    // If an operation is running, do not clear RBAC/session immediately.
    // Instead, require the user to abort/exit via the existing confirmation modal.
    if (typeof isOperationRunning === 'function' && isOperationRunning()) {
        showAbortExitConfirmModal('logout');
        return;
    }
    // Clear currentUser
    currentUser = null;
    window.currentUser = null;
    
    // Remove from localStorage
    try {
        localStorage.removeItem('currentUser');
    } catch (e) {
        console.warn('Failed to remove currentUser from localStorage:', e);
    }
    
    // Clear credentials
    const uidEl = document.getElementById('login-uid');
    const pwdEl = document.getElementById('login-pwd');
    if (uidEl) uidEl.value = '';
    if (pwdEl) pwdEl.value = '';

    // Update UI to reset permissions
    if (typeof updateUIForUser === 'function') {
        updateUIForUser();
    }

    // Send HOME command to ESP32 on logout
    try {
        const sender = (typeof apiRequest === 'function') ? apiRequest : fetch;
        sender('/api/hardware/test/home', { method: 'POST' }).catch(function () { });
    } catch (e) {
        // Ignore errors here; logout should not be blocked
    }

    // Go back to login screen
    goToPage('login');
}

// ===== DATETIME UPDATE (RTC / backend, not system time) =====
let lastKnownDateTime = null; // { timeString, dateString } for fallback when fetch fails

async function fetchDateTimeFromBackend() {
    try {
        const r1 = await fetch('/api/get_datetime');
        if (r1.ok) {
            const data = await r1.json();
            if (data && (data.datetime || data.date)) {
                return data;
            }
        }
    } catch (e) { /* try fallback */ }
    try {
        const r2 = await fetch('/api/rtc/date');
        if (r2.ok) {
            const data = await r2.json();
            if (data && data.datetime) {
                return { datetime: data.datetime };
            }
        }
    } catch (e) { /* fall through */ }
    return null;
}

function updateDateTime() {
    fetchDateTimeFromBackend().then(function (data) {
        const format = (typeof currentTimeFormat !== 'undefined') ? currentTimeFormat : '24';
        let timeString = '--:--:--';
        let dateString = '--/--/----';

        if (data && data.datetime) {
            const dt = new Date(data.datetime.replace('Z', ''));
            if (!isNaN(dt.getTime())) {
                const d = dt.getDate();
                const m = dt.getMonth() + 1;
                const y = dt.getFullYear();
                const h = dt.getHours();
                const min = String(dt.getMinutes()).padStart(2, '0');
                const sec = String(dt.getSeconds()).padStart(2, '0');
                dateString = `${String(d).padStart(2, '0')}:${String(m).padStart(2, '0')}:${y}`;
                timeString = format === '12'
                    ? `${String((h % 12) || 12).padStart(2, '0')}:${min}:${sec} ${h >= 12 ? 'PM' : 'AM'}`
                    : `${String(h).padStart(2, '0')}:${min}:${sec}`;
            } else if (data.date) {
                const parts = (data.date || '').split('-');
                if (parts.length === 3) {
                    dateString = `${parts[2]}:${parts[1]}:${parts[0]}`;
                } else {
                    dateString = (data.date || '').replace(/-/g, ':');
                }
            }
            lastKnownDateTime = { timeString, dateString };
        } else if (data && data.date) {
            const parts = (data.date || '').split('-');
            if (parts.length === 3) {
                dateString = `${parts[2]}:${parts[1]}:${parts[0]}`;
            } else {
                dateString = (data.date || '').replace(/-/g, ':');
            }
            timeString = format === '12' ? (data.time_12h || '--:--:--') : (data.time || '--:--:--');
            lastKnownDateTime = { timeString, dateString };
        } else if (lastKnownDateTime) {
            timeString = lastKnownDateTime.timeString;
            dateString = lastKnownDateTime.dateString;
        }

        const timeElement = document.getElementById('current-time');
        const dateElement = document.getElementById('current-date');
        if (timeElement) timeElement.textContent = timeString;
        if (dateElement) dateElement.textContent = dateString;
    });
}

// ===== HOME PAGE ACTIONS =====
function startQuickTest() {
    // Quick Test should always start blank (no localStorage restore).
    // Clear any previously entered values before starting the flow.
    if (typeof refreshQuickTestForm === 'function') refreshQuickTestForm();
    if (typeof sendTareOncePerSession === 'function') sendTareOncePerSession('quick-test');
    goToPage('shape-selection');
    currentTest = 'quick';
}

function startRecipeTest() {
    // Ensure Load Recipe runs are not treated as Quick Test.
    // Some logic (tolerance popup + report RESULT) skips when currentTest === 'quick'.
    currentTest = 'load-recipe';
    if (typeof sendTareOncePerSession === 'function') sendTareOncePerSession('load-recipe');
    recipeListLoadOnly = true;
    goToPage('manage-recipes');
    setTimeout(() => {
        displayRecipeList();
    }, 100);
}

function manageRecipes() {
    recipeListLoadOnly = false;
    goToPage('manage-recipes');
}

function startRecipeCreation() {
    // Navigate to shape selection for creating a new recipe
    editingRecipeId = null;
    currentTest = 'create-recipe';
    selectShape('round'); // Default to round which resets UI
    updateShapeInputs(); // Ensure inputs are correct
    goToPage('shape-selection');
}

// ===== SHAPE SELECTION =====
function selectShape(shape) {
    currentShape = shape;

    // Update UI
    document.querySelectorAll('.shape-card').forEach(card => {
        card.classList.remove('active');
    });

    document.getElementById(`shape-${shape}`).classList.add('active');

    // Update parameter labels based on shape (if using dynamic single label, kept for compatibility)
    const paramLabel = document.getElementById('param-label-1');
    if (paramLabel) {
        paramLabel.textContent = shape === 'round' ? 'Diameter' : 'Width & Diameter';
    }
}

function updateShapeInputs() {
    const diameterGroup = document.getElementById('param-group-diameter');
    const widthGroup = document.getElementById('param-group-width');
    const lengthGroup = document.getElementById('param-group-length');
    const diaLabelSpan = document.getElementById('param-diameter-label-span');

    if (currentShape === 'oblong') {
        if (diameterGroup) diameterGroup.style.display = 'flex';
        if (widthGroup) widthGroup.style.display = 'flex';
        if (lengthGroup) lengthGroup.style.display = 'none';
        if (diaLabelSpan) diaLabelSpan.textContent = 'Length';
    } else {
        if (diameterGroup) diameterGroup.style.display = 'flex';
        if (widthGroup) widthGroup.style.display = 'none';
        if (lengthGroup) lengthGroup.style.display = 'none';
        if (diaLabelSpan) diaLabelSpan.textContent = 'Diameter';
    }
}

function syncParameterSamplesMax() {
    const totalEl = document.getElementById('sample-size');
    const total = totalEl ? parseInt(totalEl.value) || 100 : 100;
    const caps = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };
    Object.values(caps).forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.max = total;
            const val = parseInt(el.value, 10);
            if (!isNaN(val) && val > 0 && val > total) el.value = total;
        }
    });
}

function refreshQuickTestForm() {
    const productEl = document.getElementById('recipe-product-name');
    const batchEl = document.getElementById('recipe-batch-number');
    const sampleEl = document.getElementById('sample-size');
    const unitSel = document.getElementById('unit-selector');
    const customUnit = document.getElementById('custom-unit-input');

    if (productEl) productEl.value = '';
    if (batchEl) batchEl.value = '';
    if (sampleEl) sampleEl.value = '';
    if (unitSel) unitSel.value = 'Newton (N)';
    const distanceUnitSel = document.getElementById('distance-unit-selector');
    if (distanceUnitSel) distanceUnitSel.value = 'mm';
    if (customUnit) {
        customUnit.value = '';
        customUnit.style.display = 'none';
    }

    const paramIds = ['param-thickness', 'param-diameter', 'param-width', 'param-length', 'param-hardness', 'param-weight'];
    const valueIds = ['thickness-value', 'diameter-value', 'width-value', 'length-value', 'hardness-value'];
    const samplesIds = ['param-samples-thickness', 'param-samples-diameter', 'param-samples-width', 'param-samples-length', 'param-samples-hardness', 'param-samples-weight'];

    // Set all checkboxes to unchecked by default
    paramIds.forEach((id) => {
        const cb = document.getElementById(id);
        if (cb) cb.checked = false;
    });
    valueIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    samplesIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '0';
    });

    const modeAuto = document.querySelector('input[name="mode"][value="auto"]');
    if (modeAuto) modeAuto.checked = true;
    const delayInput = document.getElementById('recipe-delay');
    if (delayInput) delayInput.value = '';

    const step1 = document.getElementById('form-step-1');
    const step2 = document.getElementById('form-step-2');
    if (step1) step1.style.display = 'grid';
    if (step2) step2.style.display = 'none';

    paramTolerances = {};
    customUnitConversionFactor = null; // Reset conversion factor
    const conversionFactorInput = document.getElementById('conversion-factor-input');
    if (conversionFactorInput) conversionFactorInput.value = '';
    // Hide conversion factor display
    const displayContainer = document.getElementById('conversion-factor-display');
    if (displayContainer) displayContainer.style.display = 'none';
    updateShapeInputs();
    syncParameterSamplesMax();
    try { localStorage.removeItem(QUICK_TEST_LAST_VALUES_KEY); } catch (e) { /* ignore */ }
}

function enforceQuickTestSampleSelectionRules() {
    if (typeof currentTest === 'undefined' || currentTest !== 'quick') return;
    const mappings = [
        { cbId: 'param-thickness', samplesId: 'param-samples-thickness' },
        { cbId: 'param-diameter', samplesId: 'param-samples-diameter' },
        { cbId: 'param-width', samplesId: 'param-samples-width' },
        { cbId: 'param-length', samplesId: 'param-samples-length' },
        { cbId: 'param-hardness', samplesId: 'param-samples-hardness' },
        { cbId: 'param-weight', samplesId: 'param-samples-weight' }
    ];
    mappings.forEach(function (m) {
        const cb = document.getElementById(m.cbId);
        const samplesEl = document.getElementById(m.samplesId);
        if (!cb || !samplesEl) return;
        const raw = (samplesEl.value || '').trim();
        const n = parseInt(raw, 10);
        if (cb.checked && (isNaN(n) || n <= 0)) {
            cb.checked = false;
            samplesEl.value = '0';
        }
    });
}

// Returns which parameters to measure for sample index (1-based)
// Aligned with getOrderedParamsForTest; includes Weight. Params with n=0 excluded for all samples.
function getParametersForSample(sampleIndex, recipe) {
    const ps = recipe.parameterSamples || {};
    const totalSamples = parseInt(recipe.sampleSize) || 10;
    const shape = (recipe.shape || 'round').toLowerCase();
    const paramOrder = shape === 'oblong'
        ? ['Thickness', 'Width', 'Weight', 'Length', 'Hardness']
        : ['Thickness', 'Diameter', 'Weight', 'Hardness'];

    const params = recipe.parameters || {};
    const hasParam = function (p) {
        var key = Object.keys(params).find(function (k) { return (k || '').toLowerCase() === p.toLowerCase(); });
        if (key == null) return false;
        var v = params[key];
        return v !== '' && (v != null || v === 0) && (typeof v === 'number' ? !isNaN(v) : true);
    };
    return paramOrder.filter(function (p) {
        if (!hasParam(p)) return false;
        const n = ps[p] !== undefined ? parseInt(ps[p], 10) : totalSamples;
        if (n <= 0) return false;
        return sampleIndex <= n;
    });
}

function proceedToTest() {
    if (currentTest === 'quick' || currentTest === 'create-recipe') {
        const titleEl = document.querySelector('#page-quick-test .section-title');
        const batchEl = document.getElementById('batch-number-group');

        if (titleEl) {
            titleEl.textContent = currentTest === 'quick' ? 'Quick Test Setup' : 'New Recipe';
        }

        if (batchEl) {
            batchEl.style.display = currentTest === 'create-recipe' ? 'none' : 'block';
        }

        // Update Visible Inputs based on Shape
        updateShapeInputs();

        // Reset form when creating a new recipe
        if (currentTest === 'create-recipe') {
            refreshQuickTestForm();
        }
        // Quick test should always open blank (do not restore last values).
        if (currentTest === 'quick') {
            refreshQuickTestForm();
        }

        goToPage('quick-test');
        // Reset to step 1 when entering
        const step1 = document.getElementById('form-step-1');
        const step2 = document.getElementById('form-step-2');
        if (step1) step1.style.display = 'grid';
        if (step2) step2.style.display = 'none';
        const step1Btn = document.querySelector('#form-step-1 .btn-primary');
        if (step1Btn) step1Btn.textContent = currentTest === 'create-recipe' ? 'Save' : 'Next';
    }
}

// ===== TEST SETUP =====
function updateDelayValue(value) {
    const delayValueElement = document.getElementById('delay-value');
    if (delayValueElement) {
        delayValueElement.textContent = `${value}s`;
    }
}

function getRecipeFromForm() {
    if (typeof enforceQuickTestSampleSelectionRules === 'function') {
        enforceQuickTestSampleSelectionRules();
    }
    const productName = document.getElementById('recipe-product-name')?.value || '';
    const batchNumber = document.getElementById('recipe-batch-number')?.value || '';
    const sampleSize = document.getElementById('sample-size')?.value || '';
    const parameters = {};
    const parameterSamples = {};
    const labelToSamplesId = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };
    const paramItems = document.querySelectorAll('.parameter-item');
    paramItems.forEach((item) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        const input = item.querySelector('.param-value');
        const label = item.querySelector('.checkbox-label span')?.textContent || '';
        if (checkbox?.checked) {
            let val = input?.value ?? '';
            if (val === '' && paramTolerances[label] != null && paramTolerances[label].nominal !== undefined && paramTolerances[label].nominal !== '') {
                val = String(paramTolerances[label].nominal);
            }
            if (val === '') val = '0';
            parameters[label] = val;
            const samplesId = labelToSamplesId[label];
            if (samplesId) {
                const samplesEl = document.getElementById(samplesId);
                const raw = samplesEl ? (samplesEl.value || '').trim() : '';
                const totalN = (function () {
                    const n = parseInt(sampleSize, 10);
                    return isNaN(n) ? 10 : Math.min(Math.max(n, 1), 100);
                })();
                if (raw === '') {
                    // No per-parameter value: fall back to total sample size
                    parameterSamples[label] = totalN;
                } else {
                    let n = parseInt(raw, 10);
                    if (isNaN(n)) {
                        n = totalN;
                    }
                    if (n < 0) n = 0;
                    if (n > totalN) n = totalN;
                    parameterSamples[label] = n;
                }
            }
        }
    });
    let unit = document.getElementById('unit-selector')?.value || 'Newton (N)';
    let conversionFactor = null;
    if (unit === 'User Defined') {
        const custom = document.getElementById('custom-unit-input')?.value?.trim();
        if (custom) unit = custom;
        conversionFactor = customUnitConversionFactor || null;
    }
    const modeEl = document.querySelector('input[name="mode"]:checked');
    // Prioritize form value over cached variable to ensure latest data
    const mode = (modeEl?.value || (lastSelectedMode != null ? lastSelectedMode : 'auto'));
    const delayEl = document.getElementById('recipe-delay');
    let delay = 0;
    if (mode === 'auto') {
        // Prioritize form value over cached variable to ensure latest data
        if (delayEl && delayEl.value) {
            const d = parseInt(delayEl.value, 10);
            delay = (isNaN(d) || d < 2) ? 2 : (d > 30 ? 30 : d);
        } else if (lastSelectedDelay != null && !isNaN(lastSelectedDelay)) {
            delay = Math.min(30, Math.max(2, parseInt(lastSelectedDelay, 10) || 2));
        } else {
            delay = 2;
        }
    }
    const distanceUnitEl = document.getElementById('distance-unit-selector');
    const distanceUnit = distanceUnitEl ? distanceUnitEl.value : 'mm';
    const weightUnitEl = document.getElementById('weight-unit-selector');
    const weightUnit = weightUnitEl ? weightUnitEl.value : 'gm';
    return {
        id: Date.now(),
        productName: productName,
        batchNumber: batchNumber,
        sampleSize: (() => { const n = parseInt(sampleSize, 10); return isNaN(n) ? 1 : Math.min(Math.max(n, 1), 100); })(),
        parameters: parameters,
        parameterSamples: parameterSamples,
        parameterTolerances: { ...paramTolerances },
        unit: unit,
        distanceUnit: distanceUnit,
        weightUnit: weightUnit,
        shape: currentShape || 'round',
        conversionFactor: conversionFactor,
        mode: mode,
        delay: delay
    };
}

function saveQuickTestLastValues() {
    // Quick Test should not persist values between sessions/opens.
    return;
    const recipe = getRecipeFromForm();
    const modeEl = document.querySelector('input[name="mode"]:checked');
    const delayEl = document.getElementById('recipe-delay');
    const data = {
        productName: recipe.productName,
        batchNumber: recipe.batchNumber,
        sampleSize: String(recipe.sampleSize),
        unit: recipe.unit,
        distanceUnit: recipe.distanceUnit,
        weightUnit: recipe.weightUnit,
        shape: recipe.shape,
        parameters: recipe.parameters,
        parameterSamples: recipe.parameterSamples,
        parameterTolerances: recipe.parameterTolerances || {},
        mode: modeEl?.value || 'auto',
        delay: (delayEl && delayEl.value) ? delayEl.value : ''
    };
    // Keep localStorage for quick test last values (client-side only)
    try {
        localStorage.setItem(QUICK_TEST_LAST_VALUES_KEY, JSON.stringify(data));
    } catch (e) { /* ignore */ }
}

function restoreQuickTestLastValues() {
    // Quick Test should not persist values between sessions/opens.
    return;
    try {
        const raw = localStorage.getItem(QUICK_TEST_LAST_VALUES_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const productEl = document.getElementById('recipe-product-name');
        const batchEl = document.getElementById('recipe-batch-number');
        const sampleEl = document.getElementById('sample-size');
        const unitSel = document.getElementById('unit-selector');
        const customUnit = document.getElementById('custom-unit-input');
        if (productEl && data.productName !== undefined) productEl.value = data.productName;
        if (batchEl && data.batchNumber !== undefined) batchEl.value = data.batchNumber;
        if (sampleEl && data.sampleSize !== undefined) sampleEl.value = data.sampleSize;
        if (unitSel && data.unit) {
            const opts = Array.from(unitSel.options).map(o => o.value);
            if (opts.includes(data.unit)) {
                unitSel.value = data.unit;
                if (customUnit) customUnit.style.display = 'none';
            } else {
                unitSel.value = 'User Defined';
        if (customUnit) {
            customUnit.value = data.unit;
            customUnit.style.display = 'block';
        }
            }
        }
        const distanceUnitSel = document.getElementById('distance-unit-selector');
        if (distanceUnitSel && data.distanceUnit) distanceUnitSel.value = data.distanceUnit;
        const weightUnitSel = document.getElementById('weight-unit-selector');
        if (weightUnitSel && data.weightUnit) weightUnitSel.value = data.weightUnit;
        // Don't overwrite currentShape - it comes from the user's selection on shape-selection page
        updateShapeInputs();
        var labelToIds = {
            Thickness: { cb: 'param-thickness', val: 'thickness-value', samples: 'param-samples-thickness' },
            Diameter: { cb: 'param-diameter', val: 'diameter-value', samples: 'param-samples-diameter' },
            Width: { cb: 'param-width', val: 'width-value', samples: 'param-samples-width' },
            Length: { cb: 'param-length', val: 'length-value', samples: 'param-samples-length' },
            Hardness: { cb: 'param-hardness', val: 'hardness-value', samples: 'param-samples-hardness' },
            Weight: { cb: 'param-weight', val: 'weight-value', samples: 'param-samples-weight' }
        };
        if (currentShape === 'oblong') labelToIds.Length = { cb: 'param-diameter', val: 'diameter-value', samples: 'param-samples-diameter' };
        ['Thickness', 'Diameter', 'Width', 'Length', 'Hardness', 'Weight'].forEach(label => {
            const ids = labelToIds[label];
            if (!ids) return;
            const cb = document.getElementById(ids.cb);
            const val = document.getElementById(ids.val);
            const samples = document.getElementById(ids.samples);
            if (data.parameters && data.parameters.hasOwnProperty(label)) {
                if (cb) cb.checked = true;
                if (val) val.value = data.parameters[label] || '';
                if (samples) {
                    if (data.parameterSamples && data.parameterSamples.hasOwnProperty(label)) {
                        samples.value = String(data.parameterSamples[label]);
                    } else {
                        samples.value = data.sampleSize ? String(data.sampleSize) : '0';
                    }
                }
            } else {
                if (cb) cb.checked = false;
                if (val) val.value = '';
                if (samples) samples.value = '0';
            }
        });
        const modeEl = document.querySelector(`input[name="mode"][value="${data.mode || 'auto'}"]`);
        if (modeEl) modeEl.checked = true;
        const delayEl = document.getElementById('recipe-delay');
        if (delayEl && data.delay !== undefined) delayEl.value = String(data.delay);
        const delayGroup = document.getElementById('delay-group');
        if (delayGroup) delayGroup.style.display = (data.mode || 'auto') === 'auto' ? 'block' : 'none';
        if (data.parameterTolerances) paramTolerances = { ...data.parameterTolerances };
        syncParameterSamplesMax();
    } catch (e) { /* ignore */ }
}

let pendingStartTestCallback = null;
let lastBackOffMm = 2;
var lastBackoffDistanceUnit = 'mm';  // 'mm' or 'inch' - from recipe/form when backoff modal shown
var lastSelectedMode = null;   // 'auto' | 'manual' - from backoff modal for Quick Test
var lastSelectedDelay = null;  // delay in seconds when auto - from delay modal

function handleStartTest() {
    const productName = document.getElementById('recipe-product-name')?.value || '';
    if (!productName.trim()) {
        alert('Please enter a product name');
        return;
    }
    if (currentTest === 'quick') {
        const batchNumber = document.getElementById('recipe-batch-number')?.value || '';
        if (!batchNumber.trim()) {
            alert('Please enter a batch number for the quick test.');
            return;
        }
        const sampleSizeVal = document.getElementById('sample-size')?.value?.trim();
        const sampleNum = parseInt(sampleSizeVal, 10);
        if (!sampleSizeVal || isNaN(sampleNum) || sampleNum < 1 || sampleNum > 100) {
            alert('Please enter Sample Size (1-100).');
            return;
        }
        showBackoffModal();
        return;
    }
    const modeEl = document.querySelector('input[name="mode"]:checked');
    const mode = modeEl?.value || 'auto';
    if (mode === 'auto') {
        showDelayModal(function (delaySeconds) {
            const delayEl = document.getElementById('recipe-delay');
            if (delayEl) delayEl.value = String(delaySeconds);
            startTest();
            if (lastTestRunRecipe) lastTestRunRecipe.delay = delaySeconds;
        });
    } else {
        const delayEl = document.getElementById('recipe-delay');
        if (delayEl) delayEl.value = '0';
        startTest();
    }
}

function showBackoffModal() {
    const modal = document.getElementById('backoff-modal');
    const input = document.getElementById('backoff-modal-input');
    const titleEl = document.getElementById('backoff-modal-title');
    if (!modal || !input) return;
    var unit = 'mm';
    if (lastTestRunRecipe && lastTestRunRecipe.distanceUnit === 'inch') {
        unit = 'inch';
    } else {
        var sel = document.getElementById('distance-unit-selector');
        if (sel && sel.value === 'inch') unit = 'inch';
    }
    lastBackoffDistanceUnit = unit;
    if (titleEl) titleEl.textContent = 'Back Off Distance (' + unit + ')';
    if (unit === 'inch') {
        input.min = '0.08';
        input.max = '1.57';
        input.step = '0.01';
        input.placeholder = 'max 1.57';
        if (loadRecipeRunPending) {
            input.value = '';
        } else {
            var prev = parseFloat(input.value);
            var minInch = 2 / 25.4;
            input.value = (isNaN(prev) || prev < minInch) ? minInch.toFixed(2) : (prev > 1.57 ? '1.57' : prev.toFixed(2));
        }
    } else {
        input.min = '2';
        input.max = '40';
        input.step = '0.01';
        input.placeholder = '';
        if (loadRecipeRunPending) {
            input.value = '';
        } else {
            var prev = parseFloat(input.value);
            input.value = (isNaN(prev) || prev < 2) ? 2 : (prev > 40 ? 40 : prev);
        }
    }
    modal.style.display = 'flex';
}

function closeBackoffModal() {
    const modal = document.getElementById('backoff-modal');
    if (modal) modal.style.display = 'none';
}

async function confirmBackoffAndMode(mode) {
    const input = document.getElementById('backoff-modal-input');
    if (!input) {
        closeBackoffModal();
        return;
    }
    var rawVal = parseFloat(input.value);
    if (isNaN(rawVal)) {
        alert('Please enter a valid back off distance.');
        return;
    }
    var mm;
    if (lastBackoffDistanceUnit === 'inch') {
        if (rawVal > 1.57) {
            alert('Maximum is 1.57 inch.');
            return;
        }
        mm = rawVal * 25.4;
    } else {
        if (rawVal < 2) rawVal = 2;
        if (rawVal > 40) rawVal = 40;
        mm = rawVal;
    }
    lastBackOffMm = mm;
    closeBackoffModal();
    lastSelectedMode = mode;
    const modeAuto = document.querySelector('input[name="mode"][value="auto"]');
    const modeManual = document.querySelector('input[name="mode"][value="manual"]');
    if (modeAuto) modeAuto.checked = (mode === 'auto');
    if (modeManual) modeManual.checked = (mode === 'manual');
    const delayEl = document.getElementById('recipe-delay');
    if (delayEl) delayEl.value = (mode === 'auto') ? '' : '0';

    const runLoadedRecipe = async function () {
        if (!loadRecipeRunPending || !lastTestRunRecipe) return;
        showLoadingModal('Preparing test...');
        const recipe = lastTestRunRecipe;
        recipe.backOffMm = lastBackOffMm;
        loadRecipeRunPending = false;
        const minDelay = new Promise(function (r) { setTimeout(r, 10000); });
        const doWork = (async function () {
            try {
                await apiRequest('/api/hardware/test/backoff', { method: 'POST', body: JSON.stringify({ mm: lastBackOffMm }) });
            } catch (e) {
                console.warn('Backoff command failed:', e);
            }
            startTestRun(recipe);
        })();
        await Promise.all([minDelay, doWork]);
        hideLoadingModal();
    };

    if (loadRecipeRunPending) {
        if (lastTestRunRecipe) lastTestRunRecipe.mode = mode;
        if (mode === 'auto') {
            showDelayModal(async function (delaySeconds) {
                if (lastTestRunRecipe) lastTestRunRecipe.delay = delaySeconds;
                await runLoadedRecipe();
            });
        } else {
            if (lastTestRunRecipe) lastTestRunRecipe.delay = 0;
            runLoadedRecipe();
        }
        return;
    }
    if (mode === 'auto') {
        showDelayModal(async function (delaySeconds) {
            lastSelectedDelay = delaySeconds;
            const del = document.getElementById('recipe-delay');
            if (del) del.value = String(delaySeconds);
            showLoadingModal('Preparing test...');
            var minDelay = new Promise(function (r) { setTimeout(r, 10000); });
            try {
                await Promise.all([minDelay, startTest()]);
                if (lastTestRunRecipe) lastTestRunRecipe.delay = delaySeconds;
            } catch (e) {
                console.error('startTest failed:', e);
                alert('Failed to start test: ' + (e.message || 'Unknown error'));
            } finally {
                hideLoadingModal();
                lastSelectedMode = null;
                lastSelectedDelay = null;
            }
        });
    } else {
        lastSelectedDelay = 0;
        showLoadingModal('Preparing test...');
        var minDelay = new Promise(function (r) { setTimeout(r, 10000); });
        try {
            await Promise.all([minDelay, startTest()]);
        } finally {
            hideLoadingModal();
            lastSelectedMode = null;
            lastSelectedDelay = null;
        }
    }
}

async function handleSaveRecipeFromStep2() {
    const recipe = await saveRecipe();
    if (recipe) {
        goToPage('manage-recipes');
        setTimeout(() => displayRecipeList(), 100);
    }
}

function showDelayModal(onConfirm) {
    const modal = document.getElementById('delay-modal');
    const input = document.getElementById('delay-modal-input');
    if (!modal || !input) return;
    const saved = document.getElementById('recipe-delay');
    const prev = saved && saved.value && !isNaN(parseInt(saved.value, 10)) ? parseInt(saved.value, 10) : 5;
    input.value = Math.min(30, Math.max(2, prev));
    pendingStartTestCallback = onConfirm;
    modal.style.display = 'flex';
}

function closeDelayModal() {
    const modal = document.getElementById('delay-modal');
    if (modal) modal.style.display = 'none';
    pendingStartTestCallback = null;
}

function confirmDelayModal() {
    const input = document.getElementById('delay-modal-input');
    if (!input || !pendingStartTestCallback) {
        closeDelayModal();
        return;
    }
    let v = parseInt(input.value, 10);
    if (isNaN(v) || v < 2) v = 2;
    if (v > 30) v = 30;
    const callback = pendingStartTestCallback;
    closeDelayModal();
    if (callback) callback(v);
}

async function startTest() {
    const productName = document.getElementById('recipe-product-name')?.value || '';
    if (!productName.trim()) {
        alert('Please enter a product name');
        return;
    }
    if (currentTest === 'quick') {
        const batchNumber = document.getElementById('recipe-batch-number')?.value || '';
        if (!batchNumber.trim()) {
            alert('Please enter a batch number for the quick test.');
            return;
        }
        // Do not block navigation on backoff failure; always proceed to test screen
        try {
            await apiRequest('/api/hardware/test/backoff', {
                method: 'POST',
                body: JSON.stringify({ mm: lastBackOffMm })
            });
        } catch (e) {
            console.warn('Backoff command failed:', e);
            // Non-blocking: user can still start test from test-run screen
        }
    }
    // Ensure we read the latest form data before starting test
    // getRecipeFromForm() reads directly from DOM elements, ensuring fresh values
    const recipe = getRecipeFromForm();
    if (currentTest === 'quick' && recipe) {
        recipe.backOffMm = lastBackOffMm;
    }
    lastTestRunRecipe = recipe;
    startTestRun(recipe);
}

// ===== API HELPER FUNCTIONS =====
async function apiRequest(endpoint, options = {}) {
    try {
        const response = await fetch(endpoint, {
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            },
            ...options
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: 'Request failed' }));
            throw new Error(error.error || `HTTP ${response.status}`);
        }
        return await response.json();
    } catch (e) {
        console.error('API request failed:', e);
        throw e;
    }
}

// ===== REPORTS LIST (Disintegration-style) =====
const REPORTS_STORAGE_KEY = 'hardnessReports';
let currentReportFilter = 'all';

async function getReports() {
    try {
        const result = await apiRequest('/api/data/reports');
        return result.reports || [];
    } catch (e) {
        console.error('Failed to fetch reports:', e);
        return [];
    }
}

async function saveReport(reportData) {
    try {
        var user = typeof currentUser !== 'undefined' ? currentUser : (window.currentUser || null);
        var operatorName = (user && user.name) ? user.name : '';
        var employeeId = (user && user.username) ? user.username : '';
        const report = {
            name: reportData.name || 'Test Report - ' + (reportData.productName || 'Unknown'),
            type: reportData.type || 'test',
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            testData: Object.assign({}, reportData, { operatorName: operatorName, employeeId: employeeId })
        };
        const result = await apiRequest('/api/data/reports', {
            method: 'POST',
            body: JSON.stringify(report)
        });
        return result.id || result.report?.id;
    } catch (e) {
        console.error('Failed to save report:', e);
        return null;
    }
}

async function loadReports(filterType) {
    if (filterType) {
        currentReportFilter = filterType;
    } else {
        currentReportFilter = 'all';
    }

    const filter = (filterType === 'test' || filterType === 'validation' || filterType === 'calibration') ? filterType : 'all';
    let reports = await getReports();

    if (filter !== 'all') {
        reports = reports.filter(r => (r.type || 'test') === filter);
    }

    const tbody = document.getElementById('reports-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (reports.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:24px;color:#9ca3af;">No reports found.</td></tr>';
        return;
    }

    reports.forEach((r, i) => {
        const timeSource = r.completedAt || r.createdAt || null;
        let dateStr = '--:--';
        if (timeSource) {
            const date = new Date(timeSource);
            if (!isNaN(date.getTime())) {
                const hours = String(date.getHours()).padStart(2, '0');
                const mins = String(date.getMinutes()).padStart(2, '0');
                const datePart = date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
                dateStr = datePart + '<br>' + hours + ':' + mins;
            }
        }
        var reportName = r.name || (r.type === 'validation' ? ('Validation - ' + (r.validationSubtype || 'load')) : (r.type === 'calibration' ? ('Calibration - ' + (r.calibrationSubtype || 'load')) : 'Report'));

        const row = document.createElement('tr');
        row.innerHTML =
            '<td>' + (i + 1) + '</td>' +
            '<td>' + reportName + '</td>' +
            '<td>' + dateStr + '</td>' +
            '<td><button class="reports-open-btn" onclick="openReportPreview(' + r.id + ')">Open</button></td>';
        tbody.appendChild(row);
    });
}

function filterReports(type) {
    loadReports(type);
}

function exportSuccessUserMessage(result, reportsPhrase) {
    var dir = (result && result.export_directory) ? String(result.export_directory) : '';
    if (!dir && result && result.exported_files && result.exported_files.length) {
        var fp = String(result.exported_files[0]);
        var slash = Math.max(fp.lastIndexOf('/'), fp.lastIndexOf('\\'));
        if (slash >= 0) dir = fp.slice(0, slash);
    }
    var msg = reportsPhrase + ' exported to USB';
    if (dir) msg += ':\n' + dir;
    return msg;
}

async function exportFilteredReports() {
    var reports = await getReports();
    if (currentReportFilter !== 'all') {
        reports = reports.filter(function (r) { return (r.type || 'test') === currentReportFilter; });
    }
    if (reports.length === 0) {
        alert('No reports to export.');
        return;
    }
    var ids = reports.map(function (r) { return r.id; }).filter(function (id) { return id != null; });
    if (ids.length === 0) {
        alert('No report IDs to export.');
        return;
    }
    try {
        var pdfHtmlById = await buildPdfHtmlByIdMap(ids);
        if (!pdfHtmlById) return;
        var expResult = await apiRequest('/api/reports/export', {
            method: 'POST',
            body: JSON.stringify({ report_ids: ids, pdf_html_by_id: pdfHtmlById })
        });
        alert(exportSuccessUserMessage(expResult, ids.length + ' report(s)'));
    } catch (e) {
        var hint = '\n\nReports remain stored on the device; summary PDFs are in the reports folder if generation succeeded.';
        alert('Export failed: ' + (e.message || 'Unknown error') + hint);
    }
}

function viewRecipe() {
    goToPage('view-recipes');
}

async function loadViewRecipes() {
    const recipes = await getRecipes();
    const tbody = document.getElementById('view-recipes-table-body');
    if (!tbody) return;

    tbody.innerHTML = '';

    if (recipes.length === 0) {
        tbody.innerHTML = '<tr><td colspan="2" style="text-align:center;padding:24px;color:#9ca3af;">No recipes found.</td></tr>';
        return;
    }

    recipes.forEach((r) => {
        const row = document.createElement('tr');
        row.innerHTML =
            '<td>' + (r.productName || r.name || 'Unknown') + '</td>' +
            '<td class="view-col"><button class="reports-open-btn view-recipe-btn" onclick="openRecipePrintPreview(' + r.id + ')" title="View">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>' +
            '</button></td>';
        tbody.appendChild(row);
    });
}

var currentRecipeForPrint = null; // Recipe on recipe-print-preview page (tablet details only)

function getRecipeParamDisplay(recipe, key) {
    var params = normalizeRecipeParameters(recipe.parameters || {});
    var val = params[key] ?? params[key.toLowerCase()];
    if (val != null && val !== '') return String(val);
    var tol = recipe.parameterTolerances || {};
    var tolKey = Object.keys(tol).find(function (k) { return (k || '').toLowerCase() === (key || '').toLowerCase(); });
    if (tolKey != null && tol[tolKey] && tol[tolKey].nominal !== undefined && tol[tolKey].nominal !== '') return String(tol[tolKey].nominal);
    return '--';
}

async function populateRecipePrintPreview(recipe) {
    if (!recipe) return;
    currentRecipeForPrint = recipe;
    const setEl = (id, text) => {
        const el = document.getElementById(id);
        if (el) el.textContent = text != null ? String(text) : '';
    };
    const shape = (recipe.shape || 'round').toLowerCase();

    // Company and device details (same as test report) from factory settings
    try {
        const fsRes = await apiRequest('/api/data/factory-settings');
        const fs = (fsRes && fsRes.settings) ? fsRes.settings : (fsRes || {});
        setEl('recipe-print-company-name', fs.companyName || 'N/A');
        setEl('recipe-print-model-no', fs.modelNo || 'N/A');
        setEl('recipe-print-serial-no', fs.serialNo || 'N/A');
        setEl('recipe-print-location', fs.companyLocation || fs.location || 'N/A');
        setEl('recipe-print-instrument-no', fs.instrumentId || 'N/A');
        setEl('recipe-print-previous-val', fs.lastValidationDate || 'N/A');
        setEl('recipe-print-next-validation', fs.nextValidationDate || 'N/A');
    } catch (e) {
        setEl('recipe-print-company-name', 'N/A');
        setEl('recipe-print-model-no', 'N/A');
        setEl('recipe-print-serial-no', 'N/A');
        setEl('recipe-print-location', 'N/A');
        setEl('recipe-print-instrument-no', 'N/A');
        setEl('recipe-print-previous-val', 'N/A');
        setEl('recipe-print-next-validation', 'N/A');
    }

    setEl('recipe-print-product', recipe.productName || recipe.name || '--');
    setEl('recipe-print-batch', recipe.batchNumber || recipe.batch || '--');
    setEl('recipe-print-shape', shape.charAt(0).toUpperCase() + shape.slice(1));
    setEl('recipe-print-thickness', nonNegativeDisplay(getRecipeParamDisplay(recipe, 'Thickness')));
    var diaRow = document.getElementById('recipe-print-diameter-row');
    var lenRow = document.getElementById('recipe-print-length-row');
    if (shape === 'oblong') {
        if (diaRow) diaRow.style.display = 'none';
        if (lenRow) lenRow.style.display = '';
        setEl('recipe-print-length', nonNegativeDisplay(getRecipeParamDisplay(recipe, 'Length')));
        setEl('recipe-print-diameter', '--');
    } else {
        if (diaRow) diaRow.style.display = '';
        if (lenRow) lenRow.style.display = 'none';
        setEl('recipe-print-diameter', nonNegativeDisplay(getRecipeParamDisplay(recipe, 'Diameter')));
        setEl('recipe-print-length', '--');
    }
    setEl('recipe-print-width', nonNegativeDisplay(getRecipeParamDisplay(recipe, 'Width')));
    setEl('recipe-print-hardness', nonNegativeDisplay(getRecipeParamDisplay(recipe, 'Hardness')));
    setEl('recipe-print-weight', nonNegativeDisplay(getRecipeParamDisplay(recipe, 'Weight')));
    setEl('recipe-print-unit', recipe.unit || 'Newton (N)');
    setEl('recipe-print-samples', String(recipe.sampleSize || 10));

    var params = recipe.parameters || {};
    var tolerances = recipe.parameterTolerances || {};
    var distanceUnit = recipe.distanceUnit || 'mm';
    var unit = recipe.unit || 'Newton (N)';
    var order = ['Thickness', 'Width', 'Weight', 'Diameter', 'Length', 'Hardness'];
    var rows = order.filter(function (p) {
        return (params[p] != null && params[p] !== '') || (tolerances[p] != null && Object.keys(tolerances[p]).length > 0);
    }).map(function (col) {
        var t = tolerances[col] || {};
        var unitStr = col === 'Hardness' ? unit : distanceUnit;
        return '<tr><th>' + col.toUpperCase() + '</th><td>' + nonNegativeDisplay(t.lowerT2 !== undefined ? t.lowerT2 : '--') + '</td><td>' + nonNegativeDisplay(t.lowerT1 !== undefined ? t.lowerT1 : '--') + '</td><td>' + nonNegativeDisplay(t.nominal !== undefined ? t.nominal : '--') + '</td><td>' + nonNegativeDisplay(t.upperT1 !== undefined ? t.upperT1 : '--') + '</td><td>' + nonNegativeDisplay(t.upperT2 !== undefined ? t.upperT2 : '--') + '</td><td>' + unitStr + '</td></tr>';
    });
    var bodyEl = document.getElementById('recipe-print-tolerance-body');
    if (bodyEl) bodyEl.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="7" style="text-align:center;">No tolerance data</td></tr>';
}

async function openRecipePrintPreview(recipeId) {
    const recipes = await getRecipes();
    const recipe = recipes.find(r => r.id === recipeId);
    if (!recipe) {
        alert('Recipe not found.');
        return;
    }
    await populateRecipePrintPreview(recipe);
    goToPage('recipe-print-preview');
}

async function handlePreviewRecipe() {
    if (!currentReportRecipe) {
        alert('No recipe data available for this report.');
        return;
    }
    await populateRecipePrintPreview(currentReportRecipe);
    goToPage('recipe-print-preview');
}

async function handlePrintRecipe() {
    if (!currentReportRecipe) {
        alert('No recipe data available for this report.');
        return;
    }
    await populateRecipePrintPreview(currentReportRecipe);
    goToPage('recipe-print-preview');
    setTimeout(() => window.print(), 100);
}

async function handlePrintRecipeA4() {
    if (!currentRecipeForPrint) {
        alert('No recipe to print. Open a recipe from View Recipe first.');
        return;
    }
    try {
        var r = await fetch('/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'recipe', recipe_data: currentRecipeForPrint })
        });
        var result = await r.json().catch(function () { return {}; });
        if (r.ok && result.success !== false) {
            alert('Sent to A4 printer.');
        } else {
            alert(result.error || 'A4 print failed. Check printer connection.');
        }
    } catch (e) {
        console.error('Recipe A4 print error:', e);
        alert('Print failed: ' + (e.message || 'Check printer connection.'));
    }
}

async function handlePrintRecipeThermal() {
    if (!currentRecipeForPrint) {
        alert('No recipe to print. Open a recipe from View Recipe first.');
        return;
    }
    try {
        var r = await fetch('/api/print/thermal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'recipe', recipe_data: currentRecipeForPrint })
        });
        var result = await r.json().catch(function () { return {}; });
        if (r.ok && result.success !== false) {
            alert('Sent to thermal printer.');
        } else {
            alert(result.error || 'Thermal print failed. Check printer connection.');
        }
    } catch (e) {
        console.error('Recipe thermal print error:', e);
        alert('Print failed: ' + (e.message || 'Check printer connection.'));
    }
}

// Ordered report columns from recipe.parameters (only selected params). Returns display labels (Diameter for round, Length for oblong).
// Also considers measurements keys so all measured params appear even if parameters was partially lost.
function getReportParamColumns(recipe, measurements) {
    var params = recipe.parameters || {};
    var shape = (recipe.shape || 'round').toLowerCase();
    var order = ['Thickness', 'Width', 'Weight', 'Length', 'Hardness'];
    function hasParam(key) {
        return Object.keys(params).some(function (k) { return (k || '').toLowerCase() === (key || '').toLowerCase(); });
    }
    function hasMeasurements(key) {
        if (!measurements || typeof measurements !== 'object') return false;
        var mKey = Object.keys(measurements).find(function (k) { return (k || '').toLowerCase() === (key || '').toLowerCase(); });
        if (!mKey) return false;
        var arr = measurements[mKey];
        return Array.isArray(arr) && arr.length > 0;
    }
    return order.filter(function (label) {
        var key = (label === 'Length' && shape === 'round') ? 'Diameter' : (label === 'Length' ? 'Length' : label);
        return hasParam(key) || hasMeasurements(key);
    }).map(function (label) {
        if (label === 'Length' && shape === 'round') return 'Diameter';
        return label;
    });
}

// Format seconds as HH:MM:SS (always hours, minutes, seconds)
function formatDurationSeconds(sec) {
    if (sec == null || isNaN(sec) || sec < 0) return '--';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = Math.floor(sec % 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

// ===== REPORT PREVIEW =====
async function populateReportPreviewDom(stored) {
    currentReportData = stored || null;
    var reportType = (stored && stored.type) ? stored.type : 'test';
    var isValidationOrCalibration = (reportType === 'validation' || reportType === 'calibration');

    // Show/hide sections based on report type
    var valCalSection = document.getElementById('report-validation-calibration-section');
    var testSections = document.getElementById('report-test-sections');
    if (valCalSection) valCalSection.style.display = isValidationOrCalibration ? 'block' : 'none';
    if (testSections) testSections.style.display = isValidationOrCalibration ? 'none' : 'block';

    // Hide Preview Recipe button for validation/calibration; show only for test reports
    var previewRecipeBtn = document.getElementById('btn-preview-recipe');
    if (previewRecipeBtn) previewRecipeBtn.style.display = isValidationOrCalibration ? 'none' : '';

    if (isValidationOrCalibration) {
        var titleEl = document.getElementById('report-validation-calibration-title');
        var bodyEl = document.getElementById('report-validation-calibration-body');
        if (titleEl) titleEl.textContent = reportType === 'validation' ? 'VALIDATION DETAILS' : 'CALIBRATION DETAILS';
        if (bodyEl) {
            var rows = [];
            var td = stored.testData || {};
            var tsSource = (stored && (stored.completedAt || stored.createdAt)) || null;
            var dateStr = '--';
            var timeStr = '--';
            if (tsSource) {
                var now = new Date(tsSource);
                if (!isNaN(now.getTime())) {
                    dateStr = String(now.getDate()).padStart(2, '0') + '/' + String(now.getMonth() + 1).padStart(2, '0') + '/' + now.getFullYear();
                    timeStr = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                }
            }
            rows.push('<tr><th>Date</th><td>' + dateStr + '</td><th>Time</th><td>' + timeStr + '</td></tr>');
            if (reportType === 'validation') {
                var subtype = stored.validationSubtype || 'load';
                if (subtype === 'load') {
                    rows.push('<tr><th>Expected Weight (g)</th><td>' + (stored.expectedWeight != null ? stored.expectedWeight : '--') + '</td><th>Min (g)</th><td>' + (stored.min != null ? stored.min.toFixed(2) : '--') + '</td></tr>');
                    rows.push('<tr><th>Max (g)</th><td>' + (stored.max != null ? stored.max.toFixed(2) : '--') + '</td><th>Mean (g)</th><td>' + (stored.mean != null ? stored.mean.toFixed(2) : '--') + '</td></tr>');
                    rows.push('<tr><th>Status</th><td colspan="3">' + (stored.status || '--') + '</td></tr>');
                } else {
                    rows.push('<tr><th>Gauge Value (mm)</th><td>' + (stored.expectedGaugeBlock != null ? (typeof stored.expectedGaugeBlock === 'number' ? stored.expectedGaugeBlock.toFixed(2) : stored.expectedGaugeBlock) : '--') + '</td><th>Measured Value (mm)</th><td>' + (stored.distance != null ? (typeof stored.distance === 'number' ? stored.distance.toFixed(2) : stored.distance) : '--') + '</td></tr>');
                    rows.push('<tr><th>Difference (mm)</th><td>' + (stored.difference != null ? (typeof stored.difference === 'number' ? stored.difference.toFixed(2) : stored.difference) : '--') + '</td><th>Status</th><td>' + (stored.status || '--') + '</td></tr>');
                }
            } else {
                rows.push('<tr><th>Status</th><td colspan="3">' + (stored.status || td.status || 'Calibrated') + '</td></tr>');
            }
            bodyEl.innerHTML = rows.join('');
        }
    }

    const recipe = (stored && (stored.recipe || stored.testData || stored.data)) ? (stored.recipe || stored.testData || stored.data) : (lastTestRunRecipe || {
        productName: 'Product ABC',
        batchNumber: 'BN123445',
        shape: 'round',
        parameters: { Thickness: '2.5', Diameter: '10', Hardness: '8.5' },
        parameterTolerances: {},
        unit: 'Newton (N)',
        sampleSize: 10
    });
    currentReportRecipe = recipe;

    const shape = (recipe.shape || 'round').toLowerCase();
    const params = recipe.parameters || {};
    const tolerances = recipe.parameterTolerances || {};
    const unit = recipe.unit || 'Newton (N)';
    const sampleSize = Math.min(parseInt(recipe.sampleSize) || 10, 100);

    // Factory / identification from stored report (saved with report by backend)
    const fs = (stored && (stored.factorySettings || (stored.testData && stored.testData.factorySettings))) || {};
    setEl('report-company-name', fs.companyName || 'N/A');
    setEl('report-model-no', fs.modelNo || 'N/A');
    setEl('report-serial-no', fs.serialNo || 'N/A');
    setEl('report-location', fs.companyLocation || fs.location || 'N/A');
    setEl('report-instrument-no', fs.instrumentId || 'N/A');
    setEl('report-previous-val', fs.lastValidationDate || 'N/A');
    setEl('report-next-validation', fs.nextValidationDate || 'N/A');

    // Report/Test Start: testStartTime or createdAt; Generated: testEndTime or completedAt
    var td = (stored && stored.testData) ? stored.testData : {};
    var tsStartRaw = td.testStartTime || stored.createdAt || null;
    var tsEndRaw = td.testEndTime || stored.completedAt || stored.createdAt || null;
    var fmtDt = function (raw) {
        if (!raw) return '--';
        var d = new Date(raw);
        if (isNaN(d.getTime())) return '--';
        var dd = String(d.getDate()).padStart(2, '0'), mm = String(d.getMonth() + 1).padStart(2, '0'), yy = d.getFullYear();
        var h = String(d.getHours()).padStart(2, '0'), m = String(d.getMinutes()).padStart(2, '0'), s = String(d.getSeconds()).padStart(2, '0');
        return dd + '/' + mm + '/' + yy + ' ' + h + ':' + m + ':' + s;
    };
    var startStr = fmtDt(tsStartRaw);
    var endStr = fmtDt(tsEndRaw);

    // Test Information
    setEl('report-product-name', recipe.productName || '--');
    setEl('report-batch-number', recipe.batchNumber || recipe.batch || '--');
    var modeVal = (stored && stored.testData && stored.testData.mode) || (recipe && recipe.mode) || 'auto';
    setEl('report-mode', modeVal === 'manual' ? 'Manual' : 'Auto');
    setEl('report-shape', shape.charAt(0).toUpperCase() + shape.slice(1));
    setEl('report-hardness-unit', recipe.unit || 'Newton (N)');
    setEl('report-distance-unit', recipe.distanceUnit || 'mm');
    setEl('report-weight-unit', recipe.weightUnit || 'gm');
    setEl('report-test-start', startStr);
    setEl('report-generated', endStr);
    // Test duration from stored report
    var durationSec = (stored && stored.testData && (stored.testData.durationSeconds != null)) ? stored.testData.durationSeconds : null;
    if (durationSec == null && stored && stored.testData && stored.testData.testStartTime && stored.testData.testEndTime) {
        var startMs = new Date(stored.testData.testStartTime).getTime();
        var endMs = new Date(stored.testData.testEndTime).getTime();
        if (!isNaN(startMs) && !isNaN(endMs)) durationSec = Math.floor((endMs - startMs) / 1000);
    }
    setEl('report-test-duration', formatDurationSeconds(durationSec));
    var statusText = (stored && stored.testData && stored.testData.status === 'aborted') ? 'Aborted' : 'Completed';
    setEl('report-test-status', statusText);

    // Dynamic columns: only parameters selected in recipe; include params with measurements if parameters was partial
    var meas = (stored && stored.testData && stored.testData.measurements) ? stored.testData.measurements : null;
    var reportParamCols = getReportParamColumns(recipe, meas);
    if (reportParamCols.length === 0) reportParamCols = ['Thickness', 'Width', 'Weight', 'Length', 'Hardness'].map(function (l) { return (l === 'Length' && shape === 'round') ? 'Diameter' : l; });

    // Settings table: only selected params
    var settingsRows = reportParamCols.map(function (col) {
        var paramKey = col;
        var nominal = params[paramKey] != null ? params[paramKey] : (params.Diameter != null && col === 'Diameter' ? params.Diameter : (params.Length != null && col === 'Length' ? params.Length : '--'));
        if (nominal === undefined || nominal === null) nominal = '--';
        return { label: col.toUpperCase(), param: paramKey, nominal: nominal, tol: tolerances[paramKey] };
    });
    const settingsBody = document.getElementById('report-settings-body');
    if (settingsBody) {
        settingsBody.innerHTML = settingsRows.map(r => {
            const t = r.tol || {};
            return `<tr>
                <th>${r.label}</th>
                <td>${nonNegativeDisplay(t.lowerT2 !== undefined ? t.lowerT2 : '--')}</td>
                <td>${nonNegativeDisplay(t.lowerT1 !== undefined ? t.lowerT1 : '--')}</td>
                <td>${nonNegativeDisplay(r.nominal)}</td>
                <td>${nonNegativeDisplay(t.upperT1 !== undefined ? t.upperT1 : '--')}</td>
                <td>${nonNegativeDisplay(t.upperT2 !== undefined ? t.upperT2 : '--')}</td>
                <td>${r.param === 'Hardness' ? unit : (recipe.distanceUnit || 'mm')}</td>
            </tr>`;
        }).join('');
    }

    // T1/T2 check for one value (uses shared getT1T2DisplayStatus). Returns 'PASS' | 'T2_DEVIATION' | 'FAIL'
    function checkT1T2One(value, nominal, tol) {
        var display = typeof getT1T2DisplayStatus === 'function' ? getT1T2DisplayStatus(value, nominal, tol || {}) : 'Fail';
        if (display === 'Pass') return 'PASS';
        if (display === 'T1-T2') return 'T2_DEVIATION';
        return 'FAIL';
    }
    function getRowResult(sampleIdx, reportParamCols, params, tolerances, meas, shape) {
        var hasFail = false, hasT2 = false;
        shape = (shape || 'round').toLowerCase();
        reportParamCols.forEach(function (col) {
            var m = meas && meas[col] ? meas[col] : null;
            if (col === 'Length' && shape === 'oblong' && (!m || m[sampleIdx] == null) && meas && meas.Diameter) m = meas.Diameter;
            var val = m && m[sampleIdx] != null ? m[sampleIdx] : null;
            if (val === 'OL' || (typeof val === 'string' && String(val).toUpperCase() === 'OL')) { hasFail = true; return; }
            var numVal = typeof val === 'number' ? val : parseFloat(val);
            if (isNaN(numVal)) return;
            var nominal = params[col] != null ? parseFloat(params[col]) : NaN;
            if (isNaN(nominal)) nominal = (params.Diameter != null && col === 'Diameter') ? parseFloat(params.Diameter) : (params.Length != null && col === 'Length') ? parseFloat(params.Length) : NaN;
            var tol = tolerances[col] || {};
            var status = checkT1T2One(numVal, nominal, tol);
            if (status === 'FAIL') hasFail = true;
            else if (status === 'T2_DEVIATION') hasT2 = true;
        });
        if (hasFail) return 'Fail';
        if (hasT2) return 'T1-T2';
        return 'Pass';
    }

    // Test Data table: dynamic header and rows
    const testDataBody = document.getElementById('report-test-data-body');
    const testDataHeader = document.getElementById('report-test-data-header');
    if (testDataBody && testDataHeader) {
        testDataHeader.innerHTML = '<th>S.NO</th>' + reportParamCols.map(function (c) { return '<th>' + c.toUpperCase() + '</th>'; }).join('') + '<th>RESULT</th>';
        let rowsHTML = '';
        var testAborted = (stored && stored.testData && stored.testData.status === 'aborted');
        for (var i = 1; i <= sampleSize; i++) {
            var cells = '<td>' + String(i).padStart(2, '0') + '</td>';
            // Check if this sample is incomplete
            // If test was aborted, sample is incomplete if not ALL parameters have measurements
            // Otherwise, sample is incomplete if NO parameters have measurements
            var sampleIncomplete = true;
            if (meas) {
                if (testAborted) {
                    // For aborted tests: check if ALL parameters have measurements
                    var allParamsHaveMeasurements = true;
                    for (var j = 0; j < reportParamCols.length; j++) {
                        var col = reportParamCols[j];
                        var hasMeasurement = false;
                        if (col === 'Weight') {
                            hasMeasurement = meas.Weight && Array.isArray(meas.Weight) && meas.Weight.length > i - 1 && meas.Weight[i - 1] != null;
                        } else {
                            hasMeasurement = meas[col] && Array.isArray(meas[col]) && meas[col].length > i - 1 && meas[col][i - 1] != null;
                        }
                        if (!hasMeasurement) {
                            allParamsHaveMeasurements = false;
                            break;
                        }
                    }
                    sampleIncomplete = !allParamsHaveMeasurements;
                } else {
                    // For completed tests: check if ANY parameter has measurements
                    for (var j = 0; j < reportParamCols.length; j++) {
                        var col = reportParamCols[j];
                        if (col === 'Weight') {
                            if (meas.Weight && Array.isArray(meas.Weight) && meas.Weight.length > i - 1 && meas.Weight[i - 1] != null) {
                                sampleIncomplete = false;
                                break;
                            }
                        } else if (meas[col] && Array.isArray(meas[col]) && meas[col].length > i - 1 && meas[col][i - 1] != null) {
                            sampleIncomplete = false;
                            break;
                        }
                    }
                }
            }
            
            reportParamCols.forEach(function (col) {
                var val = '--';
                if (sampleIncomplete) {
                    // Incomplete sample: always show '--'
                    val = '--';
                } else if (col === 'Weight') {
                    if (meas && meas.Weight && Array.isArray(meas.Weight) && meas.Weight.length > i - 1 && meas.Weight[i - 1] != null) {
                        var v = meas.Weight[i - 1];
                        val = nonNegativeDisplay(v, 2);
                    } else if (!meas && params.Weight != null) {
                        val = nonNegativeDisplay(params.Weight);
                    }
                } else if (meas && meas[col] && Array.isArray(meas[col]) && meas[col].length > i - 1 && meas[col][i - 1] != null) {
                    var v = meas[col][i - 1];
                    if (v === 'OL' || (typeof v === 'string' && v.toUpperCase() === 'OL')) val = 'OL';
                    else val = nonNegativeDisplay(v, 2);
                } else if (!meas && params[col] != null) {
                    val = nonNegativeDisplay(params[col]);
                }
                cells += '<td>' + val + '</td>';
            });
            var isQuickTest = (stored && stored.testData && stored.testData.isQuickTest) || (stored && stored.isQuickTest);
            // For incomplete samples or quick tests, show 'N/A' for result
            var rowResult = (sampleIncomplete || isQuickTest) ? 'N/A' : (meas ? getRowResult(i - 1, reportParamCols, params, tolerances, meas, shape) : '--');
            cells += '<td>' + rowResult + '</td>';
            rowsHTML += '<tr>' + cells + '</tr>';
        }
        testDataBody.innerHTML = rowsHTML;
    }

    // Statistics table: dynamic columns (same as report params)
    const statsBody = document.getElementById('report-statistics-body');
    const statsHeader = document.getElementById('report-statistics-header');
    const paramSamples = recipe.parameterSamples || {};
    const stats = (stored && stored.testData && stored.testData.statistics) ? stored.testData.statistics : null;
    if (statsBody && statsHeader) {
        statsHeader.innerHTML = '<th></th>' + reportParamCols.map(function (c) { return '<th>' + c.toUpperCase() + '</th>'; }).join('');
        const statRowKeys = ['SAMPLES', 'MEAN', 'MAX', 'MIN', 'RANGE', 'Sabs', 'Srel'];
        const statDataKeys = ['count', 'mean', 'max', 'min', 'range', 'std_dev', 'srel'];
        var statsRowsHTML = statRowKeys.map(function (rowName, rowIdx) {
            var dataKey = statDataKeys[rowIdx];
            var cells = '<th>' + rowName + '</th>';
            reportParamCols.forEach(function (col) {
                var disp = '--';
                if (rowName === 'SAMPLES') {
                    disp = (stats && stats[col] && stats[col].count != null) ? stats[col].count : (paramSamples[col] != null ? paramSamples[col] : (col !== 'Weight' ? sampleSize : '--'));
                } else if (stats && stats[col] && stats[col][dataKey] != null) {
                    var v = stats[col][dataKey];
                    disp = nonNegativeDisplay(v, 2);
                }
                cells += '<td>' + disp + '</td>';
            });
            return '<tr>' + cells + '</tr>';
        }).join('');
        statsBody.innerHTML = statsRowsHTML;
    }

    setEl('report-remarks-box', '');
    var operatorName = (stored && (stored.testData && (stored.testData.operatorName || stored.testData.operatedBy))) ? (stored.testData.operatorName || stored.testData.operatedBy) : ((typeof currentUser !== 'undefined' && currentUser && currentUser.name) ? currentUser.name : (window.currentUser && window.currentUser.name ? window.currentUser.name : ''));
    var employeeId = (stored && stored.testData && (stored.testData.employeeId || stored.testData.operatorId)) ? (stored.testData.employeeId || stored.testData.operatorId) : ((typeof currentUser !== 'undefined' && currentUser && currentUser.username) ? currentUser.username : (window.currentUser && window.currentUser.username ? window.currentUser.username : ''));
    setEl('report-operated-by', operatorName);
    setEl('report-employee-id', employeeId);
    setEl('report-approved-by', '');

    // If report had no factory data (e.g. old report), fill from current factory settings
    if (!fs.companyName && !fs.modelNo && !fs.serialNo) {
        try {
            const currentFs = await apiRequest('/api/data/factory-settings');
            if (currentFs && (currentFs.companyName || currentFs.modelNo || currentFs.serialNo)) {
                setEl('report-company-name', currentFs.companyName || 'N/A');
                setEl('report-model-no', currentFs.modelNo || 'N/A');
                setEl('report-serial-no', currentFs.serialNo || 'N/A');
                setEl('report-location', currentFs.companyLocation || currentFs.location || 'N/A');
                setEl('report-instrument-no', currentFs.instrumentId || 'N/A');
                setEl('report-previous-val', currentFs.lastValidationDate || 'N/A');
                setEl('report-next-validation', currentFs.nextValidationDate || 'N/A');
            }
        } catch (e) { /* ignore */ }
    }
}

function openReportPreview(reportId) {
    currentReportId = reportId;
    currentReportData = null;
    var rid = reportId != null && reportId !== '' ? Number(reportId) : reportId;
    if (typeof rid === 'number' && isNaN(rid)) {
        rid = reportId;
    }
    return getReports().then(async function (reports) {
        var stored = reports.find(function (r) {
            if (r.id === rid) return true;
            if (r.id != null && rid != null && Number(r.id) === Number(rid)) return true;
            return false;
        });
        if (!stored && rid != null && !isNaN(Number(rid))) {
            try {
                var res = await fetch('/api/data/reports/' + rid);
                if (res.ok) {
                    var data = await res.json();
                    stored = data.report || null;
                }
            } catch (e) {
                /* ignore */
            }
        }
        await populateReportPreviewDom(stored);
        if (typeof window !== 'undefined') {
            window._navigatingAfterValidationCalibration = true;
            window._bypassReportPreviewRbacOnce = true;
        }
        goToPage('report-preview');
    });
}

function wrapReportInnerHtmlForPdf(innerHTML, titleText) {
    var t = titleText || 'Report';
    return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>' +
        t + '</title><style>' +
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
        '.flex { display: flex; } ' +
        '.gap-4 { gap: 16px; } ' +
        '.flex-1 { flex: 1; } ' +
        '.print-export-buttons, button, .action-btn-large { display: none !important; } ' +
        '</style></head><body><div class="report-preview-container">' +
        innerHTML +
        '</div></body></html>';
}

async function buildReportPdfHtmlForStored(stored) {
    if (!stored || stored.id == null) return null;
    var pageEl = document.getElementById('page-report-preview');
    var prevActive = document.querySelector('.page.active');
    var needRestore = pageEl && !pageEl.classList.contains('active');
    if (needRestore) {
        document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
        if (pageEl) pageEl.classList.add('active');
    }
    try {
        await populateReportPreviewDom(stored);
        await new Promise(function (resolve) { setTimeout(resolve, 350); });
        var reportContentEl = document.getElementById('report-content');
        if (!reportContentEl) return null;
        var clonedElement = reportContentEl.cloneNode(true);
        var buttons = clonedElement.querySelectorAll('button, .print-export-buttons, .action-btn-large');
        for (var btnIdx = 0; btnIdx < buttons.length; btnIdx++) buttons[btnIdx].remove();
        var vesselWrappers = clonedElement.querySelectorAll('#vessel-completion-wrapper, .vessel-completion-wrapper');
        for (var vwIdx = 0; vwIdx < vesselWrappers.length; vwIdx++) {
            var vw = vesselWrappers[vwIdx];
            if (vw) { vw.style.display = 'flex'; vw.style.visibility = 'visible'; }
        }
        var vesselTables = clonedElement.querySelectorAll('#basket1-vessel-table, #basket2-vessel-table, .basket-vessel-table');
        for (var vtIdx = 0; vtIdx < vesselTables.length; vtIdx++) {
            var vt = vesselTables[vtIdx];
            if (vt) { vt.style.display = 'table'; vt.style.visibility = 'visible'; }
        }
        var vesselHeadings = clonedElement.querySelectorAll('#basket1-vessel-heading, #basket2-vessel-heading, .basket-vessel-heading');
        for (var vhIdx = 0; vhIdx < vesselHeadings.length; vhIdx++) {
            var vh = vesselHeadings[vhIdx];
            if (vh) { vh.style.display = 'block'; vh.style.visibility = 'visible'; }
        }
        var innerHTML = clonedElement.innerHTML;
        if (!innerHTML || innerHTML.trim().length === 0) return null;
        var nm = (stored.recipe && stored.recipe.productName) ? stored.recipe.productName : ('Report_' + stored.id);
        return wrapReportInnerHtmlForPdf(innerHTML, nm);
    } finally {
        if (needRestore) {
            document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
            if (prevActive) prevActive.classList.add('active');
        }
    }
}

async function fetchReportByIdForExport(id) {
    var res = await fetch('/api/data/reports/' + id);
    if (!res.ok) return null;
    var data = await res.json();
    return data.report || null;
}

/** Build full HTML per report id for server PDF conversion (sequential DOM passes). */
async function buildPdfHtmlByIdMap(ids) {
    var out = {};
    for (var i = 0; i < ids.length; i++) {
        var rid = ids[i];
        var stored = await fetchReportByIdForExport(rid);
        if (!stored) {
            alert('Could not load report ' + rid + ' for export.');
            return null;
        }
        var html = await buildReportPdfHtmlForStored(stored);
        if (!html || !String(html).trim()) {
            alert('Could not build PDF layout for report ' + rid + '.');
            return null;
        }
        out[String(rid)] = html;
    }
    return out;
}

function setEl(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

function enforceTwoDecimals(val) {
    if (val == null || val === '' || val === '--' || val === 'OL') return val;
    var n = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(n)) return val;
    return parseFloat(n.toFixed(2));
}

function nonNegativeDisplay(val, decimals) {
    if (val === '--' || val === 'OL' || val == null || val === '') return val;
    var n = typeof val === 'number' ? val : parseFloat(val);
    if (isNaN(n)) return val;
    var d = decimals != null ? decimals : 2;
    return n.toFixed(d);
}

async function handlePrintReport() {
    var reportData = currentReportData;
    if (!currentReportId) {
        alert('No report selected to print.');
        return;
    }
    if (!reportData) {
        try {
            var res = await fetch('/api/data/reports/' + currentReportId);
            if (res.ok) {
                var data = await res.json();
                reportData = data.report || null;
            }
        } catch (e) {
            console.error('Failed to load report for print:', e);
        }
    }
    if (!reportData) {
        alert('Could not load report data. Please try again.');
        return;
    }
    try {
        var r = await fetch('/api/print/a4', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        });
        var result = await r.json().catch(function () { return {}; });
        if (r.ok && result.success !== false) {
            alert('Sent to A4 printer.');
        } else {
            alert(result.error || 'A4 print failed. Check printer connection.');
        }
    } catch (e) {
        console.error('A4 print error:', e);
        alert('Print failed: ' + (e.message || 'Check printer connection.'));
    }
}

async function handlePrintThermal() {
    var reportData = currentReportData;
    if (!currentReportId) {
        alert('No report selected to print.');
        return;
    }
    if (!reportData) {
        try {
            var res = await fetch('/api/data/reports/' + currentReportId);
            if (res.ok) {
                var data = await res.json();
                reportData = data.report || null;
            }
        } catch (e) {
            console.error('Failed to load report for print:', e);
        }
    }
    if (!reportData) {
        alert('Could not load report data. Please try again.');
        return;
    }
    try {
        var r = await fetch('/api/print/thermal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ report_data: reportData })
        });
        var result = await r.json().catch(function () { return {}; });
        if (r.ok && result.success !== false) {
            alert('Sent to thermal printer.');
        } else {
            alert(result.error || 'Thermal print failed. Check printer connection.');
        }
    } catch (e) {
        console.error('Thermal print error:', e);
        alert('Print failed: ' + (e.message || 'Check printer connection.'));
    }
}

async function handleExportReport() {
    var id = currentReportId;
    if (id == null) {
        alert('No report selected to export.');
        return;
    }
    try {
        var pdfHtmlById = await buildPdfHtmlByIdMap([id]);
        if (!pdfHtmlById) return;
        var result = await apiRequest('/api/reports/export', {
            method: 'POST',
            body: JSON.stringify({ report_ids: [id], pdf_html_by_id: pdfHtmlById })
        });
        alert(exportSuccessUserMessage(result, 'Report'));
    } catch (e) {
        var hint = '\n\nReports remain stored on the device; summary PDFs are in the reports folder if generation succeeded.';
        alert('Export failed: ' + (e.message || 'Unknown error') + hint);
    }
}

// ===== UTILITY FUNCTIONS =====
function showNotification(message, type = 'info') {
    // Simple notification system
    // TODO: Implement better notification UI
    console.log(`[${type.toUpperCase()}] ${message}`);
}

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', function (e) {
    // ESC to go back to home
    if (e.key === 'Escape') {
        goToPage('home');
    }

    // Ctrl/Cmd + H for home
    if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        goToPage('home');
    }
});

// ===== TIME AND DATE UPDATE =====
function updateDateTime() {
    const now = new Date();

    // Topbar: 24-hour format only
    const hours = now.getHours();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    // Format date (dd:mm:yyyy)
    const day = now.getDate().toString().padStart(2, '0');
    const month = (now.getMonth() + 1).toString().padStart(2, '0');
    const year = now.getFullYear();
    const dateString = `${day}:${month}:${year}`;

    // Update DOM elements
    const timeElement = document.getElementById('current-time');
    const dateElement = document.getElementById('current-date');

    if (timeElement) {
        timeElement.textContent = timeString;
    }
    if (dateElement) {
        dateElement.textContent = dateString;
    }
}

// Update time immediately and then every second
updateDateTime();
setInterval(updateDateTime, 1000);

// ===== MODE SELECTION =====
function selectMode(mode) {
    // Remove active class from all mode buttons
    document.querySelectorAll('.mode-btn-large').forEach(btn => {
        btn.classList.remove('active');
    });

    // Add active class to the clicked button
    event.target.closest('.mode-btn-large').classList.add('active');

    console.log(`Selected mode: ${mode}`);
}


// ===== RECIPE MANAGEMENT =====
async function saveRecipe() {
    // Collect form data
    const productName = document.getElementById('recipe-product-name')?.value || '';
    const batchNumber = document.getElementById('recipe-batch-number')?.value || '';
    const sampleSize = document.getElementById('sample-size')?.value || '';

    // Validate required fields
    if (!productName.trim()) {
        alert('Please enter a Product Name before saving the recipe.');
        return false;
    }
    const sampleNum = parseInt(sampleSize, 10);
    if (!sampleSize.trim() || isNaN(sampleNum) || sampleNum < 1 || sampleNum > 100) {
        alert('Please enter Sample Size (1-100) before saving.');
        return false;
    }

    // Get parameters with values
    const parameters = {};
    const thicknessCheckbox = document.getElementById('param-thickness');
    const diameterCheckbox = document.getElementById('param-diameter');
    const hardnessCheckbox = document.getElementById('param-hardness');

    const paramItems = document.querySelectorAll('.parameter-item');
    const parameterSamples = {};
    const labelToSamplesId = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };

    var shapeAwareSamplesId = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };
    if (currentShape === 'oblong') shapeAwareSamplesId['Length'] = 'param-samples-diameter';

    paramItems.forEach((item) => {
        const checkbox = item.querySelector('input[type="checkbox"]');
        const input = item.querySelector('.param-value');
        const label = item.querySelector('.checkbox-label span')?.textContent || '';

        if (checkbox?.checked) {
            let val = input?.value ?? '';
            if (val === '' && paramTolerances[label] != null && paramTolerances[label].nominal !== undefined && paramTolerances[label].nominal !== '') {
                val = String(paramTolerances[label].nominal);
            }
            parameters[label] = val || '';
            const samplesId = shapeAwareSamplesId[label] || labelToSamplesId[label];
            if (samplesId) {
                const samplesEl = document.getElementById(samplesId);
                const raw = samplesEl ? (samplesEl.value || '').trim() : '';
                const totalN = Math.min(parseInt(sampleSize) || 10, 100);
                if (raw === '') {
                    parameterSamples[label] = 0;
                } else {
                    let n = parseInt(raw, 10);
                    if (isNaN(n)) {
                        n = 0;
                    }
                    if (n < 0) n = 0;
                    if (n > totalN) n = totalN;
                    parameterSamples[label] = n;
                }
            }
        }
    });

    const totalSamples = Math.min(parseInt(sampleSize) || 10, 100);
    if (Object.keys(parameterSamples).length > 0) {
        const atLeastOneEqualsTotal = Object.values(parameterSamples).some(function (v) { return parseInt(v, 10) === totalSamples; });
        if (!atLeastOneEqualsTotal) {
            alert('At least one parameter sample should be equal to the total number of samples.');
            return null;
        }
    }

    // Validate tolerance for each selected parameter (recipe save only)
    const missingToleranceParams = [];
    Object.keys(parameters).forEach(function (label) {
        if (label === 'Weight') return;
        var tol = paramTolerances[label];
        var nom = tol && tol.nominal;
        var hasNominal = nom !== undefined && nom !== null && nom !== '' && (typeof nom !== 'string' || String(nom).trim() !== '');
        if (!tol || !hasNominal) missingToleranceParams.push(label);
    });
    if (missingToleranceParams.length > 0) {
        showModal('Tolerance required', 'Please set tolerance for: ' + missingToleranceParams.join(', ') + ' before saving the recipe.');
        return null;
    }

    // Get selected unit
    const unitSelect = document.getElementById('unit-selector'); // Updated to ID
    let unit = unitSelect ? unitSelect.value : 'Newton (N)';

    let conversionFactor = null;
    if (unit === 'User Defined') {
        const customUnitInput = document.getElementById('custom-unit-input');
        if (customUnitInput && customUnitInput.value.trim() !== '') {
            unit = customUnitInput.value.trim();
        }
        conversionFactor = customUnitConversionFactor || null;
    }

    // Validate hardness nominal is in 0-500 N (after conversion) for all units (N, KGF, SC, User Defined)
    if (parameters.Hardness !== undefined && parameters.Hardness !== null && String(parameters.Hardness).trim() !== '') {
        var hN = hardnessValueToNewton(parameters.Hardness, unit, conversionFactor);
        if (!isNaN(hN) && (hN < 0 || hN > 500)) {
            showModal('Invalid hardness', 'Enter the valid range 0-500 N');
            return null;
        }
    }

    const modeEl = document.querySelector('input[name="mode"]:checked');
    const delayEl = document.getElementById('recipe-delay');
    const distanceUnitEl = document.getElementById('distance-unit-selector');
    const distanceUnit = distanceUnitEl ? distanceUnitEl.value : 'mm';
    const weightUnitEl = document.getElementById('weight-unit-selector');
    const weightUnit = weightUnitEl ? weightUnitEl.value : 'gm';

    // Create recipe object
    const recipe = {
        name: productName,
        productName: productName,
        batchNumber: batchNumber,
        sampleSize: totalSamples,
        parameters: parameters,
        parameterSamples: parameterSamples,
        parameterTolerances: { ...paramTolerances },
        hardnessRange: '500',
        unit: unit,
        distanceUnit: distanceUnit,
        weightUnit: weightUnit,
        shape: currentShape,
        conversionFactor: conversionFactor,
        mode: modeEl?.value || 'auto',
        delay: (delayEl && delayEl.value) ? delayEl.value : '',
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString()
    };

    try {
        // Save to backend API (PUT for edit, POST for create)
        const url = editingRecipeId
            ? `/api/data/recipes/${editingRecipeId}`
            : '/api/data/recipes';
        const method = editingRecipeId ? 'PUT' : 'POST';
        const result = await apiRequest(url, {
            method: method,
            body: JSON.stringify(recipe)
        });
        if (editingRecipeId) editingRecipeId = null;
        console.log('Recipe saved:', result.recipe || result);
        return result.recipe || result;
    } catch (e) {
        console.error('Failed to save recipe:', e);
        var msg = (e && e.message) ? String(e.message) : '';
        if (msg.indexOf('valid range 0-500 N') !== -1) {
            showModal('Invalid hardness', 'Enter the valid range 0-500 N');
        } else {
            alert('Failed to save recipe: ' + msg);
        }
        return null;
    }
}

async function getRecipes() {
    try {
        const result = await apiRequest('/api/data/recipes');
        return result.recipes || [];
    } catch (e) {
        console.error('Failed to fetch recipes:', e);
        return [];
    }
}

async function deleteRecipe(recipeId) {
    // Check RBAC permission
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        const role = getCurrentRole();
        if (!canPerformAction(role, 'recipe-delete', 'delete')) {
            alert('You do not have permission to delete recipes.');
            return;
        }
    }
    
    try {
        await apiRequest(`/api/data/recipes/${recipeId}`, { method: 'DELETE' });
        // Refresh the recipe list display
        displayRecipeList();
    } catch (e) {
        console.error('Failed to delete recipe:', e);
        alert('Failed to delete recipe: ' + e.message);
    }
}

async function displayRecipeList() {
    showLoadingModal('Loading recipes...');
    try {
        var recipes = await getRecipes();
    } finally {
        hideLoadingModal();
    }
    const container = document.querySelector('.recipe-list-container');

    if (!container) return;

    // Toggle load-only class on parent for CSS (no horizontal scroll on Load Recipe)
    const manageContainer = container.closest('.manage-recipes-container');
    if (manageContainer) {
        if (recipeListLoadOnly) manageContainer.classList.add('recipe-load-only');
        else manageContainer.classList.remove('recipe-load-only');
    }

    if (recipes.length === 0) {
        container.innerHTML = '<p class="empty-state-message">No recipes saved yet. Create a recipe in Quick Test to get started.</p>';
        return;
    }

    // Sort by most recent
    recipes.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    lastDisplayedRecipes = recipes;

    // Show nominal: from parameters (e.g. from form) or from parameterTolerances.nominal (entered in tolerance modal)
    const getParamDisplay = (recipe, key) => {
        const p = normalizeRecipeParameters(recipe.parameters || {});
        const val = (p && (p[key] ?? p[key.toLowerCase()]));
        if (val != null && val !== '') return String(val);
        const tol = recipe.parameterTolerances || {};
        const tolKey = Object.keys(tol).find(k => (k || '').toLowerCase() === key.toLowerCase());
        if (tolKey != null && tol[tolKey] && tol[tolKey].nominal !== undefined && tol[tolKey].nominal !== '') {
            return String(tol[tolKey].nominal);
        }
        return '--';
    };

    // Load Recipe: Product, 6 params, Load (no Shape). Manage Recipes: Product, 6 params, Actions only (no Shape, no Load)
    const showActions = !recipeListLoadOnly;
    const showLoad = recipeListLoadOnly;
    let html = `
        <table class="recipe-table">
            <thead>
                <tr>
                    <th>Product</th>
                    <th>Thickness</th>
                    <th>Diameter</th>
                    <th>Width</th>
                    <th>Length</th>
                    <th>Hardness</th>
                    <th>Weight</th>` +
        (showLoad ? '<th>Load</th>' : '') +
        (showActions ? '<th class="actions-col">Actions</th>' : '') + `
                </tr>
            </thead>
            <tbody>
    `;

    recipes.forEach(recipe => {
        const thickness = getParamDisplay(recipe, 'Thickness');
        const diameter = getParamDisplay(recipe, 'Diameter');
        const width = getParamDisplay(recipe, 'Width');
        const length = getParamDisplay(recipe, 'Length');
        const hardness = getParamDisplay(recipe, 'Hardness');
        const weight = getParamDisplay(recipe, 'Weight');

        const loadBtnHtml = '<button class="btn-action btn-load" onclick="loadRecipeById(' + recipe.id + ')" title="Load">Load</button>';
        const actionsBtnHtml = showActions ? `
                    <button class="btn-action btn-actions" onclick="openRecipeActionsModal(${recipe.id})" title="Edit / Delete">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1"></circle>
                            <circle cx="12" cy="5" r="1"></circle>
                            <circle cx="12" cy="19" r="1"></circle>
                        </svg>
                        Actions
                    </button>` : '';
        html += `
            <tr>
                <td>${recipe.productName}</td>
                <td>${thickness}</td>
                <td>${diameter}</td>
                <td>${width}</td>
                <td>${length}</td>
                <td>${hardness}</td>
                <td>${weight}</td>` +
        (showLoad ? '<td class="load-cell">' + loadBtnHtml + '</td>' : '') +
        (showActions ? '<td class="actions-cell actions-col">' + actionsBtnHtml + '</td>' : '') + `
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    `;

    container.innerHTML = html;
}

function openRecipeActionsModal(recipeId) {
    window._recipeActionsId = recipeId;
    var recipe = lastDisplayedRecipes && lastDisplayedRecipes.find(function (r) { return r.id === recipeId; });
    var titleEl = document.getElementById('recipe-actions-modal-title');
    if (titleEl) titleEl.textContent = recipe && recipe.productName ? recipe.productName : 'Recipe';
    var editBtn = document.getElementById('recipe-action-edit-btn');
    var deleteBtn = document.getElementById('recipe-action-delete-btn');
    if (recipeListLoadOnly) {
        if (editBtn) editBtn.style.display = 'none';
        if (deleteBtn) deleteBtn.style.display = 'none';
    } else {
        if (editBtn) editBtn.style.display = '';
        if (deleteBtn) deleteBtn.style.display = '';
    }
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'flex';
}

function closeRecipeActionsModal() {
    window._recipeActionsId = null;
    var overlay = document.getElementById('recipe-actions-modal-overlay');
    if (overlay) overlay.style.display = 'none';
}

function confirmRecipeAction(action) {
    var id = window._recipeActionsId;
    closeRecipeActionsModal();
    if (id == null) return;
    if (action === 'edit') {
        editRecipe(id);
    } else if (action === 'delete') {
        deleteRecipe(id);
    } else if (action === 'load') {
        loadRecipeById(id);
    }
}

// Load recipe by ID - show batch number popup first; keep "Loading..." visible at least 3s for feedback
var LOAD_RECIPE_MIN_LOADING_MS = 3000;

function _hideLoadingAfterMinDuration(loadStartMs, thenShowBatch) {
    var elapsed = Date.now() - loadStartMs;
    var remain = Math.max(0, LOAD_RECIPE_MIN_LOADING_MS - elapsed);
    setTimeout(function () {
        hideLoadingModal();
        if (typeof thenShowBatch === 'function') thenShowBatch();
    }, remain);
}

async function loadRecipeById(recipeId) {
    var loadStart = Date.now();
    showLoadingModal('Loading...');
    var cached = lastDisplayedRecipes && lastDisplayedRecipes.find(function (r) { return r.id === recipeId; });
    if (cached) {
        pendingRecipeToLoad = cached;
        _hideLoadingAfterMinDuration(loadStart, showBatchNumberModal);
        return;
    }
    try {
        var result = await apiRequest('/api/data/recipes/' + recipeId);
        var recipe = result.recipe;

        if (!recipe) {
            _hideLoadingAfterMinDuration(loadStart, function () { alert('Recipe not found!'); });
            return;
        }

        pendingRecipeToLoad = recipe;
        _hideLoadingAfterMinDuration(loadStart, showBatchNumberModal);
    } catch (e) {
        console.error('Failed to load recipe:', e);
        _hideLoadingAfterMinDuration(loadStart, function () {
            alert('Failed to load recipe: ' + (e.message || 'Unknown error'));
        });
    }
}

// Show batch number modal
function showBatchNumberModal() {
    const modal = document.getElementById('batch-number-modal');
    const batchInput = document.getElementById('load-recipe-batch-input');
    
    if (modal) {
        // Always clear the input field when modal appears
        if (batchInput) {
            batchInput.value = '';
        }
        modal.style.display = 'flex';
        // Focus on input after modal is shown
        setTimeout(() => {
            if (batchInput) {
                batchInput.focus();
                batchInput.select(); // Select any existing text for easy replacement
            }
        }, 100);
    }
}

// Close batch number modal
function closeBatchNumberModal() {
    const modal = document.getElementById('batch-number-modal');
    if (modal) modal.style.display = 'none';
    pendingRecipeToLoad = null;
}

// Confirm batch number and load recipe
function confirmBatchNumberAndLoad() {
    const batchInput = document.getElementById('load-recipe-batch-input');
    
    if (!batchInput || !batchInput.value.trim()) {
        alert('Please enter a batch number');
        if (batchInput) batchInput.focus();
        return;
    }
    
    if (!pendingRecipeToLoad) {
        alert('No recipe to load');
        closeBatchNumberModal();
        return;
    }
    
    // Update recipe with new batch number
    const batchNumber = batchInput.value.trim();
    const recipeToLoad = { ...pendingRecipeToLoad };
    recipeToLoad.batchNumber = batchNumber;
    
    closeBatchNumberModal();
    // Safety: ensure we still mark this run as load-recipe before backoff/test begins.
    currentTest = 'load-recipe';
    lastTestRunRecipe = recipeToLoad;
    loadRecipeRunPending = true;
    showBackoffModal();
}

// Weight entry modal (manual input during test run)
var pendingWeightEntryResolve = null;
function showWeightEntryModal() {
    return new Promise(function (resolve) {
        pendingWeightEntryResolve = resolve;
        var modal = document.getElementById('weight-entry-modal');
        var input = document.getElementById('weight-entry-modal-input');
        var promptEl = document.getElementById('weight-entry-modal-prompt');
        var wu = (lastTestRunRecipe && lastTestRunRecipe.weightUnit) ? lastTestRunRecipe.weightUnit : 'gm';
        if (promptEl) promptEl.textContent = 'Enter the measured value of the tablet in the weighing scale (' + wu + '):';
        if (input) input.placeholder = 'Enter weight in ' + wu;
        if (modal && input) {
            input.value = '';
            modal.style.display = 'flex';
            setTimeout(function () { input.focus(); }, 100);
        } else {
            if (pendingWeightEntryResolve) pendingWeightEntryResolve(null);
            pendingWeightEntryResolve = null;
        }
    });
}
function closeWeightEntryModal() {
    var modal = document.getElementById('weight-entry-modal');
    if (modal) modal.style.display = 'none';
    if (pendingWeightEntryResolve) {
        pendingWeightEntryResolve(null);
        pendingWeightEntryResolve = null;
    }
}
function onWeightEntryCancelClick() {
    showModal(
        'Do you want to abort the test?',
        'If you abort, the current test run will stop and a partial report may be saved.',
        function (confirmed) {
            if (confirmed) closeWeightEntryModal();
        },
        true,
        true,
        'Abort',
        'No'
    );
}
function confirmWeightEntryModal() {
    var input = document.getElementById('weight-entry-modal-input');
    if (!input) return;
    var raw = (input.value || '').trim();
    if (!raw) {
        alert('Please enter a valid measured value (grams)');
        if (input) input.focus();
        return;
    }
    var val = parseFloat(raw);
    if (isNaN(val) || val < 0) {
        alert('Please enter a valid measured value (grams)');
        if (input) input.focus();
        return;
    }
    var modal = document.getElementById('weight-entry-modal');
    if (modal) modal.style.display = 'none';
    if (pendingWeightEntryResolve) {
        pendingWeightEntryResolve(val);
        pendingWeightEntryResolve = null;
    }
}

// Edit Recipe (Triggered by Edit button)
async function editRecipe(recipeId) {
    const recipes = await getRecipes();
    const recipe = recipes.find(r => r.id === recipeId);

    if (!recipe) {
        alert('Recipe not found!');
        return;
    }

    editingRecipeId = recipeId;
    currentTest = 'create-recipe';
    currentShape = recipe.shape || currentShape;
    goToPage('quick-test');

    // Populate fields and show step 1 (same as create: one page with Save)
    setTimeout(() => {
        const step1El = document.getElementById('form-step-1');
        const step2El = document.getElementById('form-step-2');
        if (step1El) step1El.style.display = 'grid';
        if (step2El) step2El.style.display = 'none';

        const titleEl = document.querySelector('#page-quick-test .section-title');
        if (titleEl) titleEl.textContent = 'Edit Recipe';
        const step1Btn = document.querySelector('#form-step-1 .btn-primary');
        if (step1Btn) step1Btn.textContent = 'Save';

        updateShapeInputs();

        // Populate Product Name (first input in form)
        const productNameInput = document.getElementById('recipe-product-name');
        if (productNameInput) productNameInput.value = recipe.productName || '';

        // Populate Batch and Sample Size
        const batchNumberInput = document.getElementById('recipe-batch-number');
        const sampleSizeInput = document.getElementById('sample-size');
        if (batchNumberInput) batchNumberInput.value = recipe.batchNumber || '';
        if (sampleSizeInput) sampleSizeInput.value = recipe.sampleSize || 10;

        // Populate parameters and parameter samples
        const labelToSamplesId = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };
        const paramItems = document.querySelectorAll('.parameter-item');
        paramItems.forEach((item) => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            const input = item.querySelector('.param-value');
            const label = item.querySelector('.checkbox-label span')?.textContent || '';

            if (recipe.parameters && recipe.parameters[label] !== undefined) {
                if (checkbox) checkbox.checked = true;
                if (input) input.value = recipe.parameters[label] || '';
                const samplesId = labelToSamplesId[label];
                if (samplesId) {
                    const samplesEl = document.getElementById(samplesId);
                    const ps = recipe.parameterSamples || {};
                    if (samplesEl) samplesEl.value = ps[label] !== undefined ? ps[label] : (recipe.sampleSize || 10);
                }
            } else {
                if (checkbox) checkbox.checked = false;
                if (input) input.value = '';
            }
        });

        if (recipe.parameterTolerances) paramTolerances = { ...recipe.parameterTolerances };

        // Set unit
        const unitSelect = document.getElementById('unit-selector');
        if (unitSelect && recipe.unit) {
            unitSelect.value = recipe.unit;
            // Handle custom unit if needed
            toggleUnitInput(); // if we had this helper
            if (recipe.unit !== 'Newton (N)' && recipe.unit !== 'KGF' && recipe.unit !== 'Strong Cobb (SC)') {
                unitSelect.value = 'User Defined';
                toggleUnitInput();
                const customInput = document.getElementById('custom-unit-input');
                if (customInput) customInput.value = recipe.unit;
                // Restore conversion factor if it exists
                if (recipe.conversionFactor !== undefined && recipe.conversionFactor !== null) {
                    customUnitConversionFactor = recipe.conversionFactor;
                    const conversionFactorInput = document.getElementById('conversion-factor-input');
                    if (conversionFactorInput) conversionFactorInput.value = String(recipe.conversionFactor);
                    // Update display
                    updateConversionFactorDisplay(recipe.unit, recipe.conversionFactor);
                }
            }
        }
        const distanceUnitSel = document.getElementById('distance-unit-selector');
        if (distanceUnitSel && recipe.distanceUnit) distanceUnitSel.value = recipe.distanceUnit;
        const weightUnitSel = document.getElementById('weight-unit-selector');
        if (weightUnitSel && recipe.weightUnit) weightUnitSel.value = recipe.weightUnit;
    }, 200);
}

// ===== TEST RUN LOGIC =====
var testRunActive = false;
var testRunPaused = false;
var testRunAborted = false;
var testRunCurrentSample = 0;
var testRunTotalSamples = 10;
var testRunManualWaitingForStart = false;
var testRunManualContinueResolve = null;
var backoffAbortHandled = false;

function startTestRun(recipe) {
    console.log("Starting test run for:", recipe);
    if (recipe && recipe.parameters) {
        recipe.parameters = normalizeRecipeParameters(recipe.parameters);
    }
    lastTestRunRecipe = recipe;
    testRunActive = false;
    unlockNavigation();
    testRunPaused = false;
    testRunAborted = false;
    testRunManualWaitingForStart = false;
    testRunManualContinueResolve = null;
    goToPage('test-run');

    // Basic helpers
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    // Use only parameters explicitly selected in recipe (do NOT merge from tolerances)
    const rawParams = recipe.parameters || {};
    const canonicalKeys = ['Thickness', 'Diameter', 'Width', 'Length', 'Hardness', 'Weight'];
    const params = {};
    canonicalKeys.forEach(function (key) {
        var val = rawParams[key] ?? rawParams[Object.keys(rawParams).find(function (k) { return (k || '').toLowerCase() === key.toLowerCase(); })];
        if (val != null && val !== '') {
            params[key] = val;
        }
    });
    Object.keys(rawParams).forEach(function (k) {
        var c = canonicalKeys.find(function (c) { return (c || '').toLowerCase() === (k || '').toLowerCase(); });
        if (c && !(c in params)) {
            var v = rawParams[k];
            params[c] = (v != null && v !== '') ? v : '0';
        }
    });
    recipe.parameters = params;

    // Update Header / Product Info
    const productName = recipe.productName || 'Unknown';
    setText('run-product-name', productName);
    setText('run-batch-no', recipe.batchNumber || recipe.batch || recipe.batchNo || '--');

    // Reset control buttons
    const btnAction = document.getElementById('btn-test-start-abort');

    if (btnAction) {
        btnAction.className = 'btn-ctrl start header-btn';
        btnAction.innerHTML = '<div class="ctrl-icon">▶</div><span>START</span>';
        btnAction.dataset.state = 'start';
        btnAction.classList.remove('danger');
    }

    // === Top metric cards (shape-specific layout) ===
    const shape = (recipe.shape || currentShape || 'round').toLowerCase();

    // Show/hide cards based on selected parameters in recipe
    const thicknessCard = document.querySelector('#page-test-run .metric-card.card-thickness');
    const diaCard = document.querySelector('#page-test-run .metric-card.card-lengthdia');
    const widthCard = document.querySelector('#page-test-run .run-card-oblong-only');
    const hardnessCard = document.querySelector('#page-test-run .metric-card.card-hardness');
    const weightCard = document.querySelector('#page-test-run .metric-card.card-weight');

    if (thicknessCard) thicknessCard.style.display = ('Thickness' in params) ? 'flex' : 'none';
    if (diaCard) diaCard.style.display = (('Diameter' in params) || ('Length' in params)) ? 'flex' : 'none';
    if (widthCard) widthCard.style.display = (shape === 'oblong' && ('Width' in params)) ? 'flex' : 'none';
    if (hardnessCard) hardnessCard.style.display = ('Hardness' in params) ? 'flex' : 'none';
    if (weightCard) weightCard.style.display = ('Weight' in params) ? 'flex' : 'none';

    var diaLengthVal = (shape === 'oblong' ? params.Length : params.Diameter);
    const diaLengthLabel = document.getElementById('run-dia-length-label');
    if (diaLengthLabel) {
        diaLengthLabel.textContent = shape === 'oblong' ? 'Length' : 'Diameter';
    }
    setText('run-lengthdia-val', (diaLengthVal != null && diaLengthVal !== '') ? (function(){ var n = Number(diaLengthVal); return (isNaN(n) || n <= 0) ? '0.00' : n.toFixed(2); }()) : '--');
    setText('run-thickness-val', (params.Thickness != null && params.Thickness !== '') ? (function(){ var n = Number(params.Thickness); return (isNaN(n) || n <= 0) ? '0.00' : n.toFixed(2); }()) : '--');
    setText('run-width-val', (params.Width != null && params.Width !== '') ? (function(){ var n = Number(params.Width); return (isNaN(n) || n <= 0) ? '0.00' : n.toFixed(2); }()) : '--');
    setText('run-weight-val', params.Weight || '--');
    var runWeightUnitEl = document.getElementById('run-weight-unit');
    if (runWeightUnitEl) runWeightUnitEl.textContent = recipe.weightUnit || 'gm';

    // Shape text and icon
    setText('run-shape-val', shape.charAt(0).toUpperCase() + shape.slice(1));
    const shapeIconRound = document.getElementById('run-shape-icon-round');
    const shapeIconOblong = document.getElementById('run-shape-icon-oblong');
    if (shapeIconRound && shapeIconOblong) {
        shapeIconRound.style.display = shape === 'round' ? '' : 'none';
        shapeIconOblong.style.display = shape === 'oblong' ? '' : 'none';
    }

    // Unit display
    const fullUnit = recipe.unit || 'Newton (N)';
    const unitLower = fullUnit.toLowerCase();
    let unitShort = 'N';
    if (unitLower.includes('kgf')) unitShort = 'KGF';
    else if (unitLower.includes('strong') || unitLower.includes('cobb')) unitShort = 'SC';
    else if (!unitLower.includes('newton')) unitShort = fullUnit;

    setText('run-unit-short', unitShort);
    setText('run-unit-full', fullUnit);

    const distanceUnit = recipe.distanceUnit || 'mm';
    setText('run-thickness-unit', distanceUnit);
    setText('run-lengthdia-unit', distanceUnit);
    setText('run-width-unit', distanceUnit);

    // Hardness target card (e.g. "1 N")
    const hardnessTargetVal = params.Hardness && params.Hardness !== ''
        ? `${params.Hardness} ${unitShort}`
        : `-- ${unitShort}`;
    setText('run-hardness-target', hardnessTargetVal);

    // Total samples card
    const sampleSize = parseInt(recipe.sampleSize) || 10;
    setText('run-sample-count', String(sampleSize).padStart(2, '0'));

    updateTestRunParamCardsState(1, recipe);
}

function updateTestRunSampleProgress(currentIndex, totalSamples) {
    const el = document.getElementById('run-sample-count');
    if (!el) return;
    const total = parseInt(totalSamples) || 0;
    const current = parseInt(currentIndex) || 0;
    if (total <= 0) {
        el.textContent = '--';
    } else if (current > 0 && current <= total) {
        el.textContent = current + ' / ' + total;
    } else {
        el.textContent = String(total).padStart(2, '0');
    }
}

function updateTestRunParamCardsState(sampleIndex, recipe) {
    var paramsToMeasure = getParametersForSample(sampleIndex, recipe);
    var isActive = function (paramName) { return paramsToMeasure.indexOf(paramName) !== -1; };
    var cardParamMap = [
        { card: document.querySelector('#page-test-run .metric-card.card-thickness'), params: ['Thickness'] },
        { card: document.querySelector('#page-test-run .metric-card.card-width'), params: ['Width'] },
        { card: document.querySelector('#page-test-run .metric-card.card-weight'), params: ['Weight'] },
        { card: document.querySelector('#page-test-run .metric-card.card-lengthdia'), params: ['Diameter', 'Length'] },
        { card: document.querySelector('#page-test-run .metric-card.card-hardness'), params: ['Hardness'] }
    ];
    var params = recipe.parameters || {};
    var hasParam = function (p) {
        return Object.keys(params).some(function (k) { return (k || '').toLowerCase() === (p || '').toLowerCase(); });
    };
    cardParamMap.forEach(function (entry) {
        if (!entry.card) return;
        var active = entry.params.some(function (p) { return hasParam(p) && isActive(p); });
        if (active) {
            entry.card.classList.remove('param-completed');
        } else {
            entry.card.classList.add('param-completed');
        }
    });
}

// Clear all test-run display values when test ends (before navigating away)
function clearTestRunDisplay() {
    var ids = ['run-thickness-val', 'run-lengthdia-val', 'run-width-val', 'run-hardness-val', 'run-weight-val',
        'run-thickness-status', 'run-lengthdia-status', 'run-width-status', 'run-hardness-status', 'run-weight-status'];
    ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.textContent = '--';
    });
    var sampleEl = document.getElementById('run-sample-count');
    if (sampleEl) sampleEl.textContent = '--';
}

// Normalize parameter keys to capitalized (Thickness, Diameter, etc.) for consistent use
function normalizeRecipeParameters(parameters) {
    if (!parameters || typeof parameters !== 'object') return {};
    var canonical = { Thickness: 'Thickness', Diameter: 'Diameter', Width: 'Width', Length: 'Length', Hardness: 'Hardness', Weight: 'Weight' };
    var out = {};
    Object.keys(parameters).forEach(function (k) {
        var key = k;
        for (var c in canonical) {
            if (c.toLowerCase() === (k || '').toLowerCase()) { key = c; break; }
        }
        var v = parameters[k];
        if (v != null && (v !== '' || v === 0 || (typeof v === 'number' && !isNaN(v)))) out[key] = v;
    });
    return out;
}

function getOrderedParamsForTest(recipe) {
    var params = recipe.parameters || {};
    var ps = recipe.parameterSamples || {};
    var shape = (recipe.shape || 'round').toLowerCase();
    var order = ['Thickness', 'Width', 'Weight', 'Length', 'Hardness'];
    if (shape !== 'oblong') order = ['Thickness', 'Diameter', 'Weight', 'Hardness'];
    // Case-insensitive key match; treat numeric 0 and numeric values as present
    return order.filter(function (p) {
        var key = Object.keys(params).find(function (k) { return (k || '').toLowerCase() === p.toLowerCase(); });
        if (key == null) return false;
        var v = params[key];
        if (v !== '' && (v != null || v === 0) && (typeof v === 'number' ? !isNaN(v) : true)) {
            // Exclude parameters with 0 sample size; if no per-param samples, include (backward compat)
            if (!Object.prototype.hasOwnProperty.call(ps, p)) return true;
            return (parseInt(ps[p], 10) || 0) > 0;
        }
        return false;
    });
}

// Convert mm (ESP) to inch for display and storage when user selects inch
function mmToInch(mm) {
    if (mm == null || typeof mm !== 'number' || isNaN(mm)) return mm;
    return mm / 25.4;
}

// Convert hardness from Newtons (ESP) to user-selected unit for display and storage
function hardnessNewtonToUserUnit(valueN, unit, conversionFactor) {
    if (valueN == null || typeof valueN !== 'number' || isNaN(valueN)) return valueN;
    var u = (unit || '').toString().toLowerCase();
    if (u.includes('newton') || unit === 'Newton (N)') return valueN;
    if (u.includes('kgf')) return valueN / 9.80665;
    if (u.includes('strong') || u.includes('cobb') || u.includes('(sc)')) return valueN * 0.1428;  // 1 N = 0.1428 SC
    if (conversionFactor != null && typeof conversionFactor === 'number' && conversionFactor > 0) return valueN / conversionFactor;
    return valueN;
}

// Convert hardness value (in display unit) to Newton for range validation. Mirrors backend _hardness_to_newton.
function hardnessValueToNewton(value, unit, conversionFactor) {
    var v = parseFloat(value);
    if (isNaN(v)) return NaN;
    var u = (unit || '').toString().toLowerCase();
    if (u.includes('newton') || unit === 'Newton (N)') return v;
    if (u.includes('kgf') || u.includes('kilogram')) return v * 9.80665;
    if (u.includes('strong') || u.includes('cobb')) return v * (1 / 0.1428);  // SC to N: 1 N = 0.1428 SC
    if (conversionFactor != null && typeof conversionFactor === 'number' && conversionFactor > 0) return v * conversionFactor;
    return v;
}

// Compute per-parameter statistics (mean, max, min, range, std_dev, srel) from array of numbers
function computeParamStatistics(arr) {
    var valid = (arr || []).filter(function (x) { return x != null && !isNaN(parseFloat(x)); }).map(Number);
    if (valid.length === 0) return { count: 0, mean: null, max: null, min: null, range: null, std_dev: null, srel: null };
    var n = valid.length;
    var sum = valid.reduce(function (a, b) { return a + b; }, 0);
    var mean = sum / n;
    var maxVal = Math.max.apply(null, valid);
    var minVal = Math.min.apply(null, valid);
    var rangeVal = maxVal - minVal;
    var variance = n > 1 ? valid.reduce(function (acc, x) { return acc + (x - mean) * (x - mean); }, 0) / (n - 1) : 0;
    var stdDev = Math.sqrt(variance);
    var srel = mean !== 0 ? (stdDev / Math.abs(mean)) * 100 : 0;
    return {
        count: n,
        mean: Math.round(mean * 100) / 100,
        max: Math.round(maxVal * 100) / 100,
        min: Math.round(minVal * 100) / 100,
        range: Math.round(rangeVal * 100) / 100,
        std_dev: Math.round(stdDev * 100) / 100,
        srel: Math.round(srel * 100) / 100
    };
}

async function runHardnessTestLoop() {
    var recipe = lastTestRunRecipe;
    if (!recipe) return;
    var params = recipe.parameters || {};
    if (getParametersForSample(1, recipe).length === 0) {
        alert('No parameters selected. Please select at least one parameter with sample size > 0 in the recipe.');
        return;
    }
    var sampleSize = parseInt(recipe.sampleSize) || 10;
    var mode = recipe.mode || 'auto';
    var delaySeconds = 2; // Default delay
    if (mode === 'auto') {
        // Priority 1: recipe.delay (set from form/modal) - this is the source of truth
        if (recipe.delay !== undefined && recipe.delay !== null && recipe.delay !== '') {
            const d = parseInt(recipe.delay, 10);
            if (!isNaN(d) && d >= 2 && d <= 30) {
                delaySeconds = d;
            }
        }
        // Priority 2: hidden input field (fallback)
        if (delaySeconds === 2) {
            const delayEl = document.getElementById('recipe-delay');
            if (delayEl && delayEl.value) {
                const d = parseInt(delayEl.value, 10);
                if (!isNaN(d) && d >= 2 && d <= 30) delaySeconds = d;
            }
        }
        // Priority 3: lastSelectedDelay (cached value, fallback)
        if (delaySeconds === 2 && lastSelectedDelay != null && !isNaN(lastSelectedDelay)) {
            delaySeconds = Math.min(30, Math.max(2, parseInt(lastSelectedDelay, 10) || 2));
        }
    }
    if (delaySeconds < 2) delaySeconds = 2;
    if (delaySeconds > 30) delaySeconds = 30;
    var delayMs = delaySeconds * 1000;
    var fullUnit = recipe.unit || 'Newton (N)';
    var unitShort = 'N';
    if (typeof fullUnit === 'string') {
        var lower = fullUnit.toLowerCase();
        if (lower.includes('kgf')) unitShort = 'KGF';
        else if (lower.includes('strong') || lower.includes('cobb')) unitShort = 'SC';
    }
    var tolerances = recipe.parameterTolerances || {};
    var conversionFactor = recipe.conversionFactor != null ? parseFloat(recipe.conversionFactor) : null;
    lastTestRunMeasurements = { Thickness: [], Diameter: [], Width: [], Length: [], Hardness: [], Weight: [] };
    var measurements = lastTestRunMeasurements;
    var btnAction = document.getElementById('btn-test-start-abort');
    var setDimEl = function (id, val) {
        var el = document.getElementById(id);
        if (!el) return;
        if (val == null) { el.textContent = '--'; return; }
        var n = typeof val === 'number' ? val : parseFloat(val);
        el.textContent = (typeof n === 'number' && !isNaN(n) && n <= 0) ? '0.00' : (typeof val === 'number' ? val.toFixed(2) : (isNaN(n) ? '--' : n.toFixed(2)));
    };
    var setHardnessEl = function (val) {
        var el = document.getElementById('run-hardness-target');
        if (!el) return;
        if (val == null) { el.textContent = '-- ' + unitShort; return; }
        if (val === 'OL' || (typeof val === 'string' && val.toUpperCase() === 'OL')) { el.textContent = 'OL ' + unitShort; return; }
        el.textContent = (typeof val === 'number' ? val.toFixed(2) : String(val)) + ' ' + unitShort;
    };

    testRunTotalSamples = sampleSize;
    testRunStartTime = Date.now();
    var firstEspCommandDone = false;

    for (var s = 1; s <= sampleSize; s++) {
        if (testRunAborted) break;

        testRunCurrentSample = s;
        updateTestRunSampleProgress(s, sampleSize);
        updateTestRunParamCardsState(s, recipe);
        setDimEl('run-thickness-val', null);
        setDimEl('run-lengthdia-val', null);
        setDimEl('run-width-val', null);
        setHardnessEl(null);
        var runWeightEl = document.getElementById('run-weight-val');
        if (runWeightEl) runWeightEl.textContent = '--';
        ['run-thickness-status', 'run-lengthdia-status', 'run-width-status', 'run-hardness-status', 'run-weight-status'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) { el.textContent = '--'; el.removeAttribute('data-status'); }
        });

        var paramsToMeasure = getParametersForSample(s, recipe);
        for (var pi = 0; pi < paramsToMeasure.length; pi++) {
            if (testRunAborted) break;
            var paramName = paramsToMeasure[pi];
            var isHardness = paramName === 'Hardness';
            var nominal = parseFloat(params[paramName]) || 0;
            var toleranceConfig = tolerances[paramName] || null;

            try {
                var data;
                var response;
                var parsedVal = null;
                var isOL = false;
                if (paramName === 'Weight') {
                    var weightVal = await showWeightEntryModal();
                    if (weightVal == null || (typeof weightVal !== 'number' && isNaN(parseFloat(weightVal)))) {
                        testRunAborted = true;
                        break;
                    }
                    parsedVal = typeof weightVal === 'number' ? weightVal : parseFloat(weightVal);
                    if (measurements.Weight) measurements.Weight.push(parsedVal);
                    var runWeightEl = document.getElementById('run-weight-val');
                    if (runWeightEl) runWeightEl.textContent = typeof parsedVal === 'number' && !isNaN(parsedVal) ? parsedVal.toFixed(2) : String(parsedVal);
                } else if (isHardness) {
                    if (testRunAborted) break;
                    data = await apiRequest('/api/hardware/test/hardness', { method: 'POST' });
                    firstEspCommandDone = true;
                    response = (data.response || '').trim();
                    var hardMatch = response.match(/D,HARD,([\d.]+)(?:,(MAX|BROK))?\s*\*/i);
                    if (hardMatch) {
                        var rawN = parseFloat(hardMatch[1]);
                        if (rawN > 500) {
                            isOL = true;
                            setHardnessEl('OL');
                            measurements.Hardness.push('OL');
                        } else {
                            parsedVal = hardnessNewtonToUserUnit(rawN, fullUnit, conversionFactor);
                            setHardnessEl(parsedVal);
                            if (parsedVal != null) measurements.Hardness.push(parsedVal);
                        }
                    } else {
                        setHardnessEl(null);
                    }
                } else {
                    if (testRunAborted) break;
                    data = await apiRequest('/api/hardware/test/dimension', { method: 'POST' });
                    firstEspCommandDone = true;
                    response = (data.response || '').trim();
                    var dimMatch = response.match(/D,DIM,(-?[\d.]+)\*/i);
                    if (dimMatch) {
                        var rawMm = parseFloat(dimMatch[1]);
                        parsedVal = (recipe.distanceUnit === 'inch') ? mmToInch(rawMm) : rawMm;
                        if (measurements[paramName]) measurements[paramName].push(parsedVal);
                    }
                    if (paramName === 'Thickness') setDimEl('run-thickness-val', parsedVal);
                    else if (paramName === 'Diameter' || paramName === 'Length') setDimEl('run-lengthdia-val', parsedVal);
                    else if (paramName === 'Width') setDimEl('run-width-val', parsedVal);
                }

                var isQuickTestRun = (typeof currentTest !== 'undefined' && currentTest === 'quick');
                var shouldCheckTolerance = parsedVal != null && toleranceConfig && typeof checkMeasurementAndShowFailureModalIfNeeded === 'function' && !isQuickTestRun;
                
                // Ensure Weight tolerance check happens - verify toleranceConfig exists
                if (paramName === 'Weight' && parsedVal != null && !toleranceConfig) {
                    console.warn('Weight tolerance config missing for parameter:', paramName);
                }
                
                if (shouldCheckTolerance) {
                    console.log('[DEBUG] Checking tolerance for', paramName, 'value:', parsedVal, 'nominal:', nominal, 'config:', toleranceConfig);
                    var tolResult = await new Promise(function (resolve) {
                        checkMeasurementAndShowFailureModalIfNeeded(
                            parsedVal,
                            nominal,
                            toleranceConfig,
                            function () { resolve('continue'); },
                            function () { resolve('end'); }
                        );
                    });
                    console.log('[DEBUG] Tolerance check result:', tolResult);
                    if (tolResult === 'end') {
                        testRunAborted = true;
                        break;
                    }
                }

                var statusId = (paramName === 'Thickness') ? 'run-thickness-status' : (paramName === 'Diameter' || paramName === 'Length') ? 'run-lengthdia-status' : (paramName === 'Width') ? 'run-width-status' : (paramName === 'Hardness') ? 'run-hardness-status' : (paramName === 'Weight') ? 'run-weight-status' : null;
                if (statusId) {
                    var statusEl = document.getElementById(statusId);
                    if (statusEl) {
                        var statusText = '--';
                        var dataStatus = '';
                        if (isOL) {
                            statusText = 'Fail';
                            dataStatus = 'fail';
                        } else if (parsedVal != null && typeof parsedVal === 'number' && !isNaN(parsedVal) && toleranceConfig) {
                            statusText = typeof getT1T2DisplayStatus === 'function' ? getT1T2DisplayStatus(parsedVal, nominal, toleranceConfig) : '--';
                            dataStatus = statusText === 'Pass' ? 'pass' : statusText === 'T1-T2' ? 't1-t2' : statusText === 'Fail' ? 'fail' : '';
                        }
                        statusEl.textContent = statusText;
                        if (dataStatus) statusEl.setAttribute('data-status', dataStatus); else statusEl.removeAttribute('data-status');
                    }
                }
            } catch (e) {
                console.error('Test failed for ' + paramName + ':', e);
                var msg = (e.message || 'Unknown error') + '';
                var friendlyMsg = msg.toLowerCase().indexOf('timeout') !== -1
                    ? 'Equipment did not respond within 30 seconds. Please check the device and try again.'
                    : ('Test failed: ' + msg);
                alert(friendlyMsg);
                testRunAborted = true;
                break;
            }

            if (testRunAborted) break;

            // Skip wait when last parameter of last sample is done - navigate immediately
            var isLastParamOfLastSample = (s === sampleSize && pi === paramsToMeasure.length - 1);
            if (!isLastParamOfLastSample) {
                if (mode === 'manual') {
                    testRunManualWaitingForStart = true;
                    if (btnAction) {
                        btnAction.dataset.state = 'start';
                        btnAction.className = 'btn-ctrl start header-btn';
                        btnAction.innerHTML = '<div class="ctrl-icon">▶</div><span>START</span>';
                    }
                    await new Promise(function (r) { testRunManualContinueResolve = r; });
                    testRunManualWaitingForStart = false;
                    testRunManualContinueResolve = null;
                } else {
                    await new Promise(function (r) { setTimeout(r, delayMs); });
                }
            }
        }
    }

    testRunActive = false;
    try {
        await apiRequest('/api/hardware/test/home', { method: 'POST' });
    } catch (e) {
        console.warn('Home command failed:', e);
    }

    if (btnAction) {
        btnAction.dataset.state = 'start';
        btnAction.className = 'btn-ctrl start header-btn';
        btnAction.innerHTML = '<div class="ctrl-icon">▶</div><span>START</span>';
    }
    var total = lastTestRunRecipe ? (parseInt(lastTestRunRecipe.sampleSize) || 10) : 10;
    updateTestRunSampleProgress(0, total);

    var statistics = {};
    ['Thickness', 'Diameter', 'Width', 'Length', 'Hardness', 'Weight'].forEach(function (key) {
        if (measurements[key] && measurements[key].length > 0) {
            statistics[key] = computeParamStatistics(measurements[key]);
        }
    });

    if (typeof backoffAbortHandled !== 'undefined' && backoffAbortHandled) {
        backoffAbortHandled = false;
        return;
    }

    if (lastTestRunRecipe && typeof saveReport === 'function') {
        var r = lastTestRunRecipe;
        saveReport({
            type: 'test',
            name: (r.productName || 'Test') + ' - ' + (r.batchNumber || r.batch || 'N/A'),
            productName: r.productName,
            batchNumber: r.batchNumber || r.batch,
            shape: r.shape,
            parameters: r.parameters,
            parameterSamples: r.parameterSamples || {},
            unit: r.unit,
            conversionFactor: r.conversionFactor,
            sampleSize: r.sampleSize,
            mode: r.mode || 'auto',
            status: testRunAborted ? 'aborted' : 'Completed',
            measurements: measurements,
            statistics: statistics,
            parameterTolerances: r.parameterTolerances || {},
            distanceUnit: r.distanceUnit,
            weightUnit: r.weightUnit,
            isQuickTest: (typeof currentTest !== 'undefined' && currentTest === 'quick'),
            testStartTime: testRunStartTime ? new Date(testRunStartTime).toISOString() : undefined,
            testEndTime: new Date().toISOString(),
            durationSeconds: testRunStartTime ? Math.floor((Date.now() - testRunStartTime) / 1000) : undefined
        }).then(function (reportId) {
            if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
            if (reportId && typeof openReportPreview === 'function') {
                fetch('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
                openReportPreview(reportId);
                if (typeof currentTest !== 'undefined' && currentTest === 'quick' && typeof refreshQuickTestForm === 'function') refreshQuickTestForm();
            } else if (typeof goToPage === 'function') {
                goToPage('reports');
            }
        }).catch(function () {
            if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
            if (typeof goToPage === 'function') goToPage('reports');
        });
    } else {
        if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
        if (typeof goToPage === 'function') goToPage('reports');
    }
}

function toggleTestRunState() {
    const btnAction = document.getElementById('btn-test-start-abort');

    if (!btnAction) return;

    if (btnAction.dataset.state === 'start') {
        if (testRunManualWaitingForStart && testRunManualContinueResolve) {
            testRunManualContinueResolve();
            testRunManualContinueResolve = null;
            testRunManualWaitingForStart = false;
            btnAction.dataset.state = 'abort';
            btnAction.className = 'btn-ctrl danger header-btn';
            btnAction.innerHTML = '<div class="ctrl-icon">🛑</div><span>STOP</span>';
            return;
        }
        if (!lastTestRunRecipe) {
            alert('No recipe loaded. Please load or create a recipe first.');
            return;
        }
        // Switch to Running/Stop state
        btnAction.dataset.state = 'abort';
        btnAction.className = 'btn-ctrl danger header-btn';
        btnAction.innerHTML = '<div class="ctrl-icon">🛑</div><span>STOP</span>';

        testRunActive = true;
        lockNavigation();
        testRunPaused = false;
        testRunAborted = false;
        runHardnessTestLoop();
        console.log("Test Started");
    } else {
        // Abort requested - Show Custom UI Modal
        showAbortConfirmation(function () {
            testRunAborted = true;
            testRunActive = false;
            unlockNavigation();
            apiRequest('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
            // Save report when test is stopped and navigate to it
            if (lastTestRunRecipe && typeof saveReport === 'function') {
                var r = lastTestRunRecipe;
                var meas = lastTestRunMeasurements || { Thickness: [], Diameter: [], Width: [], Length: [], Hardness: [], Weight: [] };
                var stats = {};
                ['Thickness', 'Diameter', 'Width', 'Length', 'Hardness', 'Weight'].forEach(function (key) {
                    if (meas[key] && meas[key].length > 0) stats[key] = computeParamStatistics(meas[key]);
                });
                saveReport({
                    type: 'test',
                    name: (r.productName || 'Test') + ' - ' + (r.batchNumber || r.batch || 'N/A'),
                    productName: r.productName,
                    batchNumber: r.batchNumber || r.batch,
                    shape: r.shape,
                    parameters: r.parameters,
                    parameterSamples: r.parameterSamples || {},
                    unit: r.unit,
                    conversionFactor: r.conversionFactor,
                    sampleSize: r.sampleSize,
                    mode: r.mode || 'auto',
                    status: 'aborted',
                    measurements: meas,
                    statistics: stats,
                    parameterTolerances: r.parameterTolerances || {},
                    distanceUnit: r.distanceUnit,
                    weightUnit: r.weightUnit,
                    isQuickTest: (typeof currentTest !== 'undefined' && currentTest === 'quick'),
                    testStartTime: testRunStartTime ? new Date(testRunStartTime).toISOString() : undefined,
                    testEndTime: new Date().toISOString(),
                    durationSeconds: testRunStartTime ? Math.floor((Date.now() - testRunStartTime) / 1000) : undefined
                }).then(function (reportId) {
                    if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
                    if (reportId && typeof openReportPreview === 'function') {
                        fetch('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
                        openReportPreview(reportId);
                        if (typeof currentTest !== 'undefined' && currentTest === 'quick' && typeof refreshQuickTestForm === 'function') refreshQuickTestForm();
                    } else if (typeof goToPage === 'function') {
                        goToPage('reports');
                    }
                }).catch(function () {
                    if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
                    if (typeof goToPage === 'function') goToPage('reports');
                });
            } else {
                if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
                if (typeof goToPage === 'function') goToPage('reports');
            }
            // Reset to Start state
            btnAction.dataset.state = 'start';
            btnAction.className = 'btn-ctrl start header-btn';
            btnAction.innerHTML = '<div class="ctrl-icon">▶</div><span>START</span>';
            var sampleSize = lastTestRunRecipe ? (parseInt(lastTestRunRecipe.sampleSize) || 10) : 10;
            updateTestRunSampleProgress(0, sampleSize);
            console.log("Test Aborted");
        });
    }
}

// Helper for Abort Modal
function showAbortConfirmation(onConfirm) {
    const modal = document.getElementById('generic-modal-overlay');
    const titleEl = document.getElementById('generic-modal-title');
    const messageEl = document.getElementById('generic-modal-message');
    const iconContainer = document.querySelector('#generic-modal-overlay .modal-icon');
    const cancelBtn = document.querySelector('#generic-modal-overlay .btn-modal-cancel');
    const okBtn = document.querySelector('#generic-modal-overlay .btn-modal-ok');

    if (!modal) return;

    // Set Text
    if (titleEl) titleEl.textContent = 'Abort Test';
    if (messageEl) messageEl.textContent = 'Are you sure you want to stop the test?';

    // Set Icon to Alert (Red Triangle)
    if (iconContainer) {
        iconContainer.style.color = '#ef4444'; // Red color
        iconContainer.innerHTML = `
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                <line x1="12" y1="9" x2="12" y2="13"></line>
                <line x1="12" y1="17" x2="12.01" y2="17"></line>
            </svg>
        `;
    }

    // Configure Cancel Button
    if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
        cancelBtn.textContent = 'No';
        cancelBtn.onclick = closeGenericModal;
    }

    // Configure Confirm/Abort Button
    if (okBtn) {
        okBtn.textContent = 'Yes, Abort';
        okBtn.style.backgroundColor = '#ef4444'; // Red button
        okBtn.style.borderColor = '#ef4444';
        okBtn.onclick = function () {
            if (onConfirm) onConfirm();
            closeGenericModal();
        };
    }

    // Show Modal
    modal.style.display = 'flex';
}

function showAbortExitConfirmModal(plannedTarget) {
    var modal = document.getElementById('generic-modal-overlay');
    var titleEl = document.getElementById('generic-modal-title');
    var messageEl = document.getElementById('generic-modal-message');
    var iconContainer = document.querySelector('#generic-modal-overlay .modal-icon');
    var cancelBtn = document.querySelector('#generic-modal-overlay .btn-modal-cancel');
    var okBtn = document.querySelector('#generic-modal-overlay .btn-modal-ok');

    if (!modal) return;

    if (titleEl) titleEl.textContent = 'Operation in progress';
    if (messageEl) messageEl.textContent = 'Test/Validation/Calibration is running. Do you want to abort and exit?';

    if (iconContainer) {
        iconContainer.style.color = '#ef4444';
        iconContainer.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
    }

    if (cancelBtn) {
        cancelBtn.style.display = 'inline-block';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.onclick = closeGenericModal;
    }

    if (okBtn) {
        okBtn.textContent = 'Abort';
        okBtn.style.backgroundColor = '#ef4444';
        okBtn.style.borderColor = '#ef4444';
        okBtn.onclick = function () {
            closeGenericModal();
            doAbortAndNavigate(plannedTarget);
        };
    }

    modal.style.display = 'flex';
}

function closeGenericModal() {
    const modal = document.getElementById('generic-modal-overlay');
    if (modal) modal.style.display = 'none';
}

function showLoadingModal(message) {
    var modal = document.getElementById('loading-modal');
    var msgEl = document.getElementById('loading-modal-message');
    if (modal) {
        if (msgEl) msgEl.textContent = message || 'Loading...';
        modal.style.display = 'flex';
    }
}

function hideLoadingModal() {
    var modal = document.getElementById('loading-modal');
    if (modal) modal.style.display = 'none';
}

// Sample failure CONTINUE/END modal
var sampleFailureOnContinue = null;
var sampleFailureOnEnd = null;

function showSampleFailureModal(onContinue, onEnd) {
    sampleFailureOnContinue = onContinue;
    sampleFailureOnEnd = onEnd;
    var modal = document.getElementById('sample-failure-modal');
    if (modal) modal.style.display = 'flex';
}

function closeSampleFailureModal() {
    sampleFailureOnContinue = null;
    sampleFailureOnEnd = null;
    var modal = document.getElementById('sample-failure-modal');
    if (modal) modal.style.display = 'none';
}

function confirmSampleFailureContinue() {
    if (typeof sampleFailureOnContinue === 'function') sampleFailureOnContinue();
    closeSampleFailureModal();
}

function confirmSampleFailureEnd() {
    if (typeof sampleFailureOnEnd === 'function') sampleFailureOnEnd();
    closeSampleFailureModal();
}

function handleSampleFailureEndTest() {
    // Set abort flag to break out of test loop
    testRunAborted = true;
    if (lastTestRunRecipe && typeof saveReport === 'function') {
        var r = lastTestRunRecipe;
        saveReport({
            type: 'test',
            name: (r.productName || 'Test') + ' - ' + (r.batchNumber || r.batch || 'N/A'),
            productName: r.productName,
            batchNumber: r.batchNumber || r.batch,
            shape: r.shape,
            parameters: r.parameters,
            parameterSamples: r.parameterSamples || {},
            unit: r.unit,
            distanceUnit: r.distanceUnit,
            weightUnit: r.weightUnit,
            sampleSize: r.sampleSize,
            status: 'aborted',
            measurements: lastTestRunMeasurements || {},
            testStartTime: testRunStartTime ? new Date(testRunStartTime).toISOString() : undefined,
            testEndTime: new Date().toISOString(),
            durationSeconds: testRunStartTime ? Math.floor((Date.now() - testRunStartTime) / 1000) : undefined
        }).then(function (reportId) {
            if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
            if (reportId && typeof openReportPreview === 'function') {
                fetch('/api/hardware/test/home', { method: 'POST' }).catch(function () {});
                openReportPreview(reportId);
                if (typeof currentTest !== 'undefined' && currentTest === 'quick' && typeof refreshQuickTestForm === 'function') refreshQuickTestForm();
            } else if (typeof goToPage === 'function') {
                goToPage('reports');
            }
        }).catch(function () {
            if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
            if (typeof goToPage === 'function') goToPage('reports');
        });
    } else {
        // If no recipe, still navigate to reports
        if (typeof clearTestRunDisplay === 'function') clearTestRunDisplay();
        if (typeof goToPage === 'function') goToPage('reports');
    }
    var btnAction = document.getElementById('btn-test-start-abort');
    if (btnAction) {
        btnAction.dataset.state = 'start';
        btnAction.className = 'btn-ctrl start header-btn';
        btnAction.innerHTML = '<div class="ctrl-icon">▶</div><span>START</span>';
    }
}

/**
 * Resolve T1/T2 config to absolute band edges on the measurement axis.
 * Auto-detect: if upperT1 or upperT2 > nominal, treat stored values as absolute limits (T2-, T1-, T1+, T2+).
 * Otherwise legacy: values are deviations from nominal (optional percentage plausibility).
 * @returns {{lowerT1Limit:number, upperT1Limit:number, lowerOuter:number, upperOuter:number, hasT2:boolean}|null}
 */
function resolveT1T2Bands(tol, nom) {
    if (!tol || typeof tol !== 'object' || isNaN(nom)) return null;
    var parseT = function (x) {
        var n = parseFloat(x);
        return isNaN(n) ? 0 : n;
    };
    var upperT1 = parseT(tol.upperT1);
    var upperT2 = parseT(tol.upperT2);
    var lowerT1 = parseT(tol.lowerT1);
    var lowerT2 = parseT(tol.lowerT2);
    var plausibility = (tol.plausibility || 'absolute').toLowerCase();
    var rawL2 = lowerT2;
    var rawU2 = upperT2;
    var u1 = upperT1;
    var u2 = upperT2;
    var l1 = lowerT1;
    var l2 = lowerT2;

    var absoluteSpec = (u1 > nom) || (u2 > nom);

    if (!absoluteSpec && plausibility === 'percentage' && nom !== 0) {
        var factor = Math.abs(nom) / 100;
        u1 *= factor;
        u2 *= factor;
        l1 *= factor;
        l2 *= factor;
    }
    if (!absoluteSpec) {
        u1 = Math.abs(u1);
        u2 = Math.abs(u2);
        l1 = Math.abs(l1);
        l2 = Math.abs(l2);
    }

    var lowerT1Limit;
    var upperT1Limit;
    var lowerOuter;
    var upperOuter;
    var hasT2 = (rawU2 !== 0) || (rawL2 !== 0);

    if (absoluteSpec) {
        lowerT1Limit = l1;
        upperT1Limit = u1;
        lowerOuter = (rawL2 !== 0) ? l2 : lowerT1Limit;
        upperOuter = (rawU2 !== 0) ? u2 : upperT1Limit;
    } else {
        lowerT1Limit = nom - l1;
        upperT1Limit = nom + u1;
        lowerOuter = nom - (rawL2 !== 0 ? l2 : l1);
        upperOuter = nom + (rawU2 !== 0 ? u2 : u1);
    }

    return {
        lowerT1Limit: lowerT1Limit,
        upperT1Limit: upperT1Limit,
        lowerOuter: lowerOuter,
        upperOuter: upperOuter,
        hasT2: hasT2
    };
}

/**
 * Returns display status for a single value against nominal and T1/T2 tolerance config.
 * @returns {'Pass'|'T1-T2'|'Fail'}
 */
function getT1T2DisplayStatus(value, nominal, toleranceConfig) {
    if (value == null || (typeof value !== 'number' && isNaN(parseFloat(value)))) return 'Fail';
    var v = typeof value === 'number' ? value : parseFloat(value);
    var nom = typeof nominal === 'number' ? nominal : parseFloat(nominal);
    if (isNaN(v) || isNaN(nom)) return 'Fail';
    if (!toleranceConfig || typeof toleranceConfig !== 'object') return 'Fail';
    var tol = toleranceConfig;
    var upperT1 = parseFloat(tol.upperT1) || 0;
    var upperT2 = parseFloat(tol.upperT2) || 0;
    var lowerT1 = parseFloat(tol.lowerT1) || 0;
    var lowerT2 = parseFloat(tol.lowerT2) || 0;
    if (upperT1 === 0 && upperT2 === 0 && lowerT1 === 0 && lowerT2 === 0) {
        var tolVal = parseFloat(tol.value) || 0;
        var tolType = (tol.type || 'absolute').toLowerCase();
        if (tolType === 'percentage' && nom !== 0) {
            var devPct = Math.abs(v - nom) / Math.abs(nom) * 100;
            return devPct <= (tolVal || 10) ? 'Pass' : 'Fail';
        }
        return Math.abs(v - nom) <= (tolVal || 0) ? 'Pass' : 'Fail';
    }

    var bands = resolveT1T2Bands(tol, nom);
    if (!bands) return 'Fail';

    if (!bands.hasT2) {
        return (bands.lowerT1Limit <= v && v <= bands.upperT1Limit) ? 'Pass' : 'Fail';
    }

    if (bands.lowerT1Limit <= v && v <= bands.upperT1Limit) return 'Pass';
    if ((bands.lowerOuter <= v && v < bands.lowerT1Limit) || (bands.upperT1Limit < v && v <= bands.upperOuter)) return 'T1-T2';
    return 'Fail';
}

function checkMeasurementAndShowFailureModalIfNeeded(value, nominal, toleranceConfig, onContinue, onEnd) {
    if (!toleranceConfig || (value == null && value !== 0)) {
        console.log('[DEBUG] Tolerance check skipped - config:', toleranceConfig, 'value:', value);
        if (typeof onContinue === 'function') onContinue();
        return;
    }
    // Use client-side check for immediate feedback (no API delay)
    var clientResult = typeof getT1T2DisplayStatus === 'function' ? getT1T2DisplayStatus(value, nominal, toleranceConfig) : 'Pass';
    console.log('[DEBUG] Tolerance check result:', clientResult, 'for value:', value, 'nominal:', nominal, 'config:', toleranceConfig);
    if (clientResult === 'Fail') {
        if (testRunAborted) {
            if (typeof onContinue === 'function') onContinue();
            return;
        }
        // Ensure modal element exists before showing
        var modal = document.getElementById('sample-failure-modal');
        console.log('[DEBUG] Failure modal element:', modal);
        if (!modal) {
            console.error('[DEBUG] Sample failure modal not found');
            // Fallback: show alert and wait for confirmation
            if (confirm('Sample failed tolerance. Do you want to continue?')) {
                if (typeof onContinue === 'function') onContinue();
            } else {
                if (typeof onEnd === 'function') onEnd();
            }
            return;
        }
        console.log('[DEBUG] Showing sample failure modal');
        showSampleFailureModal(
            typeof onContinue === 'function' ? onContinue : function () {},
            typeof onEnd === 'function' ? onEnd : handleSampleFailureEndTest
        );
        return;
    }
    if (typeof onContinue === 'function') onContinue();
}

async function nextFormStep() {
    if (currentTest === 'quick' || currentTest === 'create-recipe') {
        const productName = document.getElementById('recipe-product-name')?.value || '';
        if (!productName.trim()) {
            alert('Please enter a Product Name.');
            return;
        }
        const parameters = {};
        document.querySelectorAll('.parameter-item').forEach((item) => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            const label = item.querySelector('.checkbox-label span')?.textContent || '';
            if (checkbox?.checked && label) parameters[label] = true;
        });
        if (Object.keys(parameters).length === 0) {
            alert('Please select at least one parameter to measure.');
            return;
        }
        const sampleSizeVal = document.getElementById('sample-size')?.value?.trim();
        const sampleNum = parseInt(sampleSizeVal, 10);
        if (!sampleSizeVal || isNaN(sampleNum) || sampleNum < 1 || sampleNum > 100) {
            alert('Please enter Sample Size (1-100).');
            return;
        }
        const labelToSamplesIdStep = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };
        let paramSampleExceedsTotal = false;
        document.querySelectorAll('.parameter-item').forEach((item) => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            const label = item.querySelector('.checkbox-label span')?.textContent || '';
            if (checkbox?.checked && label && labelToSamplesIdStep[label]) {
                const samplesEl = document.getElementById(labelToSamplesIdStep[label]);
                const paramSamples = samplesEl ? parseInt(samplesEl.value, 10) : 0;
                if (!isNaN(paramSamples) && paramSamples > sampleNum) {
                    paramSampleExceedsTotal = true;
                }
            }
        });
        if (paramSampleExceedsTotal) {
            alert('The parameter sample cannot be more than the total sample size (' + sampleNum + '). Please adjust the samples per parameter.');
            return;
        }
        let atLeastOneEqualsTotal = false;
        document.querySelectorAll('.parameter-item').forEach((item) => {
            const checkbox = item.querySelector('input[type="checkbox"]');
            const label = item.querySelector('.checkbox-label span')?.textContent || '';
            if (checkbox?.checked && label && labelToSamplesIdStep[label]) {
                const samplesEl = document.getElementById(labelToSamplesIdStep[label]);
                const paramSamples = samplesEl ? parseInt(samplesEl.value, 10) : 0;
                if (!isNaN(paramSamples) && paramSamples === sampleNum) atLeastOneEqualsTotal = true;
            }
        });
        if (!atLeastOneEqualsTotal) {
            alert('At least one parameter sample should be equal to the total number of samples.');
            return;
        }
        // Create-recipe: Save directly from step 1 and go to manage-recipes (no step 2 page)
        if (currentTest === 'create-recipe') {
            await handleSaveRecipeFromStep2();
            return;
        }
        // Quick test: skip step 2 page; go straight to backoff modal then test
        if (currentTest === 'quick') {
            const recipe = getRecipeFromForm();
            lastTestRunRecipe = recipe;
            showBackoffModal();
            return;
        }
        document.getElementById('form-step-1').style.display = 'none';
        document.getElementById('form-step-2').style.display = 'grid';
        const saveBtn = document.getElementById('form-step-2-save-btn');
        const startBtn = document.getElementById('form-step-2-start-btn');
        if (saveBtn && startBtn) {
            saveBtn.style.display = 'none';
            startBtn.style.display = '';
        }
    }
}

function prevFormStep() {
    document.getElementById('form-step-2').style.display = 'none';
    document.getElementById('form-step-1').style.display = 'grid';
}



// ===== USER MANAGEMENT =====
async function getMembers() {
    try {
        const result = await apiRequest('/api/data/members');
        return result.members || [];
    } catch (e) {
        console.error('Failed to fetch members:', e);
        return [];
    }
}

function saveMembersList(members) {
    // This function is kept for compatibility but should use API
    console.warn('saveMembersList called - use saveNewMember API instead');
}

async function displayMembersList() {
    const members = await getMembers();
    const tableBody = document.getElementById('members-list-body'); // Updated ID

    if (!tableBody) return;

    tableBody.innerHTML = '';

    if (members.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" style="text-align:center; padding: 20px;">No members found.</td></tr>';
        return;
    }

    // Sort by name
    members.sort((a, b) => a.name.localeCompare(b.name));

    members.forEach(member => {
        const row = document.createElement('tr');
        // Use specific class for role color
        const roleClass = `badge-role-${member.role}`;

        row.innerHTML = `
            <td style="color: var(--text-primary); font-weight: 600;">${member.name}</td>
            <td>${member.username || '-'}</td>
            <td><span class="badge ${roleClass}">${member.role}</span></td>
            <td class="actions-cell">
                <button class="btn-yellow" onclick="openRoleModal(${member.id})">Change Role</button>
                <button class="btn-red" onclick="deleteMember(${member.id})">Delete</button>
            </td>
        `;
        tableBody.appendChild(row);
    });
}

// Global variable to track which user is being edited
let currentMemberIdForRoleEdit = null;

async function openRoleModal(id) {
    const members = await getMembers();
    const member = members.find(m => m.id === id);
    if (!member) return;

    currentMemberIdForRoleEdit = id;

    // Update Modal Content
    document.getElementById('role-modal-title').textContent = `Change Role for ${member.name}`;
    document.getElementById('role-modal-current').textContent = `Current Role: ${member.role}`;

    // Show Modal
    document.getElementById('role-modal-overlay').style.display = 'flex';
}

function closeRoleModal() {
    document.getElementById('role-modal-overlay').style.display = 'none';
    currentMemberIdForRoleEdit = null;
}

async function confirmRoleChange(newRole) {
    if (!currentMemberIdForRoleEdit) return;

    // Check RBAC permission
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        const role = getCurrentRole();
        if (!canPerformAction(role, 'user-change-role', 'change')) {
            alert('You do not have permission to change user roles.');
            closeRoleModal();
            return;
        }
    }
    
    // Check if protected factory user
    const members = await getMembers();
    const member = members.find(m => m.id === currentMemberIdForRoleEdit);
    if (member && typeof isProtectedFactoryUser === 'function' && isProtectedFactoryUser(member)) {
        alert('This factory user cannot be modified.');
        closeRoleModal();
        return;
    }

    try {
        // Update member role via API
        const updatedMember = { ...member, role: newRole };
        await apiRequest(`/api/data/members/${currentMemberIdForRoleEdit}`, {
            method: 'PUT',
            body: JSON.stringify(updatedMember)
        });
        displayMembersList();
        closeRoleModal();
    } catch (e) {
        console.error('Failed to update member role:', e);
        alert('Failed to update role: ' + e.message);
    }
}

// Role Selection in Add Member Form
function selectRole(role) {
    document.querySelectorAll('.role-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.textContent === role) btn.classList.add('active');
    });
    document.getElementById('selected-role').value = role;
}

async function saveNewMember() {
    // Get values
    const fullName = document.getElementById('add-fullname').value.trim();
    const userId = document.getElementById('add-userid').value.trim();
    const password = document.getElementById('add-password').value;
    const confirmPassword = document.getElementById('add-confirm-password').value;
    const role = document.getElementById('selected-role').value;

    // Validation
    if (!fullName || !userId || !password) {
        alert('Please fill in all required fields.');
        return;
    }

    if (userId.toUpperCase() === FACTORY_USERNAME) {
        alert('This User ID is reserved and cannot be used.');
        return;
    }

    if (password !== confirmPassword) {
        alert('Passwords do not match.');
        return;
    }

    const members = await getMembers();

    // Check for duplicate User ID
    if (members.some(m => m.username && m.username.toLowerCase() === userId.toLowerCase())) {
        alert('User ID already exists. Please choose a different one.');
        return;
    }

    const newMember = {
        name: fullName,
        username: userId,
        role: role,
        password: password, // In a real app, hash this!
        date: new Date().toISOString()
    };

    try {
        await apiRequest('/api/data/members', {
            method: 'POST',
            body: JSON.stringify(newMember)
        });

        // Reset Form
        document.getElementById('add-fullname').value = '';
        document.getElementById('add-userid').value = '';
        document.getElementById('add-password').value = '';
        document.getElementById('add-confirm-password').value = '';
        selectRole('User'); // Reset role to default

        alert('Member added successfully!');
        _navigatingAfterSave = true;
        goToPage('manage-members');

        // Auto-update list
        setTimeout(displayMembersList, 100);
    } catch (e) {
        console.error('Failed to save member:', e);
        alert('Failed to add member: ' + e.message);
    }
}

async function saveUserProfile() {
    var newNameEl = document.getElementById('profile-fullname');
    var newPassEl = document.getElementById('profile-password');
    var newName = newNameEl ? newNameEl.value.trim() : '';
    var newPass = newPassEl ? newPassEl.value : '';
    if (!newName) {
        alert('Please enter a name.');
        return;
    }
    var user = (typeof window.currentUser !== 'undefined' && window.currentUser) ? window.currentUser : (typeof currentUser !== 'undefined' && currentUser) ? currentUser : null;
    if (!user || user.id == null) {
        try {
            var res = await apiRequest('/api/data/auth/current-user');
            user = res && res.user ? res.user : null;
        } catch (e) {
            console.error('Failed to get current user:', e);
        }
    }
    if (!user || user.id == null) {
        alert('Cannot save profile: no user logged in.');
        return;
    }
    try {
        var existing = await apiRequest('/api/data/members/' + user.id);
        var member = existing && existing.member ? existing.member : {};
        var payload = { id: user.id, name: newName, username: member.username || user.username || '', role: member.role || user.role || '' };
        payload.password = (newPass && newPass.length > 0) ? newPass : (member.password || '');
        await apiRequest('/api/data/members/' + user.id, {
            method: 'PUT',
            body: JSON.stringify(payload)
        });
        if (typeof window.currentUser !== 'undefined') window.currentUser.name = newName;
        if (typeof currentUser !== 'undefined') { currentUser = currentUser || {}; currentUser.name = newName; }
        var displayEl = document.getElementById('profile-name-display');
        if (displayEl) displayEl.textContent = newName;
        if (newPassEl) newPassEl.value = '';
        showModal('Success', 'Profile saved successfully.');
    } catch (e) {
        console.error('Failed to save profile:', e);
        alert('Failed to save profile: ' + (e.message || 'Unknown error'));
    }
}



async function deleteMember(id) {
    // Check RBAC permission
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        const role = getCurrentRole();
        if (!canPerformAction(role, 'user-delete', 'delete')) {
            alert('You do not have permission to delete members.');
            return;
        }
    }
    
    // Check if protected factory user
    const members = await getMembers();
    const member = members.find(m => m.id === id);
    if (member && typeof isProtectedFactoryUser === 'function' && isProtectedFactoryUser(member)) {
        alert('This factory user cannot be deleted.');
        return;
    }

    showModal(
        'Delete Member',
        'Are you sure you want to delete this member? This action cannot be undone.',
        async function (confirmed) {
            if (!confirmed) return;
            try {
                await apiRequest(`/api/data/members/${id}`, { method: 'DELETE' });
                if (typeof displayMembersList === 'function') displayMembersList();
            } catch (e) {
                console.error('Failed to delete member:', e);
                alert('Failed to delete member: ' + e.message);
            }
        },
        true
    );
}

// ===== NUMERIC INPUT VALIDATION =====
function validateNumericInput(input) {
    const value = input.value;

    // Allow only numbers and decimal point
    const isValid = /^[0-9]*\.?[0-9]*$/.test(value);

    if (!isValid && value !== '') {
        // Remove invalid characters
        input.value = value.replace(/[^0-9.]/g, '');

        // Show warning styling
        input.style.borderColor = '#ef4444';
        input.style.boxShadow = '0 0 0 3px rgba(239, 68, 68, 0.1)';

        // Show error message briefly
        const errorId = input.id.replace('-value', '-error');
        const errorSpan = document.getElementById(errorId);
        if (errorSpan) {
            errorSpan.textContent = '⚠ Only numbers allowed';
            errorSpan.style.display = 'block';

            // Hide error after 2 seconds
            setTimeout(() => {
                errorSpan.style.display = 'none';
            }, 2000);
        }

        // Show alert for first time
        if (!input._warningShown) {
            alert('⚠ Warning: Only numbers are allowed in parameter fields!');
            input._warningShown = true;

            // Reset warning flag after 5 seconds
            setTimeout(() => {
                input._warningShown = false;
            }, 5000);
        }
    } else {
        // Reset styling when valid
        input.style.borderColor = '';
        input.style.boxShadow = '';
    }
}

// ===== DATETIME SETUP =====
let currentTimeFormat = '24'; // '12' or '24'
let currentAmPm = 'PM';

function initializeDatetime() {
    const dateInput = document.getElementById('edit-date');
    const timeInput = document.getElementById('edit-time');

    if (!dateInput || !timeInput) return;

    function applyDatetimeToInputs(now) {
        if (!dateInput.value) {
            const day = String(now.getDate()).padStart(2, '0');
            const month = String(now.getMonth() + 1).padStart(2, '0');
            const year = now.getFullYear();
            dateInput.value = `${day}-${month}-${year}`;
        }
        if (!timeInput.value) {
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            timeInput.value = `${hours}:${minutes}`;
        }
    }

    fetchDateTimeFromBackend().then(function (data) {
        let now;
        if (data && data.datetime) {
            now = new Date(data.datetime.replace('Z', ''));
        }
        if (!now || isNaN(now.getTime())) {
            if (data && data.date && (data.time || data.time_12h)) {
                const parts = (data.date || '').split('-');
                const tparts = (data.time || data.time_12h || '').split(':');
                if (parts.length >= 3 && tparts.length >= 2) {
                    const d = parseInt(parts[0], 10);
                    const m = parseInt(parts[1], 10) - 1;
                    const y = parseInt(parts[2], 10);
                    let h = parseInt(tparts[0], 10);
                    const min = parseInt(tparts[1], 10) || 0;
                    if (data.time_12h && (data.time_12h.indexOf('PM') >= 0) && h < 12) h += 12;
                    if (data.time_12h && (data.time_12h.indexOf('AM') >= 0) && h === 12) h = 0;
                    now = new Date(y, m, d, h, min, 0);
                }
            }
        }
        if (!now || isNaN(now.getTime())) now = new Date();
        applyDatetimeToInputs(now);
    }).catch(function () {
        applyDatetimeToInputs(new Date());
    });
}

function toggleAmPm(ampm) {
    currentAmPm = ampm;
    // Update UI: Target the first toggle group (AM/PM) specifically within the datetime page
    const toggles = document.querySelectorAll('#page-datetime .time-format-toggle');
    if (toggles.length > 0) {
        const buttons = toggles[0].querySelectorAll('.format-btn');
        buttons.forEach(btn => {
            if (btn.textContent.trim() === ampm) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    }
}

function toggleTimeFormat(format) {
    currentTimeFormat = format;
    // Update UI: Target the second toggle group (12/24H)
    const toggles = document.querySelectorAll('#page-datetime .time-format-toggle');
    if (toggles.length > 1) {
        const buttons = toggles[1].querySelectorAll('.format-btn');
        buttons.forEach(btn => {
            if (btn.textContent.includes(format)) btn.classList.add('active');
            else btn.classList.remove('active');
        });
    }

    // Show/hide AM/PM toggle based on format
    const ampmContainer = document.getElementById('ampm-toggle-container');
    if (ampmContainer) {
        if (format === '12') {
            ampmContainer.style.display = 'flex';
        } else {
            ampmContainer.style.display = 'none';
        }
    }

    // Logic to update the time input value if present
    const timeInput = document.getElementById('edit-time');
    if (timeInput && timeInput.value) {
        let parts = timeInput.value.split(':');
        if (parts.length === 2) {
            let h = parseInt(parts[0]);
            let m = parts[1];

            if (format === '12') {
                if (h > 12) { h -= 12; toggleAmPm('PM'); }
                else if (h === 0) { h = 12; toggleAmPm('AM'); }
                else if (h === 12) { toggleAmPm('PM'); }
                else { toggleAmPm('AM'); }
            } else {
                if (currentAmPm === 'PM' && h < 12) h += 12;
                if (currentAmPm === 'AM' && h === 12) h = 0;
            }
            timeInput.value = `${String(h).padStart(2, '0')}:${m}`;
        }
    }
}

// ===== MODAL UTILITIES =====
function showModal(title, message, callback, isConfirm = false, showCancelButton = true, okLabel, cancelLabel) {
    const overlay = document.getElementById('generic-modal-overlay');
    const titleEl = document.getElementById('generic-modal-title');
    const msgEl = document.getElementById('generic-modal-message');

    if (overlay && titleEl && msgEl) {
        titleEl.textContent = title;
        // Handle newlines
        msgEl.innerHTML = message ? message.replace(/\n/g, '<br>') : '';
        overlay.style.display = 'flex';

        // Update icon: red (no tick) for error/alert; orange for confirm; neutral for Message; green tick only for success
        const iconDiv = overlay.querySelector('.modal-icon');
        if (iconDiv) {
            var titleLower = title.toLowerCase();
            var msgLower = (message && typeof message === 'string') ? message.toLowerCase() : '';
            var isErrorOrAlert = titleLower.includes('error') || titleLower.includes('warning') || titleLower.includes('alert') ||
                msgLower.includes('error') || msgLower.includes('failed') || msgLower.includes('invalid') || msgLower.includes('permission') || msgLower.includes('denied') || msgLower.includes('wrong') || msgLower.includes('incorrect');
            if (isErrorOrAlert) {
                iconDiv.style.color = '#F56565'; // Red, no tick
                iconDiv.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>';
            } else if (isConfirm) {
                iconDiv.style.color = '#ED8936'; // Orange
                iconDiv.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>';
            } else if (titleLower.includes('message')) {
                iconDiv.style.color = '#718096'; // Neutral grey, no tick (info circle)
                iconDiv.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
            } else {
                iconDiv.style.color = '#718096'; // Neutral grey, no tick (success - no green tick)
                iconDiv.innerHTML = '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>';
            }
        }

        const okBtn = overlay.querySelector('.btn-modal-ok');
        const cancelBtn = overlay.querySelector('.btn-modal-cancel');

        if (cancelBtn) {
            const showCancel = isConfirm && showCancelButton;
            cancelBtn.style.display = showCancel ? 'block' : 'none';
            // Clone to remove old listeners
            const newCancel = cancelBtn.cloneNode(true);
            cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);

            newCancel.onclick = function () {
                closeGenericModal();
                if (typeof callback === 'function') callback(false);
            };
            if (cancelLabel != null && cancelLabel !== '') newCancel.textContent = cancelLabel;
        }

        if (okBtn) {
            const newOk = okBtn.cloneNode(true);
            okBtn.parentNode.replaceChild(newOk, okBtn);

            newOk.onclick = function () {
                closeGenericModal();
                if (typeof callback === 'function') callback(true);
            };

            newOk.textContent = (okLabel != null && okLabel !== '') ? okLabel : 'OK';
            newOk.focus();
        }
    }
}

function closeGenericModal() {
    const overlay = document.getElementById('generic-modal-overlay');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

function initFactorySupportPage() {
    const loadingEl = document.getElementById('factory-support-loading-msg');
    const userEl = document.getElementById('factory-support-user');
    const passEl = document.getElementById('factory-support-password');
    const btnBack = document.getElementById('factory-support-btn-back');
    const btnSubmit = document.getElementById('factory-support-btn-submit');
    if (loadingEl) loadingEl.style.display = 'none';
    if (userEl) {
        userEl.value = '';
        userEl.disabled = false;
    }
    if (passEl) {
        passEl.value = '';
        passEl.disabled = false;
    }
    if (btnBack) btnBack.disabled = false;
    if (btnSubmit) btnSubmit.disabled = false;
}

function initFactorySupportResultPage() {
    const el = document.getElementById('factory-support-result-ip');
    if (!el) return;
    let raw = '';
    try {
        raw = sessionStorage.getItem('factorySupportResultIp') || '';
    } catch (e) {
        raw = '';
    }
    el.textContent = raw.trim()
        ? raw.trim()
        : 'No address is available. Go back, check the LAN connection, and sign in again.';
}

function factorySupportVerifyFetch(username, password) {
    return fetch('/api/support/factory/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
    }).then(function (response) {
        return response.text().then(function (text) {
            let data = null;
            const t = (text || '').trim();
            if (t.startsWith('{') || t.startsWith('[')) {
                try {
                    data = JSON.parse(t);
                } catch (e) {
                    data = null;
                }
            }
            if (!response.ok) {
                const msg =
                    data && data.error ? data.error : t || 'HTTP ' + response.status;
                throw new Error(msg);
            }
            if (!data || typeof data !== 'object') {
                throw new Error('Invalid response from server');
            }
            return data;
        });
    });
}

function submitFactorySupportLogin() {
    const userEl = document.getElementById('factory-support-user');
    const passEl = document.getElementById('factory-support-password');
    const loadingEl = document.getElementById('factory-support-loading-msg');
    const btnBack = document.getElementById('factory-support-btn-back');
    const btnSubmit = document.getElementById('factory-support-btn-submit');
    const username = userEl ? userEl.value.trim() : '';
    const password = passEl ? passEl.value : '';
    if (!username || !password) {
        alert('Please enter factory support ID and password.');
        return;
    }
    const start = Date.now();
    if (loadingEl) loadingEl.style.display = 'block';
    if (btnBack) btnBack.disabled = true;
    if (btnSubmit) btnSubmit.disabled = true;
    if (userEl) userEl.disabled = true;
    if (passEl) passEl.disabled = true;

    const restoreForm = function () {
        if (loadingEl) loadingEl.style.display = 'none';
        if (btnBack) btnBack.disabled = false;
        if (btnSubmit) btnSubmit.disabled = false;
        if (userEl) userEl.disabled = false;
        if (passEl) passEl.disabled = false;
    };

    factorySupportVerifyFetch(username, password)
        .then(function (res) {
            const minMs = 1200;
            const elapsed = Date.now() - start;
            const wait = Math.max(0, minMs - elapsed);
            return new Promise(function (resolve) {
                setTimeout(function () {
                    resolve(res);
                }, wait);
            });
        })
        .then(function (res) {
            if (res && res.ok) {
                const text =
                    res.addresses && String(res.addresses).trim()
                        ? String(res.addresses).trim()
                        : 'No IP address found. Check that this device is connected to the LAN.';
                try {
                    sessionStorage.setItem('factorySupportResultIp', text);
                } catch (e) {}
                goToPage('factory-support-result');
            } else {
                throw new Error('Sign-in was not successful.');
            }
        })
        .catch(function (e) {
            restoreForm();
            alert(e.message || 'Sign-in failed');
        });
}

function showFactoryResetConfirm() {
    showModal(
        'Factory Reset',
        'Are you sure you want to factory reset? This will permanently delete all reports, recipes, and users. This action cannot be undone.',
        function (confirmed) {
            if (!confirmed) return;
            apiRequest('/api/data/factory-reset', { method: 'POST', body: '{}' })
                .then(function (result) {
                    showModal('Factory Reset', 'Factory reset completed. All reports, recipes, and users have been deleted.');
                    if (typeof displayRecipeList === 'function') displayRecipeList();
                    if (typeof loadReports === 'function') loadReports();
                    if (typeof displayMembersList === 'function') displayMembersList();
                })
                .catch(function (e) {
                    showModal('Error', 'Factory reset failed: ' + (e.message || 'Unknown error'));
                });
        },
        true
    );
}

// Override native alert to use custom modal
window.alert = function (message) {
    // Determine title based on message content
    let title = 'Message';
    if (message && (message.toLowerCase().includes('error') || message.toLowerCase().includes('warning') || message.toLowerCase().includes('failed'))) {
        title = 'Alert';
    }
    showModal(title, message);
};
// Note: We cannot easily override window.confirm because it is synchronous/blocking.
// Logout logic updated manually.

// Open native date picker for type="date" inputs (e.g. factory-installation-date)
function openDatePicker(inputId) {
    const el = document.getElementById(inputId);
    if (!el) return;
    el.focus();
    if (typeof el.showPicker === 'function') {
        try { el.showPicker(); } catch (e) { el.click(); }
    } else {
        el.click();
    }
}

// Open date picker for edit-date text field (Date & Time page); uses hidden type="date"
function openDatePickerForEditDate() {
    const textInput = document.getElementById('edit-date');
    const hiddenInput = document.getElementById('edit-date-picker-hidden');
    if (!textInput || !hiddenInput) return;
    // Parse DD-MM-YYYY to YYYY-MM-DD
    const val = (textInput.value || '').trim();
    if (val) {
        const parts = val.split('-');
        if (parts.length === 3) {
            const d = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            const y = parseInt(parts[2], 10);
            if (!isNaN(d) && !isNaN(m) && !isNaN(y) && d >= 1 && d <= 31 && m >= 1 && m <= 12 && y >= 2000 && y <= 2100) {
                hiddenInput.value = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            }
        }
    }
    if (!hiddenInput.value) {
        const now = new Date();
        hiddenInput.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    }
    function onDateChange() {
        const v = hiddenInput.value;
        if (!v) return;
        const [y, m, d] = v.split('-');
        if (y && m && d) {
            textInput.value = String(parseInt(d, 10)).padStart(2, '0') + '-' + String(parseInt(m, 10)).padStart(2, '0') + '-' + y;
        }
        hiddenInput.removeEventListener('change', onDateChange);
    }
    hiddenInput.addEventListener('change', onDateChange);
    hiddenInput.focus();
    if (typeof hiddenInput.showPicker === 'function') {
        try { hiddenInput.showPicker(); } catch (e) { hiddenInput.click(); }
    } else {
        hiddenInput.click();
    }
}

async function applyDateTime() {
    const dateVal = (document.getElementById('edit-date').value || '').trim();
    const timeVal = (document.getElementById('edit-time').value || '').trim();

    if (!dateVal || !timeVal) {
        showModal('Error', 'Please enter both date and time.');
        return;
    }

    const [day, month, year] = dateVal.split('-').map(Number);
    const timeParts = timeVal.split(':');
    let hours = parseInt(timeParts[0], 10);
    let minutes = timeParts.length >= 2 ? parseInt(timeParts[1], 10) : 0;
    if (isNaN(hours)) hours = 0;
    if (isNaN(minutes)) minutes = 0;
    hours = Math.max(0, Math.min(23, hours));
    minutes = Math.max(0, Math.min(59, minutes));

    // Send literal date and time as entered (no UTC offset); system time uses this directly
    const pad = function (n) { return String(n).padStart(2, '0'); };
    const dtStr = year + '-' + pad(month) + '-' + pad(day) + 'T' + pad(hours) + ':' + pad(minutes) + ':00';

    // Create adjusted datetime for RTC (+6 hours to compensate for CST timezone offset after restart)
    // This ensures that after restart, when Pi reads RTC and displays in CST, it shows the correct time
    const userDate = new Date(dtStr);
    userDate.setHours(userDate.getHours() + 6);
    const rtcDtStr = userDate.getFullYear() + '-' + 
                     pad(userDate.getMonth() + 1) + '-' + 
                     pad(userDate.getDate()) + 'T' + 
                     pad(userDate.getHours()) + ':' + 
                     pad(userDate.getMinutes()) + ':00';

    const roleHeader = (typeof window.currentUser !== 'undefined' && window.currentUser && window.currentUser.role)
        ? window.currentUser.role : ((typeof currentUser !== 'undefined' && currentUser && currentUser.role) ? currentUser.role : '');
    const headers = roleHeader ? { 'X-User-Role': roleHeader } : {};

    try {
        let success = false;
        let setDatetimeOk = false;
        try {
            const r = await fetch('/api/set_datetime', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body: JSON.stringify({ datetime: dtStr })
            });
            if (r.ok) {
                setDatetimeOk = true;
                success = true;
            } else {
                const err = await r.json().catch(() => ({}));
                throw new Error(err.error || 'Failed to set datetime');
            }
        } catch (e1) {
            setDatetimeOk = false;
        }
        // Always sync to hardware RTC (DS1307 on SDA/SCL) so it updates on the Pi
        // Use adjusted datetime (+6 hours) for RTC to compensate for CST timezone offset
        let rtcOk = false;
        if (setDatetimeOk || !success) {
            try {
                const r2 = await fetch('/api/rtc/date', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...headers },
                    body: JSON.stringify({ datetime: rtcDtStr })
                });
                const data = await r2.json().catch(() => ({}));
                if (r2.ok && data.success) {
                    success = true;
                    rtcOk = true;
                } else if (!setDatetimeOk) throw new Error(data.error || 'Failed to set RTC');
            } catch (e2) {
                if (!success) throw new Error(e2.message || 'Failed to update date and time');
            }
        }
        updateDateTime();
        showModal('Success', 'Applied successfully.', function () {
            goBack();
        });
    } catch (e) {
        showModal('Error', 'Failed to update date and time: ' + (e.message || 'Unknown error'));
    }
}

// ===== ON-SCREEN KEYBOARD INTEGRATION =====
// Add click event listeners to all input fields to open keyboard
document.addEventListener('DOMContentLoaded', function () {
    // Function to attach keyboard to all text inputs
    function attachKeyboardToInputs() {
        // Updated selector to exclude select elements
        const inputs = document.querySelectorAll('input[type="text"], input[type="number"], .input-field:not(select), .param-value:not(select)');
        inputs.forEach(input => {
            // Remove existing listeners to avoid duplicates
            input.removeEventListener('focus', input._keyboardFocusHandler);

            // Add focus handler
            input._keyboardFocusHandler = function () {
                if (typeof window.openOSKForInput === 'function') {
                    window.openOSKForInput(input);
                }
            };

            input.addEventListener('focus', input._keyboardFocusHandler);
        });
    }

    // Make it global so we can call it if needed
    window.attachKeyboardToInputs = attachKeyboardToInputs;

    // Enforce 2 decimal places on blur for numeric inputs
    window.attachTwoDecimalEnforcement = function () {
        var selectors = '.param-value, .tolerance-input-field, #backoff-modal-input, #weight-entry-modal-input, #load-validation-expected-weight';
        document.querySelectorAll(selectors).forEach(function (inp) {
            if (inp._twoDecimalsBound) return;
            inp._twoDecimalsBound = true;
            inp.addEventListener('blur', function () {
                var v = this.value;
                if (v === '' || v === null) return;
                var n = parseFloat(v);
                if (!isNaN(n)) this.value = n.toFixed(2);
            });
        });
    };

    // Attach on initial load
    attachKeyboardToInputs();
    window.attachTwoDecimalEnforcement();

    // Re-attach when navigating between pages
    const originalGoToPageKb = goToPage;
    goToPage = function (pageName) {
        if (originalGoToPageKb) originalGoToPageKb(pageName);

        // Re-attach keyboard handlers after page change
        setTimeout(function () {
            attachKeyboardToInputs();
            if (typeof window.attachTwoDecimalEnforcement === 'function') window.attachTwoDecimalEnforcement();
        }, 200);
    };
});

// ===== PARAMETER SAMPLES & TOLERANCE MODAL =====
const labelToSamplesId = { Thickness: 'param-samples-thickness', Diameter: 'param-samples-diameter', Width: 'param-samples-width', Length: 'param-samples-length', Hardness: 'param-samples-hardness', Weight: 'param-samples-weight' };

// Handle checkbox change event - trigger popup flow when checkbox is checked
function handleParameterCheckboxChange(paramLabel, checkboxElement) {
    if (checkboxElement.checked === true) {
        openParamConfigModal(paramLabel);
    } else {
        var samplesId = labelToSamplesId[paramLabel];
        if (currentShape === 'oblong' && paramLabel === 'Length') samplesId = 'param-samples-diameter';
        if (samplesId) {
            const samplesEl = document.getElementById(samplesId);
            if (samplesEl) samplesEl.value = '0';
        }
    }
}

function openParamConfigModal(paramLabel) {
    currentParamConfig = paramLabel;
    var samplesId = labelToSamplesId[paramLabel];
    if (currentShape === 'oblong' && paramLabel === 'Length') samplesId = 'param-samples-diameter';
    const samplesEl = document.getElementById(samplesId);
    const modalInput = document.getElementById('param-samples-modal-input');
    const modalTitle = document.getElementById('param-samples-modal-title');
    const modal = document.getElementById('param-samples-modal');
    if (modalTitle) modalTitle.textContent = 'Samples for ' + paramLabel;
    if (modalInput && samplesEl) modalInput.value = samplesEl.value || '';
    if (modal) modal.style.display = 'flex';
}

function closeParamSamplesModal() {
    const modal = document.getElementById('param-samples-modal');
    if (modal) modal.style.display = 'none';
    // Don't clear currentParamConfig here - it's needed for the tolerance modal
}

function confirmParamSamples() {
    const modalInput = document.getElementById('param-samples-modal-input');
    const sampleSizeEl = document.getElementById('sample-size');
    const totalSampleSize = sampleSizeEl ? parseInt(sampleSizeEl.value, 10) : 0;
    const maxSamples = (totalSampleSize > 0 && totalSampleSize <= 100) ? totalSampleSize : 100;
    const rawVal = modalInput?.value?.trim();
    if (!rawVal) {
        alert('Please enter the number of samples for this parameter.');
        return;
    }
    let val = parseInt(modalInput.value, 10);
    if (isNaN(val) || val < 1) {
        alert('Please enter a valid sample count (1 or more).');
        return;
    }
    if (val > maxSamples) {
        alert('The parameter sample cannot be more than the total sample size (' + maxSamples + ').');
        return;
    }
    const samplesId = labelToSamplesId[currentParamConfig];
    const samplesEl = document.getElementById(samplesId);
    if (samplesEl) samplesEl.value = val;
    closeParamSamplesModal();
    if (currentTest === 'quick') {
        currentParamConfig = null;
        return;
    }
    const tolTitle = document.getElementById('param-tolerance-page-title');
    const upperT1 = document.getElementById('param-tolerance-upper-t1');
    const upperT2 = document.getElementById('param-tolerance-upper-t2');
    const lowerT1 = document.getElementById('param-tolerance-lower-t1');
    const lowerT2 = document.getElementById('param-tolerance-lower-t2');
    const nominal = document.getElementById('param-tolerance-nominal');
    
    if (tolTitle && currentParamConfig) {
        tolTitle.textContent = 'Tolerance for ' + currentParamConfig;
    } else if (tolTitle) {
        tolTitle.textContent = 'Tolerance';
    }
    
    // Update nominal label based on parameter
    const nominalLabel = document.getElementById('nominal-label-text');
    if (nominalLabel) {
        const labelMap = {
            'Thickness': 'Nominal Thickness',
            'Diameter': 'Nominal Diameter',
            'Width': 'Nominal Width',
            'Length': 'Nominal Length',
            'Hardness': 'Nominal Hardness',
            'Weight': 'Nominal Weight'
        };
        nominalLabel.textContent = labelMap[currentParamConfig] || 'Nominal Value';
    }
    
    const tol = paramTolerances[currentParamConfig] || {};
    
    // Get parameter value from the form to pre-fill nominal
    const paramValueMap = {
        'Thickness': 'thickness-value',
        'Diameter': 'diameter-value',
        'Width': 'width-value',
        'Length': 'length-value',
        'Hardness': 'hardness-value',
        'Weight': 'weight-value'
    };
    const paramValueId = paramValueMap[currentParamConfig];
    const paramValueEl = paramValueId ? document.getElementById(paramValueId) : null;
    const paramValue = paramValueEl ? paramValueEl.value : '';
    
    // Set tolerance values
    if (upperT1) upperT1.value = tol.upperT1 !== undefined ? String(tol.upperT1) : '';
    if (upperT2) upperT2.value = tol.upperT2 !== undefined ? String(tol.upperT2) : '';
    if (lowerT1) lowerT1.value = tol.lowerT1 !== undefined ? String(tol.lowerT1) : '';
    if (lowerT2) lowerT2.value = tol.lowerT2 !== undefined ? String(tol.lowerT2) : '';
    // Pre-fill nominal with parameter value if available, otherwise use saved value
    if (nominal) {
        nominal.value = paramValue || (tol.nominal !== undefined ? String(tol.nominal) : '');
    }
    
    // Set plausibility selection
    if (tol.plausibility) {
        selectPlausibility(tol.plausibility);
    } else {
        selectPlausibility('absolute'); // Default to absolute
    }
    
    if (typeof goToPage === 'function') goToPage('param-tolerance');
}

function closeParamToleranceModal() {
    currentParamConfig = null;
    if (typeof goToPage === 'function') goToPage('quick-test');
}

function cancelParamTolerance() {
    currentParamConfig = null;
    if (typeof goToPage === 'function') goToPage('quick-test');
}

function validateToleranceInput(value) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return { valid: true };
    const numericRegex = /^-?\d*\.?\d*$/;
    if (!numericRegex.test(trimmed)) return { valid: false, message: 'Please enter numeric values only' };
    return { valid: true };
}

function validateToleranceInputField(inputEl) {
    if (!inputEl) return;
    const val = inputEl.value;
    const result = validateToleranceInput(val);
    const errEl = document.getElementById('param-tolerance-error');
    if (!result.valid) {
        inputEl.classList.add('tolerance-input-error');
        if (errEl) {
            errEl.textContent = result.message || 'Please enter numeric values only';
            errEl.style.display = 'block';
        }
        inputEl.value = val.replace(/[^0-9.\-]/g, '');
    } else {
        inputEl.classList.remove('tolerance-input-error');
        if (errEl) errEl.style.display = 'none';
        inputEl.value = val.replace(/[^0-9.\-]/g, '');
    }
}

function confirmParamTolerance() {
    const ids = ['param-tolerance-upper-t1', 'param-tolerance-upper-t2', 'param-tolerance-lower-t1', 'param-tolerance-lower-t2', 'param-tolerance-nominal'];
    const errEl = document.getElementById('param-tolerance-error');
    for (const id of ids) {
        const el = document.getElementById(id);
        const val = el?.value?.trim() || '';
        if (val) {
            const r = validateToleranceInput(val);
            if (!r.valid) {
                if (errEl) {
                    errEl.textContent = r.message || 'Please enter numeric values only';
                    errEl.style.display = 'block';
                }
                el?.classList.add('tolerance-input-error');
                el?.focus();
                return;
            }
        }
        el?.classList.remove('tolerance-input-error');
    }
    if (errEl) errEl.style.display = 'none';

    const upperT1 = parseFloat(document.getElementById('param-tolerance-upper-t1')?.value) || 0;
    const upperT2 = parseFloat(document.getElementById('param-tolerance-upper-t2')?.value) || 0;
    const lowerT1 = parseFloat(document.getElementById('param-tolerance-lower-t1')?.value) || 0;
    const lowerT2 = parseFloat(document.getElementById('param-tolerance-lower-t2')?.value) || 0;
    const nominal = parseFloat(document.getElementById('param-tolerance-nominal')?.value) || 0;
    const plausibility = document.getElementById('plausibility-absolute')?.classList.contains('active') ? 'absolute' : 'percentage';

    const isAbsoluteSpec = upperT1 > nominal || upperT2 > nominal;
    if (isAbsoluteSpec && (lowerT1 !== 0 || lowerT2 !== 0 || upperT1 !== 0 || upperT2 !== 0)) {
        if (lowerT2 !== 0 && lowerT1 !== 0 && lowerT2 > lowerT1) {
            if (errEl) {
                errEl.textContent = '-T2 must be less than or equal to -T1.';
                errEl.style.display = 'block';
            }
            return;
        }
        if (lowerT1 !== 0 && lowerT1 > nominal) {
            if (errEl) {
                errEl.textContent = '-T1 must be at or below nominal.';
                errEl.style.display = 'block';
            }
            return;
        }
        if (upperT1 !== 0 && upperT1 < nominal) {
            if (errEl) {
                errEl.textContent = '+T1 must be at or above nominal.';
                errEl.style.display = 'block';
            }
            return;
        }
        if (upperT2 !== 0 && upperT1 !== 0 && upperT1 > upperT2) {
            if (errEl) {
                errEl.textContent = '+T1 must be less than or equal to +T2.';
                errEl.style.display = 'block';
            }
            return;
        }
        if (lowerT1 !== 0 && upperT1 !== 0 && lowerT1 > upperT1) {
            if (errEl) {
                errEl.textContent = '-T1 must be less than or equal to +T1.';
                errEl.style.display = 'block';
            }
            return;
        }
        if (lowerT2 !== 0 && lowerT2 > nominal) {
            if (errEl) {
                errEl.textContent = '-T2 must be at or below nominal.';
                errEl.style.display = 'block';
            }
            return;
        }
        if (upperT2 !== 0 && upperT2 < nominal) {
            if (errEl) {
                errEl.textContent = '+T2 must be at or above nominal.';
                errEl.style.display = 'block';
            }
            return;
        }
    }

    if (currentParamConfig) {
        paramTolerances[currentParamConfig] = {
            upperT1,
            upperT2,
            lowerT1,
            lowerT2,
            nominal,
            plausibility
        };
    }
    closeParamToleranceModal();
}

// Handle plausibility selection
function selectPlausibility(type) {
    const absoluteBtn = document.getElementById('plausibility-absolute');
    const percentageBtn = document.getElementById('plausibility-percentage');
    
    if (absoluteBtn && percentageBtn) {
        if (type === 'absolute') {
            absoluteBtn.classList.add('active');
            percentageBtn.classList.remove('active');
        } else {
            percentageBtn.classList.add('active');
            absoluteBtn.classList.remove('active');
        }
    }
}

// Toggle Custom Unit Input
function toggleUnitInput() {
    const select = document.getElementById('unit-selector');
    const input = document.getElementById('custom-unit-input');
    const displayContainer = document.getElementById('conversion-factor-display');

    if (select && input) {
        if (select.value === 'User Defined') {
            // Show the conversion factor popup immediately if no values are set
            // Otherwise, just show the display
            if (!input.value.trim() || customUnitConversionFactor === null) {
                showConversionFactorModal();
            } else {
                // Show display if values already exist
                updateConversionFactorDisplay(input.value.trim(), customUnitConversionFactor);
            }
        } else {
            input.style.display = 'none';
            input.value = ''; // Clear value
            // Hide conversion factor display
            if (displayContainer) displayContainer.style.display = 'none';
            // Clear conversion factor when switching away from User Defined
            const conversionFactorInput = document.getElementById('conversion-factor-input');
            const customUnitNameInput = document.getElementById('custom-unit-name-input');
            if (conversionFactorInput) conversionFactorInput.value = '';
            if (customUnitNameInput) customUnitNameInput.value = '';
            customUnitConversionFactor = null;
        }
    }
}

// Show conversion factor modal
function showConversionFactorModal() {
    const modal = document.getElementById('conversion-factor-modal');
    const customUnitInput = document.getElementById('custom-unit-input');
    const customUnitNameInput = document.getElementById('custom-unit-name-input');
    const conversionFactorInput = document.getElementById('conversion-factor-input');
    
    if (modal) {
        // Pre-fill unit name if it exists in the hidden input field
        if (customUnitNameInput && customUnitInput && customUnitInput.value.trim()) {
            customUnitNameInput.value = customUnitInput.value.trim();
        } else if (customUnitNameInput) {
            customUnitNameInput.value = '';
        }
        
        // Pre-fill conversion factor if it exists
        if (conversionFactorInput && typeof customUnitConversionFactor !== 'undefined' && customUnitConversionFactor !== null) {
            conversionFactorInput.value = String(customUnitConversionFactor);
        } else {
            if (conversionFactorInput) conversionFactorInput.value = '';
        }
        
        modal.style.display = 'flex';
        // Focus on unit name input after modal is shown (or conversion factor if unit name exists)
        setTimeout(() => {
            if (customUnitNameInput && customUnitNameInput.value.trim()) {
                if (conversionFactorInput) conversionFactorInput.focus();
            } else {
                if (customUnitNameInput) customUnitNameInput.focus();
            }
        }, 100);
    }
}

// Close conversion factor modal
function closeConversionFactorModal() {
    const modal = document.getElementById('conversion-factor-modal');
    const select = document.getElementById('unit-selector');
    
    if (modal) {
        modal.style.display = 'none';
        // Check if this was a new entry (no existing values) - if so, reset to default unit
        const customUnitInput = document.getElementById('custom-unit-input');
        const hadExistingValues = customUnitInput && customUnitInput.value.trim() && 
                                  customUnitConversionFactor !== null;
        
        if (!hadExistingValues && select) {
            // Reset to default unit only if there were no existing values
            const customUnitNameInput = document.getElementById('custom-unit-name-input');
            const conversionFactorInput = document.getElementById('conversion-factor-input');
            
            if (!customUnitNameInput || !customUnitNameInput.value.trim() || 
                !conversionFactorInput || !conversionFactorInput.value.trim()) {
                select.value = 'Newton (N)';
                if (customUnitInput) {
                    customUnitInput.style.display = 'none';
                    customUnitInput.value = '';
                }
                customUnitConversionFactor = null;
            }
        }
    }
}

// Confirm conversion factor
function confirmConversionFactor() {
    const conversionFactorInput = document.getElementById('conversion-factor-input');
    const customUnitNameInput = document.getElementById('custom-unit-name-input');
    const customUnitInput = document.getElementById('custom-unit-input');
    
    // Validate unit name
    if (!customUnitNameInput || !customUnitNameInput.value.trim()) {
        alert('Please enter a unit name');
        if (customUnitNameInput) customUnitNameInput.focus();
        return;
    }
    
    // Validate conversion factor
    if (!conversionFactorInput || !conversionFactorInput.value.trim()) {
        alert('Please enter a conversion factor');
        if (conversionFactorInput) conversionFactorInput.focus();
        return;
    }
    
    const factor = parseFloat(conversionFactorInput.value);
    if (isNaN(factor) || factor <= 0) {
        alert('Please enter a valid positive number for conversion factor');
        if (conversionFactorInput) conversionFactorInput.focus();
        return;
    }
    
    // Store unit name in the hidden input field
    const unitName = customUnitNameInput.value.trim();
    if (customUnitInput) {
        customUnitInput.value = unitName;
        customUnitInput.style.display = 'block';
    }
    
    // Store conversion factor globally
    customUnitConversionFactor = factor;
    
    // Update the display
    updateConversionFactorDisplay(unitName, factor);
    
    closeConversionFactorModal();
}

// Update conversion factor display
function updateConversionFactorDisplay(unitName, conversionFactor) {
    const displayContainer = document.getElementById('conversion-factor-display');
    const displayUnitName = document.getElementById('display-unit-name');
    const displayConversionFactor = document.getElementById('display-conversion-factor');
    
    if (displayContainer && displayUnitName && displayConversionFactor) {
        if (unitName && conversionFactor) {
            displayUnitName.textContent = unitName;
            displayConversionFactor.textContent = conversionFactor.toFixed(6);
            displayContainer.style.display = 'block';
        } else {
            displayContainer.style.display = 'none';
        }
    }
}

// ===== FACTORY SETTINGS FUNCTIONS =====
async function initFactorySettings() {
    try {
        const screen = document.getElementById('page-factory-settings');
        if (!screen) return;

        // Wait a bit to ensure screen is visible
        await new Promise(resolve => setTimeout(resolve, 50));

        // Load saved factory settings from API
        let settings = {};
        try {
            const result = await apiRequest('/api/data/factory-settings');
            settings = result.settings || {};
        } catch (e) {
            console.warn('Failed to load factory settings from API:', e);
            // Fallback to localStorage
            const stored = localStorage.getItem('factorySettings');
            settings = stored ? JSON.parse(stored) : {};
        }

        // Populate all fields with saved data (or leave empty if first launch)
        const companyNameEl = document.getElementById('factory-company-name');
        const companyLocationEl = document.getElementById('factory-company-location');
        const serialNoEl = document.getElementById('factory-serial-no');
        const modelNoEl = document.getElementById('factory-model-no');
        const instrumentIdEl = document.getElementById('factory-instrument-id');
        const installationDateEl = document.getElementById('factory-installation-date');
        const firmwareEl = document.getElementById('factory-firmware');
        const installedByEl = document.getElementById('factory-installed-by');
        const loadCellRangeEl = document.getElementById('factory-load-cell-range');
        const maxRecipesEl = document.getElementById('factory-max-recipes');
        const maxUsersEl = document.getElementById('factory-max-users');
        const maxAdminsEl = document.getElementById('factory-max-admins');
        const maxSupervisorsEl = document.getElementById('factory-max-supervisors');

        if (companyNameEl) companyNameEl.value = settings.companyName || '';
        if (companyLocationEl) companyLocationEl.value = settings.companyLocation || '';
        if (serialNoEl) serialNoEl.value = settings.serialNo || '';
        if (modelNoEl) modelNoEl.value = settings.modelNo || '';
        if (instrumentIdEl) instrumentIdEl.value = settings.instrumentId || '';
        if (installationDateEl) installationDateEl.value = settings.installationDate || '';
        if (firmwareEl) firmwareEl.value = 'RD-RDT v1.0.0';
        if (installedByEl) installedByEl.value = settings.installedBy || '';
        if (loadCellRangeEl) loadCellRangeEl.value = String(settings.loadCellRange || 500);
        if (maxRecipesEl) maxRecipesEl.value = String(settings.maxRecipes || 150);
        if (maxUsersEl) maxUsersEl.value = String(settings.maxUsers || 10);
        if (maxAdminsEl) maxAdminsEl.value = String(settings.maxAdmins || 2);
        if (maxSupervisorsEl) maxSupervisorsEl.value = String(settings.maxSupervisors || 3);

        console.log('[Factory Settings] Initialized with settings:', settings);
    } catch (e) {
        console.error('Error initializing factory settings:', e);
    }
}

async function saveFactorySettings() {
    console.log('[Factory Settings] Save button clicked');
    
    // Check RBAC permission
    if (typeof canPerformAction === 'function' && typeof getCurrentRole === 'function') {
        const role = getCurrentRole();
        if (!canPerformAction(role, 'factory-settings', 'save')) {
            alert('You do not have permission to save factory settings.');
            return;
        }
    }
    
    try {
        // Collect all form field values
        const companyNameEl = document.getElementById('factory-company-name');
        const companyLocationEl = document.getElementById('factory-company-location');
        const serialNoEl = document.getElementById('factory-serial-no');
        const modelNoEl = document.getElementById('factory-model-no');
        const instrumentIdEl = document.getElementById('factory-instrument-id');
        const installationDateEl = document.getElementById('factory-installation-date');
        const firmwareEl = document.getElementById('factory-firmware');
        const installedByEl = document.getElementById('factory-installed-by');
        const loadCellRangeEl = document.getElementById('factory-load-cell-range');
        const maxRecipesEl = document.getElementById('factory-max-recipes');
        const maxUsersEl = document.getElementById('factory-max-users');
        const maxAdminsEl = document.getElementById('factory-max-admins');
        const maxSupervisorsEl = document.getElementById('factory-max-supervisors');

        const companyName = companyNameEl && companyNameEl.value ? companyNameEl.value.trim() : '';
        const companyLocation = companyLocationEl && companyLocationEl.value ? companyLocationEl.value.trim() : '';
        const serialNo = serialNoEl && serialNoEl.value ? serialNoEl.value.trim() : '';
        const modelNo = modelNoEl && modelNoEl.value ? modelNoEl.value.trim() : '';
        const instrumentId = instrumentIdEl && instrumentIdEl.value ? instrumentIdEl.value.trim() : '';
        const installationDate = installationDateEl && installationDateEl.value ? installationDateEl.value : '';
        const firmware = 'RD-RDT v1.0.0';
        const installedBy = installedByEl && installedByEl.value ? installedByEl.value.trim() : '';
        const loadCellRange = parseInt(loadCellRangeEl?.value || 500, 10);
        const maxRecipes = Math.max(1, Math.min(999, parseInt(maxRecipesEl?.value || 150, 10)));
        const maxUsers = Math.max(1, Math.min(999, parseInt(maxUsersEl?.value || 10, 10)));
        const maxAdmins = Math.max(1, Math.min(99, parseInt(maxAdminsEl?.value || 2, 10)));
        const maxSupervisors = Math.max(1, Math.min(99, parseInt(maxSupervisorsEl?.value || 3, 10)));

        // Validate required fields
        if (!companyName || !companyLocation) {
            alert('Company Name and Location are required');
            return;
        }

        if (![300, 500, 800].includes(loadCellRange)) {
            alert('Load Cell Range must be 300, 500, or 800 N');
            return;
        }

        // Confirm save with app UX modal (no Cancel button)
        showModal(
            'Save Factory Settings',
            'Are you sure you want to save these factory settings?',
            async function (confirmed) {
                if (!confirmed) return;
                try {
                    const data = {
                        companyName,
                        companyLocation,
                        serialNo,
                        modelNo,
                        instrumentId,
                        installationDate,
                        firmware,
                        installedBy,
                        loadCellRange,
                        maxRecipes,
                        maxUsers,
                        maxAdmins,
                        maxSupervisors
                    };

                    await apiRequest('/api/data/factory-settings', {
                        method: 'POST',
                        body: JSON.stringify(data)
                    });

                    try {
                        localStorage.setItem('factorySettings', JSON.stringify(data));
                    } catch (e) {
                        console.warn('Failed to save factory settings to localStorage:', e);
                    }

                    await updateFactorySettingsDisplays();

                    alert('Factory settings saved successfully');
                    _navigatingAfterSave = true;
                    setTimeout(() => {
                        goToPage('settings');
                    }, 500);

                } catch (e) {
                    console.error('[Factory Settings] Error saving factory settings:', e);
                    alert('Failed to save factory settings');
                }
            },
            true,
            false
        );
    } catch (e) {
        console.error('[Factory Settings] Error saving factory settings:', e);
        alert('Failed to save factory settings');
    }
}

async function updateFactorySettingsDisplays() {
    try {
        let factorySettings = {};
        try {
            const result = await apiRequest('/api/data/factory-settings');
            factorySettings = result.settings || {};
        } catch (e) {
            console.warn('Failed to load factory settings from API:', e);
            // Fallback to localStorage
            const stored = localStorage.getItem('factorySettings');
            factorySettings = stored ? JSON.parse(stored) : {};
        }

        // Update login page: Model No and Serial No
        const modelNo = (factorySettings.modelNo || '').trim();
        const serialNo = (factorySettings.serialNo || '').trim();
        const hasDeviceInfo = modelNo || serialNo;

        const loginFooterInfo = document.getElementById('login-footer-info');
        const loginFooterModelNo = document.getElementById('login-footer-model-no');
        const loginFooterSerialNo = document.getElementById('login-footer-serial-no');

        if (loginFooterInfo && loginFooterModelNo && loginFooterSerialNo) {
            loginFooterModelNo.textContent = modelNo || '--';
            loginFooterSerialNo.textContent = serialNo || '--';
            loginFooterInfo.style.display = hasDeviceInfo ? '' : 'none';
        }

        console.log('[Factory Settings] Updated displays with settings:', factorySettings);
    } catch (e) {
        console.error('Error updating factory settings displays:', e);
    }
}
