/**
 * rbac.js - Role-Based Access Control (RBAC) System
 * Manages user permissions, UI visibility, and navigation guards
 */

// ========== ROLE-BASED ACCESS CONTROL (RBAC) ==========
// This structure defines RESTRICTIONS, not permissions
// Default behavior: Everything is ALLOWED unless explicitly restricted
// Restriction types: 'no-access', 'view-only', 'edit-blocked'

var ROLE_RESTRICTIONS = {
  admin: {
    // Admin: Factory settings disabled (even admins shouldn't mess with factory settings)
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',  // Only factory role can reset
  },
  supervisor: {
    // USER MANAGEMENT
    'user-manage': 'view-only',      // Can view members list but cannot edit/add/delete users
    'user-add': 'no-access',        // Cannot open Add Member screen
    'user-delete': 'no-access',     // Cannot delete users
    'user-change-role': 'no-access',// Cannot change user roles
    
    // SETTINGS / FACTORY
    'factory-settings': 'view-only', // Can view but not save changes
    'factory-reset': 'no-access',    // Only factory role can reset
    'edit-datetime': 'no-access',    // Cannot edit date and time (only admin and factory can)
    
    // REPORTS
    'reports-delete': 'no-access',  // Cannot delete reports
    
    // RECIPES
    'recipe-delete': 'no-access',   // Cannot delete recipes
  },
  user: {
    // USER MANAGEMENT
    'user-manage': 'no-access',
    'user-add': 'no-access',
    'user-delete': 'no-access',
    'user-change-role': 'no-access',
    
    // SETTINGS / FACTORY
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',    // Only factory role can reset
    'edit-datetime': 'no-access',    // Cannot edit date and time
    
    // RECIPES - user can only load and run; no edit, delete, or create
    'recipe-edit': 'no-access',      // Cannot edit, create, or quick-test recipes
    'recipe-delete': 'no-access',    // Cannot delete recipes
    
    // REPORTS
    'reports-delete': 'no-access',  // Cannot delete reports
    
    // VALIDATION / CALIBRATION - no access
    'validate-menu': 'no-access',           // Cannot open validation & calibration at all
    'validate-temp-calibration': 'no-access',
  },
  factory: {
    // Factory has full access: no restrictions
    // Empty object means all features are allowed
  }
};

// Map screen/page IDs to feature keys for access control
var SCREEN_FEATURE_MAP = {
  'login': 'login',
  'home': 'dashboard',
  'dashboard': 'dashboard',
  'user-profile': 'profile',
  'profile': 'profile',
  'validate': 'validate-menu',
  'validate-select': 'validate-menu',
  'validate-type-select': 'validate-menu',
  'load-validation': 'validate-menu',
  'distance-validation': 'validate-menu',
  'distance-validation-result': 'validate-menu',
  'calibration-type-select': 'validate-menu',
  'load-calibration': 'validate-menu',
  'distance-zero-calibration': 'validate-menu',
  'stroke-validation': 'validate-stroke',
  'temp-validation': 'validate-temp',
  'temp-calibration-input': 'validate-temp-calibration',
  'calibration': 'validate-temp-calibration',
  'reports': 'reports-view',
  'report-preview': 'reports-view',
  'view-recipes': 'recipe-list',
  'recipe-print-preview': 'reports-view',
  'settings': 'settings',
  'factory-support': 'factory-support',
  'factory-support-result': 'factory-support',
  'factory-settings': 'factory-settings',
  'datetime': 'edit-datetime',
  'edit-datetime': 'edit-datetime',
  'manage-recipes': 'recipe-list',
  'param-tolerance': 'recipe-edit',
  'quick-test': 'quick-test',
  'create-recipe': 'recipe-edit',
  'manage-members': 'user-manage',
  'add-member': 'user-add',
  'test-run': 'dashboard'
};

