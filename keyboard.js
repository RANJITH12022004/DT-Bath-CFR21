/**
 * On-Screen Keyboard Module
 * Handles virtual keyboard for touch input with password support and visual feedback
 */

(function () {
    'use strict';

    // Keyboard state
    var currentInput = null;
    var capsLockActive = false;
    var shiftActive = false;
    var numbersActive = false;

    // Keyboard layout - letter layout (lowercase when caps not active)
    var letterLayout = [
        ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
        ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
        ['Caps', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'back'],
        ['123', 'Space', ',', 'Enter']
    ];

    // Keyboard layout - uppercase version (when caps is active)
    var letterLayoutUpper = [
        ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
        ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
        ['Caps', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', 'back'],
        ['123', 'Space', ',', 'Enter']
    ];

    // Keyboard layout - number layout
    var numberLayout = [
        ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
        ['!', '@', '#', '$', '%', '^', '&', '*', '(', ')'],
        ['-', '_', '+', '=', '{', '}', '[', ']', ':', 'back'],
        ['ABC', 'Space', ',', '.', '/', 'Enter']
    ];

    // Initialize keyboard
    function init() {
        var keyboardRoot = document.getElementById('keyboard-root');
        if (!keyboardRoot) {
            console.error('[OSK] keyboard-root element not found');
            return;
        }

        // Create keyboard structure
        keyboardRoot.innerHTML = `
      <!-- Input Preview Popup -->
      <div id="osk-popup" class="osk-popup" style="display: none;">
        <div class="osk-popup-content">
          <div class="osk-popup-label" id="osk-popup-label">Enter input</div>
          <div class="osk-popup-value" id="osk-popup-value"></div>
        </div>
      </div>
      
      <!-- Keyboard Container -->
      <div id="osk" class="keyboard" aria-hidden="true">
        <div class="flex flex-col p-3 gap-2" id="osk-rows"></div>
      </div>
    `;

        buildKeyboard();
    }

    // Build keyboard layout
    function buildKeyboard() {
        var container = document.getElementById('osk-rows');
        if (!container) return;

        // Select layout based on state
        var layout;
        if (numbersActive) {
            layout = numberLayout;
        } else {
            // Use uppercase layout when caps is active, lowercase otherwise
            layout = (capsLockActive || shiftActive) ? letterLayoutUpper : letterLayout;
        }

        container.innerHTML = '';

        layout.forEach(function (row) {
            var rowDiv = document.createElement('div');
            rowDiv.className = 'osk-row';

            row.forEach(function (key) {
                var keyBtn = document.createElement('button');
                keyBtn.className = 'osk-key';
                keyBtn.setAttribute('tabindex', '-1');
                keyBtn.setAttribute('type', 'button');

                // Map display keys to internal key names
                var internalKey = key;
                if (key === 'Caps') {
                    internalKey = 'shift';
                } else if (key === 'Numbers') {
                    internalKey = '123';
                } else if (key === 'ABC') {
                    internalKey = 'abc';
                } else if (key === 'Enter') {
                    internalKey = 'enter';
                } else if (key === 'Space') {
                    internalKey = 'space';
                }

                keyBtn.setAttribute('data-key', internalKey);

                // Add special classes and styling
                if (internalKey === 'space') {
                    keyBtn.classList.add('space');
                    keyBtn.textContent = 'Space';
                } else if (internalKey === 'back') {
                    keyBtn.classList.add('back', 'wide');
                    keyBtn.textContent = '←';
                } else if (internalKey === 'enter') {
                    keyBtn.classList.add('enter', 'wide');
                    keyBtn.textContent = '↵';
                } else if (internalKey === 'shift') {
                    keyBtn.classList.add('shift', 'wide');
                    if (capsLockActive) keyBtn.classList.add('active');
                    keyBtn.textContent = 'Caps';
                } else if (internalKey === '123') {
                    keyBtn.classList.add('numbers', 'wide');
                    if (numbersActive) keyBtn.classList.add('active');
                    keyBtn.textContent = '123';
                } else if (internalKey === 'abc') {
                    keyBtn.classList.add('numbers', 'wide');
                    if (!numbersActive) keyBtn.classList.add('active');
                    keyBtn.textContent = 'ABC';
                } else {
                    keyBtn.textContent = key;
                }

                keyBtn.addEventListener('mousedown', function (e) {
                    e.preventDefault();
                });
                keyBtn.addEventListener('click', function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    handleKeyPress(internalKey);
                });

                rowDiv.appendChild(keyBtn);
            });

            container.appendChild(rowDiv);
        });
    }

    // Handle key press
    function handleKeyPress(key) {
        if (!currentInput) return;

        var isPasswordField = currentInput.type === 'password';

        if (key === 'back') {
            // Backspace
            var val = currentInput.value;
            currentInput.value = val.substring(0, val.length - 1);
            updatePopup();
        } else if (key === 'enter') {
            // Enter - close keyboard
            closeOSK();
        } else if (key === 'space') {
            // Space
            currentInput.value += ' ';
            updatePopup();
        } else if (key === 'shift') {
            // Toggle caps lock
            capsLockActive = !capsLockActive;
            shiftActive = capsLockActive;
            buildKeyboard();
        } else if (key === '123') {
            // Switch to numbers
            numbersActive = true;
            buildKeyboard();
        } else if (key === 'abc') {
            // Switch to letters
            numbersActive = false;
            buildKeyboard();
        } else {
            // Regular key
            if (_inputWantsDecimalKeyboard(currentInput) || String(currentInput.type || '').toLowerCase() === 'number') {
                var allowDecimal = _inputWantsDecimalKeyboard(currentInput);
                if (key === '.' || key === ',') {
                    if (!allowDecimal || currentInput.value.indexOf('.') >= 0) return;
                    key = '.';
                } else if (!/^\d$/.test(key)) {
                    return;
                }
            }
            currentInput.value += key;
            updatePopup();

            // Auto-disable shift after typing (but not caps lock)
            if (shiftActive && !capsLockActive) {
                shiftActive = false;
                buildKeyboard();
            }
        }

        // Trigger input event for any listeners
        var event = new Event('input', { bubbles: true });
        currentInput.dispatchEvent(event);
    }

    function _normalizeOskPromptText(raw) {
        var text = String(raw || '').replace(/\s+/g, ' ').trim();
        if (!text) return 'Enter input';
        if (/^enter\b/i.test(text)) return text;
        return 'Enter ' + text;
    }

    function _deriveOskPrompt(inputEl) {
        if (!inputEl) return 'Enter input';
        var override = inputEl.getAttribute('data-osk-prompt');
        if (override && override.trim()) return _normalizeOskPromptText(override);

        var id = inputEl.id ? String(inputEl.id) : '';
        if (id) {
            var explicitLabel = document.querySelector('label[for="' + id + '"]');
            if (explicitLabel && explicitLabel.textContent) {
                return _normalizeOskPromptText(explicitLabel.textContent);
            }
        }

        var group = inputEl.closest('.form-group');
        if (group) {
            var nearbyLabel = group.querySelector('label');
            if (nearbyLabel && nearbyLabel.textContent) {
                return _normalizeOskPromptText(nearbyLabel.textContent);
            }
        }

        var placeholder = inputEl.getAttribute('placeholder');
        if (placeholder && placeholder.trim()) return _normalizeOskPromptText(placeholder);

        var ariaLabel = inputEl.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return _normalizeOskPromptText(ariaLabel);

        var name = inputEl.getAttribute('name');
        if (name && name.trim()) return _normalizeOskPromptText(name.replace(/[_-]+/g, ' '));

        if (id) return _normalizeOskPromptText(id.replace(/[_-]+/g, ' '));
        return 'Enter input';
    }

    // Update popup display
    function updatePopup() {
        if (!currentInput) return;

        var popup = document.getElementById('osk-popup');
        var valueEl = document.getElementById('osk-popup-value');
        var labelEl = document.getElementById('osk-popup-label');

        if (!popup || !valueEl || !labelEl) return;

        var isPasswordField = currentInput.type === 'password';
        var displayValue = currentInput.value;

        // Show asterisks for password fields
        if (isPasswordField && displayValue) {
            displayValue = '*'.repeat(displayValue.length);
        }

        // Update label
        labelEl.textContent = _deriveOskPrompt(currentInput);

        // Update value display
        valueEl.textContent = displayValue || '';
    }

    function _inputWantsDecimalKeyboard(inputElement) {
        if (!inputElement) return false;
        if (inputElement.getAttribute('data-decimal-input') === 'true') return true;
        if (String(inputElement.getAttribute('inputmode') || '').toLowerCase() === 'decimal') return true;
        return inputElement.classList.contains('decimal-input');
    }

    // Open keyboard for input
    function openOSKForInput(inputElement) {
        if (!inputElement) return;

        currentInput = inputElement;

        if (_inputWantsDecimalKeyboard(inputElement) || String(inputElement.type || '').toLowerCase() === 'number') {
            numbersActive = true;
            capsLockActive = false;
            shiftActive = false;
            buildKeyboard();
        }

        // Show keyboard
        var osk = document.getElementById('osk');
        var popup = document.getElementById('osk-popup');

        if (osk) {
            osk.classList.add('visible');
            osk.setAttribute('aria-hidden', 'false');
        }

        // Show popup overlay
        if (popup) {
            popup.style.display = 'flex';
            updatePopup();

            // Add click handler to close keyboard when clicking outside popup content
            if (!popup._oskPopupClickHandler) {
                popup._oskPopupClickHandler = function (e) {
                    var popupContent = popup.querySelector('.osk-popup-content');
                    if (e.target === popup || (popupContent && !popupContent.contains(e.target))) {
                        closeOSK();
                    }
                };
                popup.addEventListener('click', popup._oskPopupClickHandler);
            }
        }

        // Add body class to prevent scrolling
        document.body.classList.add('keyboard-open');

        // Focus the input and support physical keyboard
        if (currentInput) {
            currentInput.focus();

            // Remove any existing listeners to avoid duplicates
            if (currentInput._oskInputListener) {
                currentInput.removeEventListener('input', currentInput._oskInputListener);
                currentInput._oskInputListener = null;
            }
            if (currentInput._oskKeydownListener) {
                currentInput.removeEventListener('keydown', currentInput._oskKeydownListener);
                currentInput._oskKeydownListener = null;
            }

            // Sync popup when input value changes (from physical keyboard or OSK)
            currentInput._oskInputListener = function () {
                updatePopup();
            };
            currentInput.addEventListener('input', currentInput._oskInputListener);

            // Handle Enter from physical keyboard (close OSK only; do not prevent other keys)
            currentInput._oskKeydownListener = function (e) {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    closeOSK();
                }
            };
            currentInput.addEventListener('keydown', currentInput._oskKeydownListener);
        }
    }

    // Close keyboard
    function closeOSK() {
        var osk = document.getElementById('osk');
        var popup = document.getElementById('osk-popup');

        if (osk) {
            osk.classList.remove('visible');
            osk.setAttribute('aria-hidden', 'true');
        }

        if (popup) {
            popup.style.display = 'none';
            if (popup._oskPopupClickHandler) {
                popup.removeEventListener('click', popup._oskPopupClickHandler);
                popup._oskPopupClickHandler = null;
            }
        }

        document.body.classList.remove('keyboard-open');

        if (currentInput) {
            if (currentInput._oskInputListener) {
                currentInput.removeEventListener('input', currentInput._oskInputListener);
                currentInput._oskInputListener = null;
            }
            if (currentInput._oskKeydownListener) {
                currentInput.removeEventListener('keydown', currentInput._oskKeydownListener);
                currentInput._oskKeydownListener = null;
            }
            currentInput.blur();
            currentInput = null;
        }

        // Reset keyboard state
        capsLockActive = false;
        shiftActive = false;
        numbersActive = false;
        buildKeyboard();
    }

    // Hide keyboard (alias for closeOSK)
    function hideOSK() {
        closeOSK();
    }

    // Initialize on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Export functions to global scope
    window.openOSKForInput = openOSKForInput;
    window.closeOSK = closeOSK;
    window.hideOSK = hideOSK;


})();
