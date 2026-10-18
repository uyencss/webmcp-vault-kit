(function () {
  'use strict';

  // 1. Interactive Showcase Tour Switcher
  const tabButtons = document.querySelectorAll('[data-tour-target]');
  const tourPanels = document.querySelectorAll('[data-tour-panel]');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-tour-target');
      tabButtons.forEach((b) => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      tourPanels.forEach((panel) => {
        const match = panel.getAttribute('data-tour-panel') === target;
        panel.classList.toggle('active', match);
      });
    });
  });

  // 2. One-Click Command Copy with Tactile Feedback
  const copyButtons = document.querySelectorAll('[data-copy-text]');
  copyButtons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = btn.getAttribute('data-copy-text');
      if (!text) return;
      const origLabel = btn.getAttribute('data-orig-label') || btn.textContent;
      btn.setAttribute('data-orig-label', origLabel);
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied';
        setTimeout(() => {
          btn.textContent = origLabel;
        }, 1400);
      } catch {
        btn.textContent = 'Error';
        setTimeout(() => {
          btn.textContent = origLabel;
        }, 1400);
      }
    });
  });

  // 3. Bilingual Toggle (VI / EN)
  const langToggleBtn = document.getElementById('langToggleBtn');
  let currentLang = 'vi';

  const applyLanguage = (lang) => {
    currentLang = lang;
    document.documentElement.lang = lang;
    if (langToggleBtn) {
      langToggleBtn.textContent = lang === 'vi' ? 'VI · EN' : 'EN · VI';
    }
    document.querySelectorAll('[data-vi][data-en]').forEach((el) => {
      const val = el.getAttribute(lang === 'vi' ? 'data-vi' : 'data-en');
      if (val !== null) {
        el.textContent = val;
      }
    });
  };

  if (langToggleBtn) {
    langToggleBtn.addEventListener('click', () => {
      applyLanguage(currentLang === 'vi' ? 'en' : 'vi');
    });
  }
})();