// Map action names to feature keys for function-level access control
var ACTION_FEATURE_MAP = {
  'add-member': 'user-add',
  'delete-member': 'user-delete',
  'change-role': 'user-change-role',
  'edit-member': 'user-manage',
  'save-factory-settings': 'factory-settings',
  'save-recipe': 'recipe-edit',
  'delete-recipe': 'recipe-delete',
  'edit-recipe': 'recipe-edit',
  'start-validation': 'validate-menu',
  'start-test': 'dashboard',
  'start-temperature-validation': 'validate-temp',
  'start-stroke-validation': 'validate-stroke',
  'calibrate-temperature': 'validate-temp-calibration',
  'export-reports': 'reports-view',
  'print-report': 'reports-view',
  'delete-report': 'reports-delete',
  'save-profile': 'profile'
};

// ========== GLOBAL CURRENT USER ==========
var currentUser = null;

// ========== RBAC HELPER FUNCTIONS ==========

/**
 * Get current user role from window.currentUser or currentUser variable
 * @returns {string|null} Normalized role (lowercase) or null
 */
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

/**
 * Get restriction for a role and feature
 * @param {string} role - User role
 * @param {string} featureKey - Feature key to check
 * @returns {string|null} Restriction type or null if no restriction
 */
function getRestriction(role, featureKey) {
  if (!role || !featureKey) return null;
  var normRole = String(role).toLowerCase();
  var roleRules = ROLE_RESTRICTIONS[normRole] || {};
  return roleRules[featureKey] || null;
}

/**
 * Check if a feature is restricted
 * @param {string} role - User role
 * @param {string} featureKey - Feature key to check
 * @returns {boolean} True if restricted, false if allowed
 */
function isFeatureRestricted(role, featureKey) {
  return !!getRestriction(role, featureKey);
}

/**
 * Check if user can access a feature/screen
 * @param {string} role - User role
 * @param {string} featureKey - Feature key to check
 * @returns {boolean} True if allowed, false if blocked
 */
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
  // For factory-settings, view-only = supervisor can see the button but must not open the page (button disabled)
  if (featureKey === 'factory-settings' && restriction === 'view-only') return false;
  // Other view-only: still allow opening the screen; actions blocked separately
  return true;
}

/**
 * Check if feature is view-only
 * @param {string} role - User role
 * @param {string} featureKey - Feature key to check
 * @returns {boolean} True if view-only
 */
function isViewOnly(role, featureKey) {
  return getRestriction(role, featureKey) === 'view-only';
}

/**
 * Check if user can perform an action (edit, delete, save, etc.)
 * @param {string} role - User role
 * @param {string} featureKey - Feature key
 * @param {string} action - Action name (edit, delete, save, etc.)
 * @returns {boolean} True if action is allowed
 */
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

/**
 * Check if user is protected factory user
 * @param {object} user - User object
 * @returns {boolean} True if protected factory user
 */
function isProtectedFactoryUser(user) {
  if (!user) return false;
  var username = (user.username || user.user || '').toString().toUpperCase();
  return username === 'RLERLT';
}

/**
 * Check navigation access for a screen/page
 * @param {string} screenId - Screen/page ID
 * @returns {boolean} True if navigation is allowed
 */
function checkNavigationAccess(screenId) {
  // Always allow login screen
  if (screenId === 'login') return true;
  
  var role = getCurrentRole();
  
  // If no user and trying to access non-login screen, block
  if (!role) {
    return false;
  }
  
  // Get feature key for this screen
  var featureKey = SCREEN_FEATURE_MAP[screenId] || screenId;
  
  // Check access
  return canAccess(role, featureKey);
}

/**
 * Update UI elements based on user permissions
 */
