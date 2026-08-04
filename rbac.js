/**
 * rbac.js - Role-Based Access Control for DT-CFR Disintegration Tester
 *
 * Non-Factory users (including Admin): capability is driven only by permission cards
 * stored in featureOverrides.allow. Role name does not grant feature access.
 * Factory / RLERLT: full access except factory-only routes handled separately.
 *
 * Role caps may soften a card-granted feature to view-only; they must never revoke
 * a feature that was explicitly granted via permission cards (Hardness-Cfr card model).
 */

var ROLE_RESTRICTIONS = {
  admin: {
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',
  },
  supervisor: {
    'factory-settings': 'view-only',
    'factory-reset': 'no-access',
    // Soft caps only — cards still grant the feature; these limit write actions.
    'user-manage': 'view-only',
    'reports-delete': 'view-only',
  },
  user: {
    'factory-settings': 'no-access',
    'factory-reset': 'no-access',
  },
  factory: {},
};

/** Stored permission card keys (Add Member UI + member.featureOverrides.allow). */
var PERMISSION_CARD_KEYS = [
  'perm_test_access',
  'perm_test_report_approve',
  'perm_recipe_manage',
  'perm_recipe_approve',
  'perm_profile_admin',
  'perm_validation_test',
  'perm_validation_report_approve',
  'perm_calibration',
  'perm_calibration_report_approve',
  'perm_datetime',
  'perm_reports_view',
  'perm_audit_view',
  'perm_export_usb',
  'perm_export_approve',
];

/**
 * Each card expands to internal feature keys used by navigation and checks.
 * Internal keys are unique strings (screen map, action checks, or explicit gates).
 */
var PERM_CARD_EXPAND = {
  perm_test_access: ['quick-test', 'recipe-test', 'settings', 'heater-control', 'add-beakers', 'add-baskets'],
  perm_test_report_approve: ['test-report-approve'],
  perm_recipe_manage: ['recipe-manage', 'recipe-list', 'recipe-edit', 'recipe-delete', 'disable-recipes', 'recipe-enable', 'settings'],
  perm_recipe_approve: ['recipe-approve'],
  perm_profile_admin: [
    'user-manage',
    'user-add',
    'user-delete',
    'user-unlock',
    'user-enable',
    'user-change-role',
    'settings',
  ],
  perm_validation_test: ['validation-test', 'validate-menu', 'settings'],
  perm_validation_report_approve: ['validation-report-approve'],
  perm_calibration: ['calibration-menu', 'settings'],
  perm_calibration_report_approve: ['calibration-report-approve'],
  perm_datetime: ['edit-datetime', 'settings'],
  perm_reports_view: ['reports-view'],
  perm_audit_view: ['audit-view'],
  perm_export_usb: ['export-usb'],
  perm_export_approve: ['export-approve'],
};

var PERMISSION_CARD_CATALOG = [
  { key: 'perm_test_access', label: 'Test access', description: 'Quick/recipe tests plus heater, beaker, and basket settings.', accent: 0 },
  { key: 'perm_test_report_approve', label: 'Test report approval', description: 'Approve pending test reports (e-signature).', accent: 1 },
  { key: 'perm_recipe_manage', label: 'Manage recipes', description: 'Create and edit recipes.', accent: 2 },
  { key: 'perm_recipe_approve', label: 'Recipe approval', description: 'Approve / verify recipe creation and changes.', accent: 3 },
  { key: 'perm_profile_admin', label: 'Profile management', description: 'Add, disable, edit, lock, unlock, and change roles for profiles.', accent: 4 },
  { key: 'perm_validation_test', label: 'Validation test access', description: 'Run stroke and temperature validation.', accent: 5 },
  { key: 'perm_validation_report_approve', label: 'Validation report approval', description: 'Approve pending validation reports.', accent: 6 },
  { key: 'perm_calibration', label: 'Calibration access', description: 'Run temperature calibration and authorize calibration e-sign.', accent: 7 },
  { key: 'perm_calibration_report_approve', label: 'Calibration report approval', description: 'Approve pending calibration reports (e-signature).', accent: 8 },
  { key: 'perm_datetime', label: 'Edit date and time', description: 'Change system date, time, and RTC.', accent: 9 },
  { key: 'perm_reports_view', label: 'View and print reports', description: 'Open, preview, and print reports.', accent: 10 },
  { key: 'perm_audit_view', label: 'View audit trails only', description: 'View audit log entries (does not include test/validation reports list).', accent: 11 },
  { key: 'perm_export_usb', label: 'Export reports and audit (USB)', description: 'Export to USB (requires report or audit access for the data being exported).', accent: 12 },
  { key: 'perm_export_approve', label: 'Export approval', description: 'Verify another user’s USB export (secondary approval).', accent: 13 },
];

