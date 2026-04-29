// chat.js — in-game text chat UI module.
// Exposes window.Game.Chat. Owns its own DOM (message list + input box).
// Does NOT bind global open keys — main.js installs the open binding to coordinate
// with player input / pointer-lock.

(function () {
  'use strict';

  window.Game = window.Game || {};

  const MAX_HISTORY = 6;          // keep up to N visible messages
  const FADE_AFTER_MS = 8000;     // start fade after this long
  const FADE_DURATION_MS = 800;   // CSS opacity transition length
  const MAX_CHARS = 200;

  // Inject chat styles once.
  function injectStyles() {
    if (document.getElementById('game-chat-style')) return;
    const css = `
      .game-chat-root {
        position: fixed;
        left: 18px;
        top: 64px;
        z-index: 50;
        font-family: "Courier New", monospace;
        font-size: 13px;
        letter-spacing: 1px;
        color: #d8b070;
        text-shadow: 1px 1px 0 #000;
        max-width: 56vw;
        pointer-events: none;
      }
      .game-chat-list {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 2px;
        margin-bottom: 4px;
      }
      .game-chat-line {
        background: rgba(0, 0, 0, 0.45);
        padding: 3px 8px;
        border-radius: 2px;
        line-height: 1.35;
        max-width: 100%;
        word-break: break-word;
        opacity: 1;
        transition: opacity ${FADE_DURATION_MS}ms ease-out;
      }
      .game-chat-line.fading { opacity: 0; }
      .game-chat-line .name { color: #ffcc66; }
      .game-chat-line .name.you { color: #ff8030; }
      .game-chat-line.system { color: #66ddcc; font-style: italic; }
      .game-chat-line.system .name { color: #66ddcc; }
      .game-chat-input-wrap {
        display: none;
        background: rgba(0, 0, 0, 0.55);
        padding: 4px 8px;
        border: 1px solid #6a4828;
        max-width: 100%;
        pointer-events: auto;
      }
      .game-chat-input-wrap.open { display: block; }
      .game-chat-input-wrap .prompt {
        color: #ffaa44;
        margin-right: 6px;
      }
      .game-chat-input {
        background: transparent;
        border: none;
        outline: none;
        color: #ffd590;
        font-family: inherit;
        font-size: inherit;
        letter-spacing: inherit;
        width: 50vw;
        max-width: 600px;
        caret-color: #ffaa44;
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.id = 'game-chat-style';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  class Chat {
    constructor() {
      injectStyles();

      this._localName = null;
      this._sendHandler = null;
      this._open = false;
      // Track each line's fade timer so we can clean it up on early removal.
      this._lines = []; // [{ el, fadeTimer, removeTimer }]

      // DOM
      this.root = document.createElement('div');
      this.root.className = 'game-chat-root';

      this.listEl = document.createElement('div');
      this.listEl.className = 'game-chat-list';
      this.root.appendChild(this.listEl);

      this.inputWrap = document.createElement('div');
      this.inputWrap.className = 'game-chat-input-wrap';

      const prompt = document.createElement('span');
      prompt.className = 'prompt';
      prompt.textContent = '>';
      this.inputWrap.appendChild(prompt);

      this.inputEl = document.createElement('input');
      this.inputEl.type = 'text';
      this.inputEl.className = 'game-chat-input';
      this.inputEl.maxLength = MAX_CHARS;
      this.inputEl.autocomplete = 'off';
      this.inputEl.spellcheck = false;
      this.inputWrap.appendChild(this.inputEl);

      this.root.appendChild(this.inputWrap);

      // While the input is focused, swallow key events so they don't reach
      // the player's WASD / weapon-switch handlers.
      const stop = (e) => {
        e.stopPropagation();
      };
      this.inputEl.addEventListener('keydown', (e) => {
        // Always stop propagation while typing so movement keys don't fire.
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          this.close();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          this._submit();
        }
      });
      this.inputEl.addEventListener('keyup', stop);
      this.inputEl.addEventListener('keypress', stop);
    }

    attachTo(parentEl) {
      if (!parentEl || !parentEl.appendChild) return;
      parentEl.appendChild(this.root);
    }

    isOpen() {
      return this._open;
    }

    open() {
      if (this._open) return false;
      this._open = true;
      this.inputWrap.classList.add('open');
      this.inputEl.value = '';
      // Focus on next frame so any preventDefault'ed keystroke from the opener
      // doesn't land in the input.
      try {
        this.inputEl.focus({ preventScroll: true });
      } catch (_) {
        try { this.inputEl.focus(); } catch (__) { /* ignore */ }
      }
      return document.activeElement === this.inputEl;
    }

    close() {
      if (!this._open) return;
      this._open = false;
      this.inputWrap.classList.remove('open');
      this.inputEl.value = '';
      try { this.inputEl.blur(); } catch (_) { /* ignore */ }
    }

    setSendHandler(fn) {
      this._sendHandler = (typeof fn === 'function') ? fn : null;
    }

    setLocalName(name) {
      this._localName = (typeof name === 'string' && name.length > 0) ? name : null;
    }

    push(name, text, opts) {
      if (typeof text !== 'string' || !text) return;
      const isSystem = !!(opts && opts.system);
      const line = document.createElement('div');
      line.className = 'game-chat-line' + (isSystem ? ' system' : '');

      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      let displayName = (typeof name === 'string' && name) ? name : 'PLAYER';
      if (!isSystem && this._localName && displayName === this._localName) {
        nameSpan.classList.add('you');
        displayName = '[YOU] ' + displayName;
      }
      nameSpan.textContent = displayName;
      line.appendChild(nameSpan);

      const sep = document.createTextNode(isSystem ? ' ' : ': ');
      line.appendChild(sep);

      const textSpan = document.createElement('span');
      textSpan.className = 'text';
      textSpan.textContent = text;
      line.appendChild(textSpan);

      this.listEl.appendChild(line);

      const record = { el: line, fadeTimer: 0, removeTimer: 0 };
      record.fadeTimer = setTimeout(() => {
        line.classList.add('fading');
        record.removeTimer = setTimeout(() => {
          if (line.parentNode) line.parentNode.removeChild(line);
          const idx = this._lines.indexOf(record);
          if (idx >= 0) this._lines.splice(idx, 1);
        }, FADE_DURATION_MS);
      }, FADE_AFTER_MS);
      this._lines.push(record);

      // Trim history to MAX_HISTORY (drop oldest immediately)
      while (this._lines.length > MAX_HISTORY) {
        const oldest = this._lines.shift();
        if (oldest) {
          if (oldest.fadeTimer) clearTimeout(oldest.fadeTimer);
          if (oldest.removeTimer) clearTimeout(oldest.removeTimer);
          if (oldest.el && oldest.el.parentNode) {
            oldest.el.parentNode.removeChild(oldest.el);
          }
        }
      }
    }

    _submit() {
      const raw = this.inputEl.value || '';
      const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
      if (cleaned && cleaned.length <= MAX_CHARS && this._sendHandler) {
        try { this._sendHandler(cleaned); } catch (_) { /* ignore */ }
      }
      this.close();
    }
  }

  window.Game.Chat = Chat;
})();