function updateUIForUser() {
  try {
    if (!currentUser && !window.currentUser) return;
    
    var role = null;
    try {
      role = getCurrentRole();
    } catch (e) {
      console.warn('[updateUIForUser] Error getting role:', e);
      role = (currentUser || window.currentUser)?.role || null;
      if (role) role = String(role).toLowerCase();
    }
    
    if (!role) return;
    
    // Update profile information
    try {
      var profileNameEl = document.getElementById('profile-name-display');
      var profileRoleEl = document.getElementById('profile-role-display');
      var profileEditNameEl = document.getElementById('profile-fullname');
      
      var user = currentUser || window.currentUser;
      if (user) {
        if (profileNameEl) profileNameEl.textContent = user.name || '';
        if (profileRoleEl) profileRoleEl.textContent = user.role || '';
        if (profileEditNameEl) profileEditNameEl.value = user.name || '';
      }
    } catch (e) {
      console.warn('[updateUIForUser] Error updating profile:', e);
    }
    
    // Profile admin buttons - show only if user can access user-manage or user-add
    try {
      var adminButtons = document.querySelector('.profile-actions');
      if (adminButtons) {
        var normRole = role ? String(role).toLowerCase() : null;
        var isAdminOrFactory = normRole === 'admin' || normRole === 'factory';
        var canManage = false;
        var canAdd = false;
        try {
          canManage = isAdminOrFactory && canAccess(role, 'user-manage');
          canAdd = isAdminOrFactory && canAccess(role, 'user-add');
        } catch (e) {
          console.warn('[updateUIForUser] Error checking access:', e);
        }
        // Show/hide buttons based on permissions
        var manageBtn = adminButtons.querySelector('[onclick*="manage-members"]');
        var addBtn = adminButtons.querySelector('[onclick*="add-member"]');
        if (manageBtn) manageBtn.style.display = canManage ? '' : 'none';
        if (addBtn) addBtn.style.display = canAdd ? '' : 'none';
      }
    } catch (e) {
      console.warn('[updateUIForUser] Error updating admin buttons:', e);
    }
    
    // Define UI elements and their corresponding feature keys
    var items = [
      { id: 'btn-save-factory-settings', feature: 'factory-settings' },
      { selector: '[onclick*="goToPage(\'factory-settings\')"]', feature: 'factory-settings' },
      { selector: '[onclick*="goToPage(\'manage-members\')"]', feature: 'user-manage' },
      { selector: '[onclick*="goToPage(\'add-member\')"]', feature: 'user-add' },
      { selector: '[onclick*="goToPage(\'datetime\')"]', feature: 'edit-datetime' },
      { selector: '[onclick*="startRecipeCreation"]', feature: 'recipe-edit' },
      { selector: '[onclick*="goToPage(\'quick-test\')"]', feature: 'quick-test' },
      { selector: '[onclick*="editRecipe"]', feature: 'recipe-edit' },
      { selector: '[onclick*="deleteRecipe"]', feature: 'recipe-delete' },
      { selector: '[onclick*="deleteMember"]', feature: 'user-delete' },
      { selector: '[onclick*="confirmRoleChange"]', feature: 'user-change-role' },
      { selector: '[onclick*="saveFactorySettings"]', feature: 'factory-settings' }
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
      { selector: '.settings-factory', feature: 'factory-settings' },
      { selector: '.settings-reset', feature: 'factory-reset' },
      { selector: '.settings-datetime', feature: 'edit-datetime' },
      { selector: '.settings-validation', feature: 'validate-menu' }
    ];
    
    settingsItems.forEach(function(item) {
      var elements = document.querySelectorAll(item.selector);
      elements.forEach(function(el) {
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
          // Factory Settings: explicit message for supervisor (button visible but disabled)
          var title = (item.feature === 'factory-settings')
            ? 'Factory Settings is disabled for Supervisor'
            : 'You do not have permission to perform this action';
          el.title = title;
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
    });
    
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
    
  } catch (e) {
    console.error('[updateUIForUser] Unexpected error:', e);
  }
}

// ========== INPUT FOCUS HANDLERS ==========
// Handles keyboard opening/closing and input focus management

/**
 * Attach input focus handlers to elements
 * @param {HTMLElement|Document} root - Root element to attach handlers to
 */
function attachInputFocusHandlers(root) {
  root = root || document;
  var inputs = root.querySelectorAll('input[type="text"], input[type="password"], input[type="number"], input:not([type]), textarea');
  
  inputs.forEach(function(inp) {
    if (inp.tagName === 'SELECT') return;
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'button' || inp.type === 'submit' || inp.type === 'datetime-local') return;
    if (inp._cursor_focus_bound) return;
    
    inp._cursor_focus_bound = true;
    
    inp.addEventListener('focus', function(ev) {
      var input = ev.target;
      if (input.tagName !== 'SELECT') {
        input.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      
      // Set cursor to end
      var setCursorToEnd = function() {
        if (!input || typeof input.setSelectionRange !== 'function') return;
        try {
          var len = input.value ? input.value.length : 0;
          input.setSelectionRange(len, len);
        } catch(e) {}
      };
      setCursorToEnd();
      setTimeout(setCursorToEnd, 50);
      
      // Open keyboard if function exists
      if (typeof openOSKForInput === 'function') {
        openOSKForInput(input);
      }
      
      // Add keyboard-open class
      document.body.classList.add('keyboard-open');
      var osk = document.getElementById('osk');
      if (osk) osk.classList.add('visible');
      if (typeof window !== 'undefined') {
        window._lastOSKOpenTime = Date.now();
      }
    }, { passive: true });
    
    inp.addEventListener('blur', function() {
      setTimeout(function() {
        if (window._lastOSKOpenTime && (Date.now() - window._lastOSKOpenTime) < 200) return;
        var ae = document.activeElement;
        var osk = document.getElementById('osk');
        var keyboardRoot = document.getElementById('keyboard-root');
        if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
        if (osk && ae && osk.contains(ae)) return;
        if (keyboardRoot && ae && keyboardRoot.contains(ae)) return;
        if (typeof closeOSK === 'function') {
          closeOSK();
        } else {
          document.body.classList.remove('keyboard-open');
          if (osk) osk.classList.remove('visible');
        }
      }, 120);
    });
    
    // Enter key navigation
    if (!inp._enter_key_bound) {
      inp._enter_key_bound = true;
      inp.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          var form = inp.closest('form');
          var screen = inp.closest('.page');
          var container = form || screen || root;
          var allInputs = Array.from(container.querySelectorAll('input[type="text"], input[type="password"], input[type="number"], input:not([type]), textarea, select'));
          var focusableInputs = allInputs.filter(function(i) {
            if (i.tagName === 'SELECT') return true;
            if (i.type === 'checkbox' || i.type === 'radio' || i.type === 'button' || i.type === 'submit' || i.type === 'datetime-local') return false;
            if (i.disabled || i.style.display === 'none' || i.offsetParent === null) return false;
            return true;
          });
          var currentInput = ev.target;
          var currentIndex = focusableInputs.indexOf(currentInput);
          if (currentIndex >= 0 && currentIndex < focusableInputs.length - 1) {
            var nextInput = focusableInputs[currentIndex + 1];
            if (nextInput) {
              setTimeout(function() {
                nextInput.focus();
                nextInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }, 10);
            }
          } else if (currentIndex === focusableInputs.length - 1) {
            // Last field: focus submit button if in form
            if (form) {
              var submitBtn = form.querySelector('button[type="submit"]');
              if (submitBtn) {
                setTimeout(function() {
                  submitBtn.focus();
                }, 10);
                return;
              }
            }
            currentInput.blur();
          }
        }
      });
    }
  });
  
  // Handle select elements
  var selects = root.querySelectorAll('select');
  selects.forEach(function(sel) {
    if (sel._cursor_focus_bound) return;
    sel._cursor_focus_bound = true;
    sel.setAttribute('inputmode', 'none');
  });
  
  // Observe DOM changes for dynamically added inputs
  if (root === document || root === document.body) {
    var observer = new MutationObserver(function(mutations) {
      mutations.forEach(function(mutation) {
        mutation.addedNodes.forEach(function(node) {
          if (node.nodeType === 1) {
            if (node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') {
              attachInputFocusToSingle(node);
            }
            var inputs = node.querySelectorAll && node.querySelectorAll('input[type="text"], input[type="password"], input[type="number"], textarea');
            if (inputs) {
              inputs.forEach(function(inp) {
                attachInputFocusToSingle(inp);
              });
            }
          }
        });
      });
    });
    observer.observe(root, { childList: true, subtree: true });
  }
}