/** Legacy fine-grained keys (v1); still honored if present in allow until re-saved. */
var LEGACY_INTERNAL_KEYS = [
  'quick-test',
  'recipe-list',
  'recipe-manage',
  'recipe-edit',
  'recipe-delete',
  'reports-view',
  'reports-delete',
  'validate-menu',
  'settings',
  'edit-datetime',
  'profile',
  'user-manage',
  'user-add',
  'user-delete',
  'user-unlock',
  'user-enable',
  'user-change-role',
  'disable-recipes',
  'recipe-enable',
];

var INTERNAL_PERMISSION_IMPLICATIONS = {
  'recipe-manage': ['recipe-list', 'recipe-edit', 'recipe-delete', 'disable-recipes', 'recipe-enable']
};

var ALL_STORABLE_ALLOW_KEYS = PERMISSION_CARD_KEYS.concat(LEGACY_INTERNAL_KEYS);

var SCREEN_FEATURE_MAP = {
  login: 'login',
  home: 'dashboard',
  'quick-test': 'quick-test',
  'test-run': 'recipe-test',
  'manage-recipes': 'recipe-manage',
  'create-recipe-step1': 'recipe-manage',
  reports: 'reports-view',
  'report-preview': 'reports-view',
  'view-recipes': 'recipe-list',
  'recipe-print-preview': 'reports-view',
  validate: 'validation-test',
  'validate-beaker': 'validation-test',
  'calibrate-beaker': 'calibration-menu',
  'approval-verify': 'dashboard',
  'validate-type-select': 'validation-test',
  'stroke-validation': 'validation-test',
  'temp-validation': 'validation-test',
  'load-validation': 'validation-test',
  'distance-validation': 'validation-test',
  'validation-run': 'validation-test',
  'calibration-type-select': 'calibration-menu',
  'load-calibration': 'calibration-menu',
  'distance-zero-calibration': 'calibration-menu',
  settings: 'settings',
  'add-beakers': 'add-beakers',
  'add-baskets': 'add-baskets',
  'heater-control': 'heater-control',
  'factory-settings': 'factory-settings',
  datetime: 'edit-datetime',
  'ip-configure': 'ip-configure',
  'user-profile': 'profile',
  'manage-members': 'user-manage',
  'add-member': 'user-add',
  'locked-members': 'user-manage',
  'disabled-members': 'user-manage',
  'disable-recipes': 'disable-recipes',
  export: 'export-usb',
  'member-biometric': 'profile',
  'password-expired-reset': 'profile',
};

var ACTION_FEATURE_MAP = {
  'add-member': 'user-add',
  'edit-member': 'user-manage',
  'delete-member': 'user-delete',
  'unlock-member': 'user-unlock',
  'enable-member': 'user-enable',
  'change-role': 'user-change-role',
  'save-factory-settings': 'factory-settings',
  'save-recipe': 'recipe-manage',
  'delete-recipe': 'disable-recipes',
  'edit-recipe': 'recipe-manage',
  'start-validation': 'validation-test',
  'start-calibration': 'calibration-menu',
  'delete-report': 'reports-delete',
  'save-profile': 'profile',
};

/** Deprecated catalog for non–add-member callers; prefer PERMISSION_CARD_CATALOG + expand. */
var FEATURE_CATALOG = PERMISSION_CARD_CATALOG.map(function (c) {
  return { key: c.key, label: c.label, description: c.description, group: 'Permissions' };
});

var currentUser = null;

function getCurrentRole() {
  var role = null;
  if (window.currentUser && window.currentUser.role) role = window.currentUser.role;
  else if (currentUser && currentUser.role) role = currentUser.role;
  return role ? String(role).toLowerCase() : null;
}

function getPermissionCardCatalog() {
  return PERMISSION_CARD_CATALOG.slice();
}

function getFeatureCatalog() {
  return getPermissionCardCatalog().map(function (c) {
    return { key: c.key, label: c.label, description: c.description, group: 'Permissions' };
  });
}

function getKnownFeatureKeys() {
  return ALL_STORABLE_ALLOW_KEYS.slice();
}

function getRestriction(role, featureKey) {
  if (!role || !featureKey) return null;
  var roleRules = ROLE_RESTRICTIONS[String(role).toLowerCase()] || {};
  return roleRules[featureKey] || null;
}

function isProtectedFactoryUser(user) {
  if (!user) return false;
  var username = (user.username || user.user || '').toString().toUpperCase();
  return username === 'RLERLT';
}

function isFactoryLikeRole(role, userObj) {
  var r = String(role || '').toLowerCase();
  if (r === 'factory') return true;
  return !!(userObj && isProtectedFactoryUser(userObj));
}

function normalizeFeatureOverrides(overrides) {
  var out = { allow: [], deny: [] };
  if (!overrides || typeof overrides !== 'object') return out;
  if (Array.isArray(overrides.allow)) {
    overrides.allow.forEach(function (k) {
      var key = String(k || '').trim();
      if (key && ALL_STORABLE_ALLOW_KEYS.indexOf(key) !== -1 && out.allow.indexOf(key) === -1) out.allow.push(key);
    });
  }
  if (Array.isArray(overrides.deny)) {
    overrides.deny.forEach(function (k) {
      var key = String(k || '').trim();
      if (key && ALL_STORABLE_ALLOW_KEYS.indexOf(key) !== -1 && out.deny.indexOf(key) === -1) out.deny.push(key);
    });
  }
  out.allow = out.allow.filter(function (k) {
    return out.deny.indexOf(k) === -1;
  });
  return out;
}

function expandAllowListToInternalKeys(allowList) {
  var internal = [];
  (allowList || []).forEach(function (k) {
    var key = String(k || '').trim();
    if (!key) return;
    var exp = PERM_CARD_EXPAND[key];
    if (exp) {
      exp.forEach(function (ik) {
        if (internal.indexOf(ik) === -1) internal.push(ik);
      });
      return;
    }
    if (LEGACY_INTERNAL_KEYS.indexOf(key) !== -1 && internal.indexOf(key) === -1) internal.push(key);
    var implied = INTERNAL_PERMISSION_IMPLICATIONS[key] || [];
    implied.forEach(function (ik) {
      if (internal.indexOf(ik) === -1) internal.push(ik);
    });
  });
  return internal;
}

function getExpandedInternalKeysForUser(userObj) {
  if (!userObj || typeof userObj !== 'object') return [];
  var o = normalizeFeatureOverrides(userObj.featureOverrides);
  return expandAllowListToInternalKeys(o.allow);
}

function userHasInternalKey(userObj, internalKey) {
  if (!internalKey) return false;
  var u = _getUserObjectFromInput(userObj);
  if (!u) return false;
  if (isFactoryLikeRole(_getRoleFromInput(u), u)) return true;
  var expanded = getExpandedInternalKeysForUser(u);
  if (expanded.indexOf(internalKey) !== -1) return true;
  return expanded.some(function (k) {
    return (INTERNAL_PERMISSION_IMPLICATIONS[k] || []).indexOf(internalKey) !== -1;
  });
}