/**
 * Attach focus handlers to a single input element
 * @param {HTMLElement} inp - Input element
 */
function attachInputFocusToSingle(inp) {
  if (!inp || inp._cursor_focus_bound) return;
  if (inp.tagName === 'SELECT') return;
  if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'button' || inp.type === 'submit') return;
  
  inp._cursor_focus_bound = true;
  
  inp.addEventListener('focus', function(ev) {
    var input = ev.target;
    if (input.tagName !== 'SELECT') {
      input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    var setCursorToEnd = function() {
      if (!input || typeof input.setSelectionRange !== 'function') return;
      try {
        var len = input.value ? input.value.length : 0;
        input.setSelectionRange(len, len);
      } catch(e) {}
    };
    setCursorToEnd();
    setTimeout(setCursorToEnd, 50);
    if (typeof openOSKForInput === 'function') {
      openOSKForInput(input);
    }
    document.body.classList.add('keyboard-open');
    var osk = document.getElementById('osk');
    if (osk) osk.classList.add('visible');
    if (typeof window !== 'undefined') {
      window._lastOSKOpenTime = Date.now();
    }
  }, { passive: true });
  
  inp.addEventListener('blur', function() {
    setTimeout(function() {
      if (window._lastOSKOpenTime && (Date.now() - window._lastOSKOpenTime) < 200) return;
      var ae = document.activeElement;
      var osk = document.getElementById('osk');
      var keyboardRoot = document.getElementById('keyboard-root');
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
      if (osk && ae && osk.contains(ae)) return;
      if (keyboardRoot && ae && keyboardRoot.contains(ae)) return;
      document.body.classList.remove('keyboard-open');
      if (osk) osk.classList.remove('visible');
    }, 120);
  });
  
  // Enter key navigation
  if (!inp._enter_key_bound) {
    inp._enter_key_bound = true;
    inp.addEventListener('keydown', function(ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        var form = inp.closest('form');
        var screen = inp.closest('.page');
        var container = form || screen || document;
        var allInputs = Array.from(container.querySelectorAll('input[type="text"], input[type="password"], input[type="number"], input:not([type]), textarea, select'));
        var focusableInputs = allInputs.filter(function(i) {
          if (i.tagName === 'SELECT') return true;
          if (i.type === 'checkbox' || i.type === 'radio' || i.type === 'button' || i.type === 'submit' || i.type === 'datetime-local') return false;
          if (i.disabled || i.style.display === 'none' || i.offsetParent === null) return false;
          return true;
        });
        var currentInput = ev.target;
        var currentIndex = focusableInputs.indexOf(currentInput);
        if (currentIndex >= 0 && currentIndex < focusableInputs.length - 1) {
          var nextInput = focusableInputs[currentIndex + 1];
          if (nextInput) {
            setTimeout(function() {
              nextInput.focus();
              nextInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 10);
          }
        } else if (currentIndex === focusableInputs.length - 1) {
          if (form) {
            var submitBtn = form.querySelector('button[type="submit"]');
            if (submitBtn) {
              setTimeout(function() {
                submitBtn.focus();
              }, 10);
              return;
            }
          }
          currentInput.blur();
        }
      }
    });
  }
}

// Initialize input focus handlers on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() {
    attachInputFocusHandlers(document);
  });
} else {
  attachInputFocusHandlers(document);
}

// Make functions globally accessible
window.attachInputFocusHandlers = attachInputFocusHandlers;
window.attachInputFocusToSingle = attachInputFocusToSingle;
window.getCurrentRole = getCurrentRole;
window.getRestriction = getRestriction;
window.canAccess = canAccess;
window.isViewOnly = isViewOnly;
window.canPerformAction = canPerformAction;
window.isProtectedFactoryUser = isProtectedFactoryUser;
window.checkNavigationAccess = checkNavigationAccess;
window.updateUIForUser = updateUIForUser;