function _getUserObjectFromInput(roleOrUser) {
  if (roleOrUser && typeof roleOrUser === 'object') return roleOrUser;
  if (window.currentUser && typeof window.currentUser === 'object') return window.currentUser;
  return null;
}

function _getRoleFromInput(roleOrUser) {
  if (roleOrUser && typeof roleOrUser === 'object' && roleOrUser.role) return String(roleOrUser.role).toLowerCase();
  if (roleOrUser && typeof roleOrUser === 'string') return String(roleOrUser).toLowerCase();
  return getCurrentRole();
}

function getEffectiveRestriction(roleOrUser, featureKey) {
  if (!featureKey) return 'no-access';
  var role = _getRoleFromInput(roleOrUser);
  var userObj = _getUserObjectFromInput(roleOrUser);
  if (!role && !userObj) return 'no-access';

  if (featureKey === 'dashboard' || featureKey === 'login') return 'full-access';
  if (featureKey === 'profile') return 'full-access';
  if (featureKey === 'ip-configure') return 'full-access';
  if (featureKey === 'settings') return 'full-access';

  if (featureKey === 'factory-settings' || featureKey === 'factory-reset') {
    return role === 'factory' ? 'full-access' : 'no-access';
  }

  if (isFactoryLikeRole(role, userObj)) {
    return 'full-access';
  }

  var expanded = getExpandedInternalKeysForUser(userObj);
  var hasFeature = expanded.indexOf(featureKey) !== -1 || expanded.some(function (k) {
    return (INTERNAL_PERMISSION_IMPLICATIONS[k] || []).indexOf(featureKey) !== -1;
  });
  if (!hasFeature) return 'no-access';

  // Cards drive access: role may soften to view-only, but must not revoke a card grant.
  var roleCap = getRestriction(role, featureKey);
  if (roleCap === 'view-only') return 'view-only';
  return 'full-access';
}

function canAccess(roleOrUser, featureKey) {
  var restriction = getEffectiveRestriction(roleOrUser, featureKey);
  return restriction !== 'no-access';
}

/** Validate hub: allow if user may run validation and/or calibration. */
function canAccessValidationOrCalibration(roleOrUser) {
  return canAccess(roleOrUser, 'validation-test') || canAccess(roleOrUser, 'calibration-menu');
}

function isViewOnly(roleOrUser, featureKey) {
  return getEffectiveRestriction(roleOrUser, featureKey) === 'view-only';
}

function canPerformAction(roleOrUser, featureKey, action) {
  var restriction = getEffectiveRestriction(roleOrUser, featureKey);
  if (restriction === 'no-access') return false;
  if (restriction === 'view-only') {
    var editActions = ['edit', 'delete', 'create', 'save', 'change', 'calibrate', 'start', 'enable', 'unlock'];
    return editActions.indexOf(String(action || '').toLowerCase()) === -1;
  }
  return true;
}

function checkNavigationAccess(screenId) {
  if (screenId === 'login' || screenId === 'password-expired-reset') return true;
  var userObj = (typeof window !== 'undefined' && window.currentUser) ? window.currentUser : null;
  var role = getCurrentRole();
  if (!role && !userObj) return false;
  if (screenId === 'report-preview') {
    if (typeof userCanOpenReportPreview === 'function') {
      return userCanOpenReportPreview(userObj);
    }
  }
  var featureKey = SCREEN_FEATURE_MAP[screenId] || screenId;
  if (screenId === 'manage-recipes') {
    var mode = (typeof window !== 'undefined' && window.recipeListMode) ? window.recipeListMode : 'manage';
    featureKey = mode === 'load' ? 'recipe-test' : 'recipe-manage';
  }
  if (screenId === 'validate') {
    return canAccessValidationOrCalibration(userObj || role);
  }
  if (screenId === 'test-run' || screenId === 'home') {
    // Dashboard/home always allowed when logged in; test-run needs either test card
    if (screenId === 'home') return true;
    return canAccess(userObj || role, 'quick-test') || canAccess(userObj || role, 'recipe-test');
  }
  return canAccess(userObj || role, featureKey);
}
